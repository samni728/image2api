import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import Fastify from 'fastify';

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'web2api-lifecycle-'));
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3');
process.env.TMP_UPLOAD_DIR = path.join(root, 'uploads');
process.env.TMP_OUTPUT_DIR = path.join(root, 'outputs');
fs.mkdirSync(path.join(root, 'uploads'));
fs.mkdirSync(path.join(root, 'outputs'));
const { db, createSession, getSession, insertJob, insertAsset } = await import('../src/db.js');
const { chatgptDriver } = await import('../src/driver/chatgpt-driver.js');
const { executeImageRequest, isSessionInUse } = await import('../src/services/image-service.js');
const { cleanupExpiredSessions, stopCleanupLoop } = await import('../src/services/cleanup-service.js');
const { sessionRoutes } = await import('../src/routes/sessions.js');
const { config } = await import('../src/config.js');
after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

function session(id: string, expires: number) {
  const now = Math.floor(Date.now() / 1000);
  return createSession({ id, conversation_id: id, conversation_url: `https://chatgpt.com/c/${id}`,
    project_id: null, project_name: null, status: 'active', ttl_seconds: 60,
    created_at: now, updated_at: now, last_activity_at: now, expires_at: expires, metadata_json: null });
}

test('automatic remote expiry retains local image history until the retention sweep', async t => {
  db.exec('DELETE FROM sessions; DELETE FROM jobs;');
  const row = session('expiry', 1);
  const file = path.join(root, 'outputs', 'chatgpt_expiry.png');
  fs.writeFileSync(file, 'image');
  insertJob({ id: 'expiry-job', sessionId: row.id, kind: 'generation', prompt: 'test', requestJson: '{}', status: 'succeeded' });
  insertAsset({ id: 'expiry-asset', jobId: 'expiry-job', sessionId: row.id, kind: 'output', filePath: file, mimeType: 'image/png' });
  t.mock.method(chatgptDriver, 'deleteConversation', async () => true);
  t.mock.method(chatgptDriver, 'listProjectConversations', async () => []);
  await cleanupExpiredSessions();
  assert.equal(getSession(row.id), undefined);
  assert.equal((db.prepare('SELECT session_id FROM jobs WHERE id=?').get('expiry-job') as any).session_id, null);
  assert.equal((db.prepare('SELECT session_id FROM assets WHERE id=?').get('expiry-asset') as any).session_id, null);
  assert.equal(fs.existsSync(file), true);
});

test('an image request in flight protects its expiring session from automatic and manual deletion', async t => {
  const row = session('in-flight', Math.floor(Date.now() / 1000) + 60);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(chatgptDriver, 'generate', async () => { await gate; throw new Error('upstream failure'); });
  const deletion = t.mock.method(chatgptDriver, 'deleteConversation', async () => true);
  t.mock.method(chatgptDriver, 'listProjectConversations', async () => []);
  const pending = assert.rejects(executeImageRequest({ kind: 'generation', prompt: 'test', sessionId: row.id }), /upstream failure/);
  assert.equal(isSessionInUse(row.id), true);
  db.prepare('UPDATE sessions SET expires_at=1 WHERE id=?').run(row.id);
  const app = Fastify(); await app.register(sessionRoutes);
  try {
    await cleanupExpiredSessions();
    const response = await app.inject({ method: 'DELETE', url: `/v1/images/sessions/${row.id}` });
    assert.equal(response.statusCode, 409);
    assert.equal(deletion.mock.callCount(), 0);
    assert.equal(getSession(row.id)?.status, 'active');
  } finally { release(); await pending; await app.close(); }
  assert.equal(isSessionInUse(row.id), false);
});

test('shutdown waits for an ongoing remote cleanup before database teardown', async t => {
  db.exec('DELETE FROM sessions; DELETE FROM jobs;');
  session('shutdown', 1);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(chatgptDriver, 'deleteConversation', async () => { await gate; return true; });
  t.mock.method(chatgptDriver, 'listProjectConversations', async () => []);
  const pending = cleanupExpiredSessions();
  let stopped = false;
  const stopping = Promise.resolve(stopCleanupLoop()).then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  try { assert.equal(stopped, false); }
  finally { release(); await pending; await stopping; }
  assert.equal(stopped, true);
});

test('missing project configuration preserves orphan retry history without scanning', async t => {
  db.prepare(`INSERT INTO orphan_conversations
    (conversation_id,conversation_url,title,first_seen_at,last_seen_at,delete_attempts,last_error)
    VALUES ('orphan','https://chatgpt.com/c/orphan','test',1,1,3,'previous failure')`).run();
  const saved = config.projectUrl;
  config.projectUrl = '';
  const scan = t.mock.method(chatgptDriver, 'listProjectConversations', async () => []);
  try {
    await cleanupExpiredSessions();
    assert.equal(scan.mock.callCount(), 0);
    assert.equal((db.prepare('SELECT delete_attempts FROM orphan_conversations WHERE conversation_id=?').get('orphan') as any)?.delete_attempts, 3);
  } finally { config.projectUrl = saved; }
});
