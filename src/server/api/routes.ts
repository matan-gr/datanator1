import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import { Storage } from '@google-cloud/storage';
import { OAuth2Client, GoogleAuth } from 'google-auth-library';
import { GoogleGenAI } from "@google/genai";
import { getDb } from '../db/sqlite.ts';
import { runSync } from '../etl/pipeline.ts';
import { 
  LoginSchema, 
  SyncTriggerSchema, 
  SettingUpdateSchema, 
  GeminiBriefSchema,
  GCSExportSchema
} from './validation.ts';
import { z } from 'zod';

export const apiRouter = Router();

const handleError = (res: any, error: unknown, defaultMessage: string) => {
  console.error(`${defaultMessage}:`, error);
  
  if (error instanceof z.ZodError) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: error.issues.map(e => ({ path: e.path, message: e.message }))
    });
  }

  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorStack = error instanceof Error ? error.stack : undefined;
  res.status(500).json({ 
    success: false, 
    error: errorMessage,
    stack: process.env.NODE_ENV !== 'production' ? errorStack : undefined,
    details: defaultMessage
  });
};

// Validation middleware
const validate = (schema: z.ZodSchema) => (req: any, res: any, next: any) => {
  try {
    req.body = schema.parse(req.body);
    next();
  } catch (error) {
    handleError(res, error, 'Validation Error');
  }
};

// Gemini Content endpoint (to be used by frontend for generation)
apiRouter.get('/gemini/content', async (req, res) => {
  try {
    const dataDir = path.join(process.cwd(), 'data', 'feeds');
    if (!fs.existsSync(dataDir)) {
      return res.json({ success: true, content: "" });
    }
    
    const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.txt'));
    let combinedContent = "";
    
    // Read last 1MB of each file to avoid hitting token limits while getting recent data
    for (const file of files) {
      try {
        const filePath = path.join(dataDir, file);
        const stats = fs.statSync(filePath);
        const readSize = Math.min(stats.size, 1048576); // 1MB
        
        if (readSize > 0) {
          const buffer = Buffer.alloc(readSize);
          const fd = fs.openSync(filePath, 'r');
          fs.readSync(fd, buffer, 0, readSize, stats.size - readSize);
          fs.closeSync(fd);
          combinedContent += `\n\n--- Source: ${file} ---\n${buffer.toString('utf8')}`;
        }
      } catch (fileError) {
        console.warn(`Failed to read file ${file} for Gemini content:`, fileError);
      }
    }

    res.json({ success: true, content: combinedContent.trim() });
  } catch (error) {
    handleError(res, error, 'Failed to fetch Gemini content');
  }
});

// Analytics endpoint
apiRouter.get('/analytics', async (req, res) => {
  try {
    const db = getDb();
    const [runsStats, sourceStats, itemsStats] = await Promise.all([
      db.get(`
        SELECT 
          COUNT(*) as totalRuns,
          SUM(CASE WHEN status = 'SUCCESS' THEN 1 ELSE 0 END) as successfulRuns,
          SUM(totalFilesGenerated) as totalFiles,
          SUM(totalItemsParsed) as totalItems
        FROM SyncRuns
      `),
      db.get('SELECT COUNT(*) as totalSources, SUM(CASE WHEN healthStatus = "HEALTHY" THEN 1 ELSE 0 END) as healthySources FROM SourceMetrics'),
      db.get('SELECT COUNT(*) as uniqueItems FROM ParsedItems')
    ]);

    const successRate = runsStats.totalRuns > 0 
      ? Math.round((runsStats.successfulRuns / runsStats.totalRuns) * 100) 
      : 0;

    res.json({
      success: true,
      data: {
        totalRuns: runsStats.totalRuns || 0,
        successRate,
        totalFiles: runsStats.totalFiles || 0,
        totalItems: runsStats.totalItems || 0,
        uniqueItems: itemsStats.uniqueItems || 0,
        totalSources: sourceStats.totalSources || 0,
        healthySources: sourceStats.healthySources || 0
      }
    });
  } catch (error) {
    handleError(res, error, 'Failed to fetch analytics');
  }
});

// Trigger full monthly sync
apiRouter.post('/sync/monthly', async (req, res) => {
  try {
    const triggerType = req.body?.triggerType || 'MANUAL';
    const force = req.body?.force || false;
    const runId = await runSync(triggerType, undefined, force);
    res.json({ success: true, runId, message: 'Monthly sync triggered successfully' });
  } catch (error) {
    handleError(res, error, 'Monthly sync failed');
  }
});

// Trigger targeted sync for debugging
apiRouter.post('/sync/targeted', async (req, res) => {
  const { sourceId, force } = req.body;
  try {
    if (!sourceId) {
      return res.status(400).json({ success: false, error: 'sourceId is required' });
    }
    const runId = await runSync('MANUAL', sourceId, force);
    res.json({ success: true, runId, message: 'Targeted sync triggered successfully' });
  } catch (error) {
    handleError(res, error, 'Targeted sync failed');
  }
});

// Test connection to a specific source
apiRouter.post('/sync/test', async (req, res) => {
  const { sourceId } = req.body;
  try {
    if (!sourceId) {
      return res.status(400).json({ success: false, error: 'sourceId is required' });
    }
    const { DATA_SOURCES, extractFeed } = await import('../etl/extractor.ts');
    const source = DATA_SOURCES.find(s => s.id === sourceId);
    if (!source) {
      return res.status(404).json({ success: false, error: 'Source not found' });
    }
    
    // Try to extract feed with 1 retry
    const result = await extractFeed(source, 1);
    res.json({ success: true, message: `Successfully connected. Found ${result.items.length} items.` });
  } catch (error) {
    handleError(res, error, 'Connection test failed');
  }
});

// Get SyncRuns history
apiRouter.get('/sync-runs', async (req, res) => {
  try {
    const db = getDb();
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const offset = (page - 1) * limit;

    const countResult = await db.get('SELECT COUNT(*) as total FROM SyncRuns');
    const total = countResult.total;

    const runs = await db.all('SELECT * FROM SyncRuns ORDER BY timestamp DESC LIMIT ? OFFSET ?', limit, offset);
    res.json({ success: true, data: runs, total, page, limit });
  } catch (error) {
    handleError(res, error, 'Failed to fetch sync runs');
  }
});

// Get SourceMetrics
apiRouter.get('/source-metrics', async (req, res) => {
  try {
    const db = getDb();
    const metrics = await db.all('SELECT * FROM SourceMetrics ORDER BY sourceName ASC');
    res.json({ success: true, data: metrics });
  } catch (error) {
    handleError(res, error, 'Failed to fetch source metrics');
  }
});

// Get AppLogs
apiRouter.get('/logs', async (req, res) => {
  try {
    const db = getDb();
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = (page - 1) * limit;
    const level = req.query.level as string;
    const search = req.query.search as string;
    const excludeLevel = req.query.excludeLevel as string;
    const syncRunId = req.query.syncRunId as string;
    
    let query = 'SELECT * FROM AppLogs';
    const params: any[] = [];
    const conditions: string[] = [];
    
    if (syncRunId) {
      conditions.push('syncRunId = ?');
      params.push(syncRunId);
    }
    
    if (level && level !== 'ALL') {
      conditions.push('level = ?');
      params.push(level);
    }
    
    if (excludeLevel) {
      conditions.push('level != ?');
      params.push(excludeLevel);
    }
    
    if (search) {
      conditions.push('message LIKE ?');
      params.push(`%${search}%`);
    }
    
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    
    // Get total count for pagination
    const countQuery = query.replace('SELECT *', 'SELECT COUNT(*) as total');
    const countResult = await db.get(countQuery, ...params);
    const total = countResult.total;
    
    query += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    
    const logs = await db.all(query, ...params);
    res.json({ success: true, data: logs, total, page, limit });
  } catch (error) {
    handleError(res, error, 'Failed to fetch app logs');
  }
});

// Get system status
apiRouter.get('/system/status', async (req, res) => {
  try {
    const db = getDb();
    const dbPath = path.join(process.cwd(), 'data', 'gcp-datanator.db');
    const dbStats = fs.existsSync(dbPath) ? fs.statSync(dbPath) : { size: 0 };
    
    const dataDir = path.join(process.cwd(), 'data', 'feeds');
    let totalFileSize = 0;
    let fileCount = 0;
    if (fs.existsSync(dataDir)) {
      const files = fs.readdirSync(dataDir);
      fileCount = files.length;
      for (const file of files) {
        totalFileSize += fs.statSync(path.join(dataDir, file)).size;
      }
    }

    res.json({
      success: true,
      data: {
        dbSize: dbStats.size,
        fileCount,
        totalFileSize,
        geminiKeySet: !!process.env.GEMINI_API_KEY,
        nodeVersion: process.version,
        platform: process.platform,
        uptime: process.uptime()
      }
    });
  } catch (error) {
    handleError(res, error, 'Failed to fetch system status');
  }
});

// Get system settings
apiRouter.get('/system/settings', async (req, res) => {
  try {
    const db = getDb();
    const settings = await db.all('SELECT * FROM Settings');
    const settingsMap = settings.reduce((acc: any, s: any) => {
      acc[s.key] = s.value;
      return acc;
    }, {});
    res.json({ success: true, data: settingsMap });
  } catch (error) {
    handleError(res, error, 'Failed to fetch settings');
  }
});

// Update system settings
apiRouter.post('/system/settings', validate(SettingUpdateSchema), async (req, res) => {
  const { key, value } = req.body;
  try {
    const db = getDb();
    await db.run('INSERT OR REPLACE INTO Settings (key, value, updatedAt) VALUES (?, ?, CURRENT_TIMESTAMP)', key, String(value));
    res.json({ success: true, message: `Setting ${key} updated successfully` });
  } catch (error) {
    handleError(res, error, 'Failed to update settings');
  }
});

// Purge all data
apiRouter.post('/system/purge', async (req, res) => {
  try {
    const db = getDb();
    await db.exec('BEGIN TRANSACTION');
    try {
      await db.run('DELETE FROM SyncRuns');
      await db.run('DELETE FROM SourceMetrics');
      await db.run('DELETE FROM AppLogs');
      await db.run('DELETE FROM ParsedItems');
      await db.exec('COMMIT');
    } catch (e) {
      await db.exec('ROLLBACK');
      throw e;
    }

    // Delete files
    const dataDir = path.join(process.cwd(), 'data', 'feeds');
    if (fs.existsSync(dataDir)) {
      const files = fs.readdirSync(dataDir);
      for (const file of files) {
        try {
          fs.unlinkSync(path.join(dataDir, file));
        } catch (fileError) {
          console.error(`Failed to delete file ${file} during purge:`, fileError);
        }
      }
    }

    res.json({ success: true, message: 'System purged successfully' });
  } catch (error) {
    handleError(res, error, 'Failed to purge system');
  }
});

// List output files
apiRouter.get('/files', async (req, res) => {
  try {
    const dataDir = path.join(process.cwd(), 'data', 'feeds');
    if (!fs.existsSync(dataDir)) {
      return res.json({ success: true, data: [] });
    }
    const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.txt'));
    const fileStats = files.map(f => {
      const stats = fs.statSync(path.join(dataDir, f));
      return {
        name: f,
        size: stats.size,
        lastModified: stats.mtime
      };
    });
    
    // Sort files by last modified descending
    fileStats.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
    
    res.json({ success: true, data: fileStats });
  } catch (error) {
    handleError(res, error, 'Failed to list files');
  }
});

// Download/View specific file
apiRouter.get('/files/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    if (filename.includes('..') || filename.includes('/')) {
      return res.status(400).json({ success: false, error: 'Invalid filename' });
    }
    const filePath = path.join(process.cwd(), 'data', 'feeds', filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, error: 'File not found' });
    }
    
    if (req.query.download === '1') {
      res.download(filePath);
    } else {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.sendFile(filePath);
    }
  } catch (error) {
    handleError(res, error, 'Failed to download file');
  }
});

// Download all files as ZIP
apiRouter.get('/files-download-all', async (req, res) => {
  try {
    const dataDir = path.join(process.cwd(), 'data', 'feeds');
    if (!fs.existsSync(dataDir)) {
      return res.status(404).json({ success: false, error: 'No files to download' });
    }

    const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.txt'));
    if (files.length === 0) {
      return res.status(404).json({ success: false, error: 'No files to download' });
    }

    const archive = archiver('zip', { zlib: { level: 9 } });
    const zipName = `gcp-datanator-export-${new Date().toISOString().split('T')[0]}.zip`;

    res.attachment(zipName);
    archive.pipe(res);

    for (const file of files) {
      archive.file(path.join(dataDir, file), { name: file });
    }

    await archive.finalize();
  } catch (error) {
    handleError(res, error, 'Failed to generate ZIP');
  }
});

// Export files to GCS
apiRouter.post('/files-export-gcs', validate(GCSExportSchema), async (req, res) => {
  const { projectId, bucketName, authCode, accessToken } = req.body;
  
  try {
    const dataDir = path.join(process.cwd(), 'data', 'feeds');
    if (!fs.existsSync(dataDir)) {
      return res.status(404).json({ success: false, error: 'No files to export' });
    }

    const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.txt'));
    if (files.length === 0) {
      return res.status(404).json({ success: false, error: 'No files to export' });
    }

    let finalToken = accessToken;

    // If authCode is provided, exchange it for a token
    if (authCode && !accessToken) {
      const oauth2Client = new OAuth2Client(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        'postmessage' // Standard for popup-based OAuth
      );
      const { tokens } = await oauth2Client.getToken(authCode);
      finalToken = tokens.access_token;
    }

    if (!finalToken) {
      return res.status(400).json({ success: false, error: 'Failed to obtain access token' });
    }

    const oauth2Client = new OAuth2Client();
    oauth2Client.setCredentials({ access_token: finalToken });

    const storage = new Storage({
      projectId,
      authClient: oauth2Client as any
    });

    const bucket = storage.bucket(bucketName);
    
    // Check if bucket exists
    const [exists] = await bucket.exists();
    if (!exists) {
      return res.status(404).json({ success: false, error: `Bucket ${bucketName} does not exist in project ${projectId}` });
    }

    const uploadPromises = files.map(file => {
      return bucket.upload(path.join(dataDir, file), {
        destination: `gcp-datanator-export/${new Date().toISOString().split('T')[0]}/${file}`,
        resumable: false
      });
    });

    const results = await Promise.allSettled(uploadPromises);
    const failed = results.filter(r => r.status === 'rejected');
    
    if (failed.length > 0) {
      console.error(`GCS Export: ${failed.length} files failed to upload.`, failed);
      if (failed.length === files.length) {
        return res.status(500).json({ success: false, error: 'All file uploads failed. Check server logs.' });
      }
      return res.json({ 
        success: true, 
        message: `Exported ${files.length - failed.length} files, but ${failed.length} failed.` 
      });
    }

    res.json({ 
      success: true, 
      message: `Successfully exported ${files.length} files to gs://${bucketName}/gcp-datanator-export/` 
    });
  } catch (error) {
    handleError(res, error, 'GCS Export failed');
  }
});
