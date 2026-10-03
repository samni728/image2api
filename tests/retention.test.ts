import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test, mock } from 'node:test';

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'image-retention-test-'));
process.env.SQLITE_PATH = path.join(root, 'test.sqlite');
process.env.TMP_UPLOAD_DIR = path.join(root, 'uploads');
process.env.TMP_OUTPUT_DIR = path.join(root, 'outputs');
process.env.LOCAL_RETENTION_DAYS = '7';
const { db, deleteSessionRecord } = await import('../src/db.js');
const { cleanupLocalHistory, protectLocalResources, startLocalRetentionLoop, stopLocalRetentionLoop } = await import('../src/services/local-retention-service.js');
const now = Math.floor(Date.now() / 1000);
const cutoff = now - 7 * 86400;
const uploads = process.env.TMP_UPLOAD_DIR;
const outputs = process.env.TMP_OUTPUT_DIR;

beforeEach(() => {
  mock.restoreAll();
  db.exec('DELETE FROM assets; DELETE FROM jobs; DELETE FROM sessions');
  for (const dir of [uploads, outputs]) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }
});
after(() => { stopLocalRetentionLoop(); mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
function file(name: string, age = cutoff - 1, dir = outputs) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, 'image');
  fs.utimesSync(p, age, age);
  return p;
}
function job(id: string, age = cutoff - 1, status = 'failed', sessionId: string | null = null) {
  db.prepare("INSERT INTO jobs VALUES (?, ?, 'generate', 'test', '{}', ?, ?, ?, NULL)").run(id, sessionId, status, age, age);
}
function asset(id: string, jobId: string, p: string, age = cutoff - 1, sessionId: string | null = null) {
  db.prepare("INSERT INTO assets VALUES (?, ?, ?, 'output', ?, 'image/png', NULL, NULL, ?)").run(id, jobId, sessionId, p, age);
}
function session(id: string) {
  db.prepare("INSERT INTO sessions VALUES (?, 'remote', 'url', NULL, NULL, 'failed', 7200, ?, ?, ?, ?, NULL)").run(id, cutoff - 1, cutoff - 1, cutoff - 1, cutoff - 1);
}
function hasJob(id: string) { return !!db.prepare('SELECT id FROM jobs WHERE id=?').get(id); }

test('strict seven-day boundary and recent jobs/assets stay; old failed history goes', () => {
  job('old'); asset('a', 'old', file('chatgpt_old.png'));
  job('boundary', cutoff); asset('b', 'boundary', file('chatgpt_boundary.png', cutoff), cutoff);
  job('recent', now); asset('c', 'recent', file('chatgpt_recent.png', now), now);
  const result = cleanupLocalHistory({ nowSeconds: now });
  assert.equal(result.deletedJobs, 1); assert.equal(result.deletedAssets, 1); assert.equal(result.deletedFiles, 1);
  assert.equal(hasJob('old'), false); assert.ok(hasJob('boundary')); assert.ok(hasJob('recent'));
});
test('old unregistered uploads, output orphans and crash jobs clean up; copied names stay', () => {
  const orphan = file('chatgpt_orphan.png'); const upload = file('input_crash.jpg', cutoff - 1, uploads);
  const copy = file('saved-copy.png'); const recent = file('input_recent.jpg', now, uploads);
  job('crash', cutoff - 1, 'running');
  cleanupLocalHistory({ nowSeconds: now });
  assert.equal(fs.existsSync(orphan), false); assert.equal(fs.existsSync(upload), false);
  assert.ok(fs.existsSync(copy)); assert.ok(fs.existsSync(recent)); assert.equal(hasJob('crash'), false);
});
test('live protection refcounts and explicit paths protect old jobs and files', () => {
  const p = file('chatgpt_live.png'); job('live'); asset('a', 'live', p);
  const release1 = protectLocalResources({ jobId: 'live', paths: [p] });
  const release2 = protectLocalResources({ jobId: 'live', paths: [p] });
  release1(); release1(); cleanupLocalHistory({ nowSeconds: now }); assert.ok(hasJob('live')); assert.ok(fs.existsSync(p));
  release2(); cleanupLocalHistory({ nowSeconds: now, protectedPaths: [p] }); assert.ok(hasJob('live'));
  cleanupLocalHistory({ nowSeconds: now }); assert.equal(hasJob('live'), false);
});
test('outside files, symlink files and symlink directories never delete targets', () => {
  const outside = file('chatgpt_outside.png', cutoff - 1, root);
  const link = path.join(outputs, 'chatgpt_link.png'); fs.symlinkSync(outside, link);
  job('outside'); asset('a', 'outside', outside);
  job('link'); asset('b', 'link', link);
  cleanupLocalHistory({ nowSeconds: now }); assert.ok(fs.existsSync(outside)); assert.ok(fs.lstatSync(link).isSymbolicLink());
  fs.rmSync(outputs, { recursive: true }); fs.symlinkSync(root, outputs);
  cleanupLocalHistory({ nowSeconds: now }); assert.ok(fs.existsSync(outside));
  fs.unlinkSync(outputs);
});
test('unlink failures preserve records and retry later', () => {
  const p = file('chatgpt_retry.png'); job('retry'); asset('a', 'retry', p);
  const original = fs.unlinkSync;
  mock.method(fs, 'unlinkSync', (target: fs.PathLike) => { if (String(target) === p) throw new Error('permission denied'); original(target); });
  const result = cleanupLocalHistory({ nowSeconds: now }); assert.ok(result.failures.length); assert.ok(hasJob('retry')); assert.ok(fs.existsSync(p));
  mock.restoreAll(); cleanupLocalHistory({ nowSeconds: now }); assert.equal(hasJob('retry'), false); assert.equal(fs.existsSync(p), false);
});
test('automatic session deletion detaches history; default still cascades; failed remote sessions remain', () => {
  session('auto'); job('keep', now, 'succeeded', 'auto'); asset('a', 'keep', file('chatgpt_keep.png', now), now, 'auto');
  deleteSessionRecord('auto', { keepLocalHistory: true });
  assert.ok(hasJob('keep')); assert.equal((db.prepare('SELECT session_id FROM jobs WHERE id=?').get('keep') as any).session_id, null);
  assert.equal((db.prepare('SELECT session_id FROM assets WHERE id=?').get('a') as any).session_id, null);
  session('manual'); job('gone', now, 'succeeded', 'manual'); deleteSessionRecord('manual'); assert.equal(hasJob('gone'), false);
  session('remote-failed'); job('expired-local', cutoff - 1, 'failed', 'remote-failed');
  cleanupLocalHistory({ nowSeconds: now }); assert.ok(db.prepare('SELECT id FROM sessions WHERE id=?').get('remote-failed'));
});
test('recent shared assets and late writes protect old history; missing files allow removal', () => {
  const shared = file('chatgpt_shared.png');
  job('old-shared'); asset('s1', 'old-shared', shared);
  job('new-shared', now); asset('s2', 'new-shared', shared, now);
  job('late-write'); const late = file('chatgpt_late.png', now); asset('l', 'late-write', late);
  job('missing'); asset('m', 'missing', path.join(outputs, 'chatgpt_missing.png'));
  job('old-no-file'); job('explicit');
  cleanupLocalHistory({ nowSeconds: now, protectedJobIds: ['explicit'] });
  assert.ok(fs.existsSync(shared)); assert.ok(hasJob('old-shared')); assert.ok(hasJob('new-shared'));
  assert.ok(fs.existsSync(late)); assert.ok(hasJob('late-write')); assert.ok(hasJob('explicit'));
  assert.equal(hasJob('missing'), false); assert.equal(hasJob('old-no-file'), false);
});
test('partial unlink failure keeps the job while later retry tolerates already-deleted assets', () => {
  job('partial'); const p1 = file('chatgpt_partial1.png'); const p2 = file('chatgpt_partial2.png');
  asset('p1', 'partial', p1); asset('p2', 'partial', p2);
  const original = fs.unlinkSync;
  mock.method(fs, 'unlinkSync', (target: fs.PathLike) => { if (String(target) === p2) throw new Error('busy'); original(target); });
  const first = cleanupLocalHistory({ nowSeconds: now });
  assert.equal(first.deletedFiles, 1); assert.ok(hasJob('partial')); assert.equal(first.deletedAssets, 0);
  mock.restoreAll(); const second = cleanupLocalHistory({ nowSeconds: now });
  assert.equal(second.deletedFiles, 1); assert.equal(second.deletedAssets, 2); assert.equal(hasJob('partial'), false);
});
test('directory read/access failures retain registered history for retry', () => {
  job('directory-failure'); const p = file('chatgpt_directory.png'); asset('d', 'directory-failure', p);
  const original = fs.lstatSync;
  mock.method(fs, 'lstatSync', (...args: Parameters<typeof fs.lstatSync>) => {
    if (String(args[0]) === outputs) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    return original(...args);
  });
  const first = cleanupLocalHistory({ nowSeconds: now }); assert.ok(first.failures.length); assert.ok(hasJob('directory-failure')); assert.ok(fs.existsSync(p));
  mock.restoreAll(); cleanupLocalHistory({ nowSeconds: now }); assert.equal(hasJob('directory-failure'), false);
});
test('loop startup performs immediate local cleanup and can be stopped idempotently', () => {
  const p = file('input_startup.png', cutoff - 60, uploads);
  job('startup-crash', cutoff - 60, 'queued');
  startLocalRetentionLoop();
  assert.equal(fs.existsSync(p), false); assert.equal(hasJob('startup-crash'), false);
  stopLocalRetentionLoop(); stopLocalRetentionLoop();
});
