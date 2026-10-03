import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';
import type { ImageSession, SessionStatus, JobKind, JobStatus } from './types.js';
import { nowSec } from './utils/ids.js';

fs.mkdirSync(path.dirname(config.sqlitePath), { recursive: true });
export const db = new Database(config.sqlitePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  conversation_url TEXT NOT NULL,
  project_id TEXT,
  project_name TEXT,
  status TEXT NOT NULL,
  ttl_seconds INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  metadata_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(status, expires_at);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  kind TEXT NOT NULL,
  prompt TEXT NOT NULL,
  request_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  error_message TEXT,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_jobs_session_id ON jobs(session_id);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  session_id TEXT,
  kind TEXT NOT NULL,
  file_path TEXT,
  mime_type TEXT,
  width INTEGER,
  height INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

export function getSession(id: string): ImageSession | undefined {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as ImageSession | undefined;
}

export function createSession(row: ImageSession) {
  db.prepare(`INSERT INTO sessions
    (id,conversation_id,conversation_url,project_id,project_name,status,ttl_seconds,created_at,updated_at,last_activity_at,expires_at,metadata_json)
    VALUES (@id,@conversation_id,@conversation_url,@project_id,@project_name,@status,@ttl_seconds,@created_at,@updated_at,@last_activity_at,@expires_at,@metadata_json)`)
    .run(row);
  return row;
}

export function touchSession(id: string, ttlSeconds?: number) {
  const existing = getSession(id);
  if (!existing) return undefined;
  const now = nowSec();
  const ttl = ttlSeconds ?? existing.ttl_seconds;
  db.prepare(`UPDATE sessions SET ttl_seconds=?, updated_at=?, last_activity_at=?, expires_at=?, status='active' WHERE id=?`)
    .run(ttl, now, now, now + ttl, id);
  return getSession(id);
}

export function setSessionStatus(id: string, status: SessionStatus) {
  db.prepare('UPDATE sessions SET status=?, updated_at=? WHERE id=?').run(status, nowSec(), id);
}

export function listExpiredSessions(limit = 20): ImageSession[] {
  return db.prepare(`SELECT * FROM sessions WHERE status IN ('active','failed','deleting') AND expires_at <= ? ORDER BY expires_at ASC LIMIT ?`)
    .all(nowSec(), limit) as ImageSession[];
}

export function deleteSessionRecord(id: string, options: { keepLocalHistory?: boolean } = {}) {
  db.transaction(() => {
    if (options.keepLocalHistory) {
      db.prepare('UPDATE jobs SET session_id=NULL WHERE session_id=?').run(id);
      db.prepare('UPDATE assets SET session_id=NULL WHERE session_id=?').run(id);
    }
    db.prepare('DELETE FROM sessions WHERE id=?').run(id);
  })();
}

export function insertJob(row: {id:string; sessionId:string|null; kind:JobKind; prompt:string; requestJson:string; status:JobStatus}) {
  const now = nowSec();
  db.prepare(`INSERT INTO jobs (id,session_id,kind,prompt,request_json,status,created_at,updated_at,error_message)
    VALUES (?,?,?,?,?,?,?,?,NULL)`)
    .run(row.id,row.sessionId,row.kind,row.prompt,row.requestJson,row.status,now,now);
}

export function updateJob(id: string, status: JobStatus, errorMessage: string | null = null) {
  db.prepare('UPDATE jobs SET status=?, updated_at=?, error_message=? WHERE id=?').run(status, nowSec(), errorMessage, id);
}

export function insertAsset(row: {id:string; jobId:string; sessionId:string|null; kind:'input'|'output'; filePath:string; mimeType:string; width?:number; height?:number}) {
  db.prepare(`INSERT INTO assets (id,job_id,session_id,kind,file_path,mime_type,width,height,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(row.id,row.jobId,row.sessionId,row.kind,row.filePath,row.mimeType,row.width ?? null,row.height ?? null,nowSec());
}

export function getSessionAssetPaths(sessionId: string): string[] {
  return (db.prepare('SELECT file_path FROM assets WHERE session_id=? AND file_path IS NOT NULL').all(sessionId) as Array<{file_path:string}>).map(x => x.file_path);
}

export function retrySessionCleanup(id: string, delaySeconds = 300) {
  const now = nowSec();
  db.prepare(`UPDATE sessions SET status='failed', updated_at=?, expires_at=? WHERE id=?`).run(now, now + delaySeconds, id);
}

db.exec(`
CREATE TABLE IF NOT EXISTS orphan_conversations (
  conversation_id TEXT PRIMARY KEY,
  conversation_url TEXT NOT NULL,
  title TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  delete_attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
`);

export function getKnownConversationIds(): Set<string> {
  const rows = db.prepare('SELECT conversation_id FROM sessions').all() as Array<{conversation_id:string}>;
  return new Set(rows.map(x => x.conversation_id));
}

export function upsertOrphanConversation(row: {conversationId:string; conversationUrl:string; title:string}) {
  const now = nowSec();
  db.prepare(`INSERT INTO orphan_conversations
    (conversation_id,conversation_url,title,first_seen_at,last_seen_at,delete_attempts,last_error)
    VALUES (?,?,?,?,?,0,NULL)
    ON CONFLICT(conversation_id) DO UPDATE SET
      conversation_url=excluded.conversation_url,
      title=excluded.title,
      last_seen_at=excluded.last_seen_at`)
    .run(row.conversationId,row.conversationUrl,row.title,now,now);
}

export function listMatureOrphans(minAgeSeconds: number) {
  return db.prepare(`SELECT * FROM orphan_conversations
    WHERE first_seen_at <= ? ORDER BY first_seen_at ASC`)
    .all(nowSec() - minAgeSeconds) as Array<{
      conversation_id:string;
      conversation_url:string;
      title:string|null;
      first_seen_at:number;
      last_seen_at:number;
      delete_attempts:number;
      last_error:string|null;
    }>;
}

export function markOrphanDeleteFailure(conversationId: string, error: string) {
  db.prepare(`UPDATE orphan_conversations
    SET delete_attempts=delete_attempts+1,last_error=?,last_seen_at=?
    WHERE conversation_id=?`)
    .run(error, nowSec(), conversationId);
}

export function deleteOrphanRecord(conversationId: string) {
  db.prepare('DELETE FROM orphan_conversations WHERE conversation_id=?').run(conversationId);
}

export function pruneOrphanRecords(visibleConversationIds: Set<string>, knownConversationIds: Set<string>) {
  const rows = db.prepare('SELECT conversation_id FROM orphan_conversations').all() as Array<{conversation_id:string}>;
  const del = db.prepare('DELETE FROM orphan_conversations WHERE conversation_id=?');
  const tx = db.transaction(() => {
    for (const row of rows) {
      if (!visibleConversationIds.has(row.conversation_id) || knownConversationIds.has(row.conversation_id)) {
        del.run(row.conversation_id);
      }
    }
  });
  tx();
}
