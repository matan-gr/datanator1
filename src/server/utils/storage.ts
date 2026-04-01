import { Storage, StorageOptions } from '@google-cloud/storage';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';

const bucketName = process.env.GCS_BUCKET_NAME;
const projectId = process.env.GCS_PROJECT_ID;
const clientEmail = process.env.GCS_CLIENT_EMAIL;
const privateKey = process.env.GCS_PRIVATE_KEY?.replace(/\\n/g, '\n');

const storageOptions: StorageOptions = {};

if (projectId) {
  storageOptions.projectId = projectId;
}

if (clientEmail && privateKey) {
  storageOptions.credentials = {
    client_email: clientEmail,
    private_key: privateKey,
  };
}

const storage = bucketName ? new Storage(storageOptions) : null;
const bucket = storage && bucketName ? storage.bucket(bucketName) : null;
const localDataDir = path.join(process.cwd(), 'data', 'feeds');

export interface FileStat {
  name: string;
  size: number;
  lastModified: Date;
}

export const storageBackend = bucketName ? 'GCS NATIVE' : 'LOCAL FS';

function ensureLocalDir() {
  if (!fs.existsSync(localDataDir)) {
    fs.mkdirSync(localDataDir, { recursive: true });
  }
}

export async function appendToFile(filename: string, content: string): Promise<string> {
  if (bucket) {
    const file = bucket.file(`feeds/${filename}`);
    let existingContent = '';
    try {
      const [data] = await file.download();
      existingContent = data.toString('utf8');
    } catch (e: any) {
      // 404 means the file doesn't exist yet, which is fine
      if (e.code === 404) {
        if (e.message && e.message.includes('bucket does not exist')) {
          throw new Error(`GCS Bucket ${bucketName} does not exist. Please create it first.`);
        }
      } else if (e.code === 403 || (e.message && e.message.includes('does not have storage.objects.get access'))) {
        const emailUsed = clientEmail || 'Default Compute Service Account';
        throw new Error(`Permission denied to read from GCS Bucket ${bucketName} using account ${emailUsed}. Ensure the service account has 'Storage Object Admin' role. Details: ${e.message}`);
      } else {
        throw e;
      }
    }
    
    try {
      await file.save(existingContent + content, { contentType: 'text/plain' });
    } catch (e: any) {
      if (e.code === 404 && e.message && e.message.includes('bucket does not exist')) {
        throw new Error(`GCS Bucket ${bucketName} does not exist. Please create it first.`);
      } else if (e.code === 403 || (e.message && e.message.includes('does not have storage.objects.create access'))) {
        const emailUsed = clientEmail || 'Default Compute Service Account';
        throw new Error(`Permission denied to write to GCS Bucket ${bucketName} using account ${emailUsed}. Ensure the service account has 'Storage Object Admin' role. Details: ${e.message}`);
      }
      throw e;
    }
    return `gs://${bucketName}/feeds/${filename}`;
  } else {
    ensureLocalDir();
    const filePath = path.join(localDataDir, filename);
    const tempPath = `${filePath}.tmp`;
    
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, tempPath);
      fs.appendFileSync(tempPath, content, 'utf8');
    } else {
      fs.writeFileSync(tempPath, content, 'utf8');
    }
    
    fs.renameSync(tempPath, filePath);
    return filePath;
  }
}

export async function listFiles(): Promise<FileStat[]> {
  if (bucket) {
    try {
      const [files] = await bucket.getFiles({ prefix: 'feeds/' });
      return files
        .filter(f => f.name.endsWith('.txt'))
        .map(f => ({
          name: f.name.replace('feeds/', ''),
          size: parseInt(f.metadata.size as string) || 0,
          lastModified: new Date(f.metadata.updated as string)
        }))
        .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
    } catch (error: any) {
      if (error.code === 404 || (error.message && error.message.includes('does not exist'))) {
        console.warn(`GCS Bucket ${bucketName} does not exist or is inaccessible. Returning empty file list.`);
        return [];
      }
      if (error.code === 403 || (error.message && error.message.includes('does not have storage.objects.list access'))) {
        const emailUsed = clientEmail || 'Default Compute Service Account';
        console.warn(`Permission denied to list files in GCS Bucket ${bucketName} using account ${emailUsed}. Ensure the service account has 'Storage Object Admin' role. Details: ${error.message}`);
        return [];
      }
      throw error;
    }
  } else {
    if (!fs.existsSync(localDataDir)) return [];
    const files = fs.readdirSync(localDataDir).filter(f => f.endsWith('.txt'));
    return files.map(f => {
      const stats = fs.statSync(path.join(localDataDir, f));
      return {
        name: f,
        size: stats.size,
        lastModified: stats.mtime
      };
    }).sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  }
}

export async function getFileContent(filename: string): Promise<string> {
  if (bucket) {
    const file = bucket.file(`feeds/${filename}`);
    const [data] = await file.download();
    return data.toString('utf8');
  } else {
    const filePath = path.join(localDataDir, filename);
    return fs.readFileSync(filePath, 'utf8');
  }
}

export async function getFileStream(filename: string): Promise<Readable> {
  if (bucket) {
    return bucket.file(`feeds/${filename}`).createReadStream();
  } else {
    const filePath = path.join(localDataDir, filename);
    return fs.createReadStream(filePath);
  }
}

export async function deleteAllFilesInDirectory(): Promise<void> {
  if (bucket) {
    try {
      const [files] = await bucket.getFiles({ prefix: 'feeds/' });
      await Promise.all(files.map(f => f.delete()));
    } catch (error: any) {
      if (error.code === 404 || (error.message && error.message.includes('does not exist'))) {
        console.warn(`GCS Bucket ${bucketName} does not exist. Nothing to delete.`);
        return;
      }
      if (error.code === 403 || (error.message && error.message.includes('does not have storage.objects.list access'))) {
        const emailUsed = clientEmail || 'Default Compute Service Account';
        console.warn(`Permission denied to delete files in GCS Bucket ${bucketName} using account ${emailUsed}. Ensure the service account has 'Storage Object Admin' role. Details: ${error.message}`);
        return;
      }
      throw error;
    }
  } else {
    if (fs.existsSync(localDataDir)) {
      const files = fs.readdirSync(localDataDir);
      for (const file of files) {
        fs.unlinkSync(path.join(localDataDir, file));
      }
    }
  }
}

export async function getStorageStats(): Promise<{ fileCount: number; totalFileSize: number }> {
  const files = await listFiles();
  const totalFileSize = files.reduce((acc, f) => acc + f.size, 0);
  return { fileCount: files.length, totalFileSize };
}
