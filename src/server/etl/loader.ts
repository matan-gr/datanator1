import fs from 'fs';
import path from 'path';
import type { DataSource } from './extractor.ts';

export async function saveLocally(content: string, source: DataSource, runId: string): Promise<string> {
  // In production, we might use a persistent volume or cloud storage.
  // For this environment, we use a local 'data' directory to simulate a data lake.
  const baseDataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  const dataDir = path.join(baseDataDir, 'feeds');
  
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const fileName = `${source.id}.txt`;
  const filePath = path.join(dataDir, fileName);
  const backupPath = `${filePath}.bak`;
  const tempPath = `${filePath}.tmp`;
  
  try {
    // Corruption protection: Backup existing file before appending
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, backupPath);
    }
    
    // Write to a temporary file first, then rename it
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, tempPath);
      fs.appendFileSync(tempPath, content, 'utf8');
    } else {
      fs.writeFileSync(tempPath, content, 'utf8');
    }
    
    // Atomic rename
    fs.renameSync(tempPath, filePath);
    
    console.debug(`Successfully appended to local file: ${filePath}`);
    
    // Remove backup on success
    if (fs.existsSync(backupPath)) {
      fs.unlinkSync(backupPath);
    }
    
    return filePath;
  } catch (error) {
    console.error(`Failed to save local file ${filePath}:`, error);
    // Restore backup on failure
    if (fs.existsSync(backupPath)) {
      try {
        fs.copyFileSync(backupPath, filePath);
        console.debug(`Restored backup for ${filePath} after failure.`);
      } catch (restoreError) {
        console.error(`CRITICAL: Failed to restore backup for ${filePath}:`, restoreError);
      }
    }
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch (unlinkError) {
        console.error(`Failed to delete temp file ${tempPath}:`, unlinkError);
      }
    }
    throw new Error(`Local save failed for ${source.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
