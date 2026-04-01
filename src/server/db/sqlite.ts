import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import path from 'path';
import fs from 'fs';

let db: Database<sqlite3.Database, sqlite3.Statement>;

export async function initDb() {
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  
  const dbPath = path.join(dataDir, 'gcp-datanator.db');
  
  db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  const isProd = process.env.NODE_ENV === 'production';

  if (isProd) {
    // Cloud Storage FUSE does not support WAL mode (which requires mmap).
    // Use DELETE journal mode and FULL synchronous to prevent corruption.
    await db.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 10000;
      PRAGMA auto_vacuum = INCREMENTAL;
      PRAGMA foreign_keys = ON;
    `);
  } else {
    // Local development can safely use WAL mode for better performance
    await db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 10000;
      PRAGMA auto_vacuum = INCREMENTAL;
      PRAGMA foreign_keys = ON;
    `);
  }

  // Create migrations table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS SchemaMigrations (
      version INTEGER PRIMARY KEY,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Check if this is an existing V1 database without migrations table
  const hasSyncRuns = await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='SyncRuns'");
  const hasV1Migration = await db.get("SELECT version FROM SchemaMigrations WHERE version = 1");
  
  if (hasSyncRuns && !hasV1Migration) {
    // Mark V1 as applied for existing databases to prevent re-running
    await db.run("INSERT OR IGNORE INTO SchemaMigrations (version) VALUES (1)");
  }

  // Define database migrations
  const migrations = [
    {
      version: 1,
      up: `
        CREATE TABLE IF NOT EXISTS SyncRuns (
          id TEXT PRIMARY KEY,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          status TEXT,
          totalFilesGenerated INTEGER DEFAULT 0,
          totalItemsParsed INTEGER DEFAULT 0,
          errorSummary TEXT,
          triggerType TEXT
        );

        CREATE TABLE IF NOT EXISTS SourceMetrics (
          id TEXT PRIMARY KEY,
          sourceName TEXT,
          sourceUrl TEXT,
          lastSyncTimestamp DATETIME,
          itemsParsedLastSync INTEGER DEFAULT 0,
          healthStatus TEXT,
          lastErrorMessage TEXT
        );

        CREATE TABLE IF NOT EXISTS AppLogs (
          id TEXT PRIMARY KEY,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          level TEXT,
          message TEXT,
          syncRunId TEXT,
          metadata TEXT
        );

        CREATE TABLE IF NOT EXISTS ParsedItems (
          guid TEXT PRIMARY KEY,
          sourceId TEXT,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS Settings (
          key TEXT PRIMARY KEY,
          value TEXT,
          updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `
    }
    // Example of future migration:
    // {
    //   version: 2,
    //   up: `ALTER TABLE Settings ADD COLUMN description TEXT;`
    // }
  ];

  // Apply pending migrations
  for (const migration of migrations) {
    let isApplied = await db.get("SELECT version FROM SchemaMigrations WHERE version = ?", migration.version);
    if (!isApplied) {
      console.log(`Applying database migration v${migration.version}...`);
      
      // Use IMMEDIATE transaction to acquire write lock immediately and prevent deadlocks during concurrent startups
      await db.exec('BEGIN IMMEDIATE TRANSACTION');
      try {
        // Re-check inside transaction to handle concurrent startups
        isApplied = await db.get("SELECT version FROM SchemaMigrations WHERE version = ?", migration.version);
        if (!isApplied) {
          await db.exec(migration.up);
          await db.run("INSERT INTO SchemaMigrations (version) VALUES (?)", migration.version);
          await db.exec('COMMIT');
          console.log(`Migration v${migration.version} applied successfully.`);
        } else {
          await db.exec('COMMIT');
          console.log(`Migration v${migration.version} was already applied by another instance.`);
        }
      } catch (error) {
        await db.exec('ROLLBACK');
        console.error(`Failed to apply migration v${migration.version}:`, error);
        throw error;
      }
    }
  }

  // Initialize default settings
  const defaultSettings = [
    { key: 'logRetentionDays', value: '0' } // 0 means Forever
  ];

  for (const setting of defaultSettings) {
    await db.run('INSERT OR IGNORE INTO Settings (key, value) VALUES (?, ?)', setting.key, setting.value);
  }
}

export function getDb() {
  if (!db) throw new Error("Database not initialized");
  return db;
}

export async function closeDb() {
  if (db) {
    await db.close();
    console.log("Database connection closed gracefully.");
  }
}
