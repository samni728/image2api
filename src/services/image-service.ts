import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { chatgptDriver } from '../driver/chatgpt-driver.js';
import { createSession, getSession, insertAsset, insertJob, touchSession, updateJob } from '../db.js';
import { makeId, nowSec } from '../utils/ids.js';
import type { DriverResult, ImageSession, JobKind } from '../types.js';
import { protectLocalResources } from './local-retention-service.js';

const activeSessions = new Map<string, number>();
export function isSessionInUse(id: string) { return (activeSessions.get(id) ?? 0) > 0; }

export type ImageRequest = {
  kind: JobKind;
  prompt: string;
  imagePaths?: string[];
  sessionId?: string;
  newChat?: boolean;
  ttlSeconds?: number;
  size?: string;
  quality?: string;
  background?: string;
  rawRequest?: unknown;
};

export type ImageServiceResult = {
  session: ImageSession;
  jobId: string;
  result: DriverResult;
  outputAssetIds: string[];
};

export async function executeImageRequest(req: ImageRequest): Promise<ImageServiceResult> {
  const ttl = Math.max(60, Math.min(req.ttlSeconds ?? config.defaultTtl, config.maxTtl));
  let existing = req.sessionId && !req.newChat ? getSession(req.sessionId) : undefined;
  if (req.sessionId && !req.newChat && !existing) throw Object.assign(new Error('Unknown or expired session_id.'), { statusCode: 404 });
  if (existing && (existing.status !== 'active' || existing.expires_at <= nowSec())) {
    throw Object.assign(new Error('session_id has expired.'), { statusCode: 410 });
  }

  const jobId = makeId('imgjob');
  insertJob({
    id: jobId,
    sessionId: existing?.id ?? null,
    kind: req.kind,
    prompt: req.prompt,
    requestJson: JSON.stringify(req.rawRequest ?? {}),
    status: 'running',
  });
  const releaseResources = protectLocalResources({ jobId, paths: req.imagePaths });
  if (existing) activeSessions.set(existing.id, (activeSessions.get(existing.id) ?? 0) + 1);

  try {
    const result = await chatgptDriver.generate({
      prompt: req.prompt,
      imagePaths: req.imagePaths,
      conversationUrl: existing?.conversation_url,
      size: req.size,
      quality: req.quality,
      background: req.background,
    });

    let session: ImageSession;
    if (existing) {
      session = touchSession(existing.id, ttl)!;
    } else {
      const now = nowSec();
      session = createSession({
        id: makeId('imgsess'),
        conversation_id: result.conversationId,
        conversation_url: result.conversationUrl,
        project_id: config.projectId || null,
        project_name: config.projectName || null,
        status: 'active',
        ttl_seconds: ttl,
        created_at: now,
        updated_at: now,
        last_activity_at: now,
        expires_at: now + ttl,
        metadata_json: null,
      });
      // Attach this job to the newly created session after the conversation exists.
      // SQLite keeps the job even if this update is skipped by an older schema.
      try { (await import('../db.js')).db.prepare('UPDATE jobs SET session_id=? WHERE id=?').run(session.id, jobId); } catch {}
    }

    const outputAssetIds: string[] = [];
    for (const p of req.imagePaths ?? []) {
      insertAsset({ id: makeId('asset'), jobId, sessionId: session.id, kind: 'input', filePath: p, mimeType: mimeFromPath(p) });
    }
    for (const asset of result.assets) {
      if (!asset.filePath) continue;
      const id = makeId('asset');
      outputAssetIds.push(id);
      insertAsset({ id, jobId, sessionId: session.id, kind: 'output', filePath: asset.filePath, mimeType: asset.mimeType, width: asset.width, height: asset.height });
    }
    updateJob(jobId, 'succeeded');
    return { session, jobId, result, outputAssetIds };
  } catch (error) {
    updateJob(jobId, 'failed', error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    releaseResources();
    if (existing) {
      const remaining = (activeSessions.get(existing.id) ?? 1) - 1;
      if (remaining > 0) activeSessions.set(existing.id, remaining);
      else activeSessions.delete(existing.id);
    }
  }
}

function mimeFromPath(p: string) {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}

export function removeFileQuietly(p: string) {
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
}
