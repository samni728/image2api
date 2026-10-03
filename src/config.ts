import 'dotenv/config';
import path from 'node:path';

const cwd = process.cwd();
const int = (name: string, fallback: number) => {
  const v = Number(process.env[name] ?? fallback);
  return Number.isFinite(v) ? Math.trunc(v) : fallback;
};

export const config = {
  host: process.env.HOST || '127.0.0.1',
  port: int('PORT', 3811),
  apiKey: process.env.API_KEY || '',
  browserSession: process.env.OPENCLI_BROWSER_SESSION || 'web2api-image-worker-1',
  browserIdleSeconds: Math.max(60, int('OPENCLI_BROWSER_IDLE_SECONDS', 1800)),
  windowMode: (process.env.OPENCLI_WINDOW_MODE === 'foreground' ? 'foreground' : 'background') as 'foreground' | 'background',
  projectName: process.env.CHATGPT_PROJECT_NAME || 'Web to API 的 image',
  projectId: process.env.CHATGPT_PROJECT_ID || '',
  projectUrl: process.env.CHATGPT_PROJECT_URL || '',
  defaultTtl: int('SESSION_DEFAULT_TTL_SECONDS', 7200),
  maxTtl: int('SESSION_MAX_TTL_SECONDS', 7200),
  cleanupInterval: int('SESSION_CLEANUP_INTERVAL_SECONDS', 3600),
  localRetentionDays: Math.max(1, int('LOCAL_RETENTION_DAYS', 7)),
  localCleanupInterval: Math.max(300, int('LOCAL_CLEANUP_INTERVAL_SECONDS', 86400)),
  expiredAction: process.env.SESSION_EXPIRED_ACTION || 'delete',
  sqlitePath: path.resolve(cwd, process.env.SQLITE_PATH || './data/web_to_api_image.sqlite3'),
  uploadDir: path.resolve(cwd, process.env.TMP_UPLOAD_DIR || './tmp/uploads'),
  outputDir: path.resolve(cwd, process.env.TMP_OUTPUT_DIR || './tmp/outputs'),
  maxInputBytes: int('MAX_INPUT_IMAGE_BYTES', 20 * 1024 * 1024),
  generationTimeoutMs: int('GENERATION_TIMEOUT_MS', 300000),
};
