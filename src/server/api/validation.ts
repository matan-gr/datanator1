import { z } from 'zod';

export const LoginSchema = z.object({
  password: z.string().min(1, 'Password is required'),
});

export const SyncTriggerSchema = z.object({
  source: z.string().optional(),
});

export const SettingUpdateSchema = z.object({
  key: z.string().min(1, 'Key is required'),
  value: z.string().min(1, 'Value is required'),
});

export const FileUploadSchema = z.object({
  filename: z.string().min(1, 'Filename is required').regex(/^[a-zA-Z0-9._-]+$/, 'Invalid filename format'),
  content: z.string().min(1, 'Content is required'),
});

export const GeminiBriefSchema = z.object({
  runId: z.string().uuid('Invalid run ID'),
});

export const GCSExportSchema = z.object({
  projectId: z.string().min(1, 'Project ID is required'),
  bucketName: z.string().min(1, 'Bucket name is required'),
  authCode: z.string().optional(),
  accessToken: z.string().optional(),
}).refine(data => data.authCode || data.accessToken, {
  message: "Either authCode or accessToken must be provided",
  path: ["authCode"]
});
