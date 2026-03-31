import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/sqlite.ts';
import { extractFeed, DATA_SOURCES } from './extractor.ts';
import type { DataSource } from './extractor.ts';
import { transformItems, formatDocument } from './transformer.ts';
import { saveLocally } from './loader.ts';
import fs from 'fs';
import path from 'path';

export async function runSync(triggerType: 'SCHEDULED' | 'MANUAL', sourceId?: string, force: boolean = false): Promise<string> {
  const db = getDb();
  
  // Self-heal: Mark any RUNNING jobs older than 30 minutes as FAILED
  await db.run(`
    UPDATE SyncRuns 
    SET status = 'FAILED', errorSummary = 'Killed due to server restart or timeout' 
    WHERE status = 'RUNNING' AND timestamp < datetime('now', '-30 minutes')
  `);
  
  // Check if a sync is already running
  const existingRunning = await db.get("SELECT id FROM SyncRuns WHERE status = 'RUNNING' LIMIT 1");
  if (existingRunning && !force) {
    console.warn(`Sync already running with ID: ${existingRunning.id}. Skipping.`);
    return existingRunning.id;
  }

  const runId = uuidv4();
  
  // Initialize SyncRun
  await db.run(
    'INSERT INTO SyncRuns (id, status, triggerType) VALUES (?, ?, ?)',
    [runId, 'RUNNING', triggerType]
  );
  
  // Start the background process
  const syncProcess = async () => {
    try {
      const sourcesToSync = sourceId 
        ? DATA_SOURCES.filter(s => s.id === sourceId)
        : DATA_SOURCES;
        
      const results = [];
      for (const source of sourcesToSync) {
        try {
          // 1. Extract
          const { items: rawItems, status, statusText, url, duration } = await extractFeed(source);
          
          // Log HTTP response details
          await db.run(
            'INSERT INTO AppLogs (id, level, message, syncRunId, metadata) VALUES (?, ?, ?, ?, ?)',
            [
              uuidv4(), 
              'NETWORK', 
              `Source ${source.name}: HTTP ${status} ${statusText} from ${url}`, 
              runId,
              JSON.stringify({ status, statusText, url, method: 'GET', duration })
            ]
          );

          // 1.5 Deduplicate against previously parsed items
          const incomingGuids = rawItems.map(item => item.guid).filter(Boolean) as string[];
          let existingGuidSet = new Set<string>();
          
          if (incomingGuids.length > 0) {
            // Chunk guids to prevent SQLite 'too many variables' error (limit is usually 999)
            const chunkSize = 900;
            for (let i = 0; i < incomingGuids.length; i += chunkSize) {
              const chunk = incomingGuids.slice(i, i + chunkSize);
              const placeholders = chunk.map(() => '?').join(',');
              const query = `SELECT guid FROM ParsedItems WHERE sourceId = ? AND guid IN (${placeholders})`;
              const existingGuids = await db.all(query, [source.id, ...chunk]);
              existingGuids.forEach(r => existingGuidSet.add(r.guid));
            }
          }
          
          const newRawItems = rawItems.filter(item => item.guid && !existingGuidSet.has(item.guid));
          
          // Log exact deduplication metrics
          const totalFetched = rawItems.length;
          const duplicates = totalFetched - newRawItems.length;
          await db.run(
            'INSERT INTO AppLogs (id, level, message, syncRunId) VALUES (?, ?, ?, ?)',
            [uuidv4(), 'INFO', `Source ${source.name}: Fetched ${totalFetched} items. Skipped ${duplicates} duplicates. Processing ${newRawItems.length} new items.`, runId]
          );
          
          // 2. Transform
          const transformedItems = transformItems(newRawItems, source);
          const itemsCount = transformedItems.length;
          let filesCount = 0;
          
          // 3. Load
          if (itemsCount > 0) {
            // Update DB in a transaction FIRST
            await db.exec('BEGIN TRANSACTION');
            try {
              const stmt = await db.prepare('INSERT OR IGNORE INTO ParsedItems (guid, sourceId) VALUES (?, ?)');
              for (const item of transformedItems) {
                await stmt.run([item.guid, source.id]);
              }
              await stmt.finalize();
              await db.exec('COMMIT');
            } catch (dbError) {
              await db.exec('ROLLBACK');
              throw new Error(`Database update failed: ${dbError instanceof Error ? dbError.message : String(dbError)}`);
            }

            // If DB update succeeds, THEN write to file
            try {
              const documentContent = formatDocument(transformedItems, source, runId);
              await saveLocally(documentContent, source, runId);
              filesCount = 1; // File was successfully created locally
            } catch (fileError) {
              // Note: If file save fails but DB succeeded, the items are marked as parsed in DB.
              // They won't be fetched again. This is a known trade-off to prevent file corruption.
              // A robust system might use a message queue here.
              throw new Error(`File save failed after DB update: ${fileError instanceof Error ? fileError.message : String(fileError)}`);
            }
          } else {
            // Even if 0 items, let's touch the file to show it was checked
            try {
              const documentContent = `\n\n--- Sync Run: ${runId} ---\nNo new items found at ${new Date().toISOString()}\n`;
              await saveLocally(documentContent, source, runId);
              filesCount = 1;
            } catch (fileError) {
              console.error(`Failed to touch file for ${source.name}:`, fileError);
              // Non-fatal, continue
            }
          }
          
          // Update SourceMetrics
          await db.run(`
            INSERT INTO SourceMetrics (id, sourceName, sourceUrl, lastSyncTimestamp, itemsParsedLastSync, healthStatus)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, 'HEALTHY')
            ON CONFLICT(id) DO UPDATE SET
              lastSyncTimestamp = CURRENT_TIMESTAMP,
              itemsParsedLastSync = excluded.itemsParsedLastSync,
              healthStatus = 'HEALTHY',
              lastErrorMessage = NULL
          `, [source.id, source.name, source.url, itemsCount]);
          
          // Log Success
          await db.run(
            'INSERT INTO AppLogs (id, level, message, syncRunId) VALUES (?, ?, ?, ?)',
            [uuidv4(), 'INFO', `Successfully synced ${source.name} (${itemsCount} items)`, runId]
          );
          
          results.push({ success: true, items: itemsCount, files: filesCount });
        } catch (error) {
          console.error(`Error syncing source ${source.name}:`, error);
          
          // Update SourceMetrics for failure
          await db.run(`
            INSERT INTO SourceMetrics (id, sourceName, sourceUrl, lastSyncTimestamp, healthStatus, lastErrorMessage)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP, 'FAILING', ?)
            ON CONFLICT(id) DO UPDATE SET
              lastSyncTimestamp = CURRENT_TIMESTAMP,
              healthStatus = 'FAILING',
              lastErrorMessage = excluded.lastErrorMessage
          `, [source.id, source.name, source.url, String(error)]);
          
          // Log Error
          const errorStack = error instanceof Error ? error.stack : undefined;
          await db.run(
            'INSERT INTO AppLogs (id, level, message, syncRunId, metadata) VALUES (?, ?, ?, ?, ?)',
            [uuidv4(), 'ERROR', `Failed to sync ${source.name}`, runId, JSON.stringify({ error: String(error), stack: errorStack })]
          );
          
          results.push({ success: false, items: 0, files: 0, error: `${source.name}: ${String(error)}` });
        }
      }

      const totalItems = results.reduce((sum, r) => sum + r.items, 0);
      const totalFiles = results.reduce((sum, r) => sum + r.files, 0);
      const errors = results.filter(r => !r.success).map(r => r.error as string);
      
      // Finalize SyncRun
      const finalStatus = errors.length === 0 ? 'SUCCESS' : (errors.length < sourcesToSync.length ? 'PARTIAL_SUCCESS' : 'FAILED');
      const errorSummary = errors.length > 0 ? errors.join(' | ') : null;
      
      await db.run(
        'UPDATE SyncRuns SET status = ?, totalFilesGenerated = ?, totalItemsParsed = ?, errorSummary = ? WHERE id = ?',
        [finalStatus, totalFiles, totalItems, errorSummary, runId]
      );

      // 4. Cleanup old data based on retention policy
      try {
        const retentionSetting = await db.get("SELECT value FROM Settings WHERE key = 'logRetentionDays'");
        const retentionDays = parseInt(retentionSetting?.value || '30');
        
        if (retentionDays > 0) {
          const cleanupDate = new Date();
          cleanupDate.setDate(cleanupDate.getDate() - retentionDays);
          // SQLite format: YYYY-MM-DD HH:MM:SS
          const cleanupDateStr = cleanupDate.toISOString().replace('T', ' ').substring(0, 19);
          
          await db.run("DELETE FROM AppLogs WHERE timestamp < ?", cleanupDateStr);
          await db.run("DELETE FROM SyncRuns WHERE timestamp < ? AND status != 'RUNNING'", cleanupDateStr);
          // We keep SourceMetrics and ParsedItems (for deduplication) longer, 
          // but we could also clean up ParsedItems if they are very old.
          await db.run("DELETE FROM ParsedItems WHERE timestamp < ?", cleanupDateStr);
          
          // Reclaim space and optimize database
          await db.exec('PRAGMA incremental_vacuum');
          await db.exec('PRAGMA optimize');
          
          await db.run(
            'INSERT INTO AppLogs (id, level, message, syncRunId) VALUES (?, ?, ?, ?)',
            [uuidv4(), 'INFO', `Cleanup completed. Removed DB records older than ${retentionDays} days. Vacuumed and optimized DB.`, runId]
          );
          console.log(`Cleanup completed. Removed data older than ${retentionDays} days (${cleanupDateStr}).`);
        }
      } catch (cleanupError) {
        console.error('Failed to perform automatic cleanup:', cleanupError);
      }
    } catch (fatalError) {
      console.error(`Fatal error in background sync process ${runId}:`, fatalError);
      await db.run(
        'UPDATE SyncRuns SET status = ?, errorSummary = ? WHERE id = ?',
        ['FAILED', `Fatal error: ${fatalError instanceof Error ? fatalError.message : String(fatalError)}`, runId]
      );
      await db.run(
        'INSERT INTO AppLogs (id, level, message, syncRunId, metadata) VALUES (?, ?, ?, ?, ?)',
        [uuidv4(), 'ERROR', `Fatal pipeline error`, runId, JSON.stringify({ error: String(fatalError) })]
      );
    }
  };

  // Execute background process
  syncProcess().catch(err => {
    console.error(`Fatal error in background sync process ${runId}:`, err);
  });
  
  return runId;
}
