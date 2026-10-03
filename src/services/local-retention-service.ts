import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db } from '../db.js';

export type LocalProtection = { jobId?: string; paths?: string[] };
export type LocalCleanupOptions = { nowSeconds?: number; protectedJobIds?: Iterable<string>; protectedPaths?: Iterable<string> };
export type LocalCleanupResult = {
  deletedJobs: number;
  deletedAssets: number;
  deletedFiles: number;
  skippedPaths: number;
  failures: Array<{ path?: string; jobId?: string; error: string }>;
  alreadyRunning: boolean;
};
type Asset = { id: string; job_id: string; file_path: string | null; created_at: number };
type Job = { id: string; created_at: number; updated_at: number };
const liveJobs = new Map<string, number>();
const livePaths = new Map<string, number>();
let running = false;
let timer: NodeJS.Timeout | undefined;

/** Register resources before handing them to the driver; release in finally. */
export function protectLocalResources(resources: LocalProtection): () => void {
  const paths = [...new Set((resources.paths ?? []).map(p => path.resolve(p)))];
  if (resources.jobId) liveJobs.set(resources.jobId, (liveJobs.get(resources.jobId) ?? 0) + 1);
  for (const p of paths) livePaths.set(p, (livePaths.get(p) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const release = (map: Map<string, number>, key: string) => {
      const count = map.get(key) ?? 0;
      if (count <= 1) map.delete(key); else map.set(key, count - 1);
    };
    if (resources.jobId) release(liveJobs, resources.jobId);
    for (const p of paths) release(livePaths, p);
  };
}

/** Only direct, service-named files in the configured local directories belong to us. */
function isManagedPath(p: string): boolean {
  const resolved = path.resolve(p);
  return [config.uploadDir, config.outputDir].some(dir => path.dirname(resolved) === path.resolve(dir))
    && /^(?:input|chatgpt)_[^/\\]+\.[a-zA-Z0-9]+$/.test(path.basename(resolved));
}
function isSafeDirectory(dir: string): boolean {
  // Check every ancestor; never follow an ancestor symlink while deleting.
  let current = path.resolve(dir);
  while (true) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    const parent = path.dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }

/** No browser access. Synchronous operations also prevent cleanup from interleaving with job registration. */
export function cleanupLocalHistory(options: LocalCleanupOptions = {}): LocalCleanupResult {
  const result: LocalCleanupResult = { deletedJobs: 0, deletedAssets: 0, deletedFiles: 0, skippedPaths: 0, failures: [], alreadyRunning: running };
  if (running) return result;
  running = true;
  try {
    const configured = config as typeof config & { localRetentionDays?: number };
    const retentionDays = Math.max(1, configured.localRetentionDays ?? 7);
    const cutoff = (options.nowSeconds ?? Math.floor(Date.now() / 1000)) - retentionDays * 86400;
    const protectedJobs = new Set([...liveJobs.keys(), ...(options.protectedJobIds ?? [])]);
    const protectedPaths = new Set([...livePaths.keys(), ...[...(options.protectedPaths ?? [])].map(p => path.resolve(p))]);
    const assets = db.prepare('SELECT id,job_id,file_path,created_at FROM assets').all() as Asset[];
    const jobs = db.prepare('SELECT id,created_at,updated_at FROM jobs').all() as Job[];
    const byJob = new Map<string, Asset[]>();
    const registeredPaths = new Set<string>();
    for (const asset of assets) {
      const group = byJob.get(asset.job_id) ?? [];
      group.push(asset); byJob.set(asset.job_id, group);
      if (asset.file_path) registeredPaths.add(path.resolve(asset.file_path));
    }
    // A path shared with recent history must not be deleted by an older job.
    for (const job of jobs) {
      const group = byJob.get(job.id) ?? [];
      if (protectedJobs.has(job.id) || Math.max(job.created_at, job.updated_at) >= cutoff || group.some(a => a.created_at >= cutoff)) {
        for (const asset of group) if (asset.file_path) protectedPaths.add(path.resolve(asset.file_path));
      }
    }
    const safeDirs = new Set<string>();
    for (const dir of new Set([config.uploadDir, config.outputDir].map(p => path.resolve(p)))) {
      try {
        if (isSafeDirectory(dir)) safeDirs.add(dir); else result.skippedPaths++;
      } catch (error) {
        if (!isMissing(error)) result.failures.push({ path: dir, error: errorText(error) });
      }
    }
    // Return false only for an actual deletion failure or a protected/recent file.
    const remove = (p: string, jobId?: string): boolean => {
      const resolved = path.resolve(p);
      if (protectedPaths.has(resolved)) return false;
      if (!isManagedPath(resolved)) { result.skippedPaths++; return true; }
      // An inaccessible or linked storage directory cannot confirm deletion.
      if (!safeDirs.has(path.dirname(resolved))) { result.skippedPaths++; return false; }
      try {
        const stat = fs.lstatSync(resolved);
        if (stat.isSymbolicLink() || !stat.isFile()) { result.skippedPaths++; return true; }
        if (stat.mtimeMs / 1000 >= cutoff) return false;
        fs.unlinkSync(resolved); result.deletedFiles++; return true;
      } catch (error) {
        if (isMissing(error)) return true;
        result.failures.push({ path: resolved, jobId, error: errorText(error) }); return false;
      }
    };
    for (const job of jobs) {
      const group = byJob.get(job.id) ?? [];
      if (protectedJobs.has(job.id) || Math.max(job.created_at, job.updated_at) >= cutoff || group.some(a => a.created_at >= cutoff || (a.file_path && protectedPaths.has(path.resolve(a.file_path))))) continue;
      let allRemoved = true;
      for (const p of new Set(group.flatMap(a => a.file_path ? [a.file_path] : []))) {
        if (!remove(p, job.id)) allRemoved = false;
      }
      if (!allRemoved) continue;
      const change = db.prepare('DELETE FROM jobs WHERE id=?').run(job.id);
      result.deletedJobs += change.changes;
      if (change.changes) result.deletedAssets += group.length;
    }
    // Files never inserted into assets (failed requests, process crashes) age by mtime.
    for (const dir of safeDirs) {
      try {
        for (const name of fs.readdirSync(dir)) {
          const p = path.join(dir, name);
          if (!registeredPaths.has(p) && isManagedPath(p)) remove(p);
        }
      } catch (error) { result.failures.push({ path: dir, error: errorText(error) }); }
    }
    if (result.deletedJobs || result.deletedAssets) db.pragma('wal_checkpoint(PASSIVE)');
    return result;
  } finally { running = false; }
}

function runScheduledCleanup() {
  try {
    const result = cleanupLocalHistory();
    if (result.failures.length) console.error('[local-cleanup] deletion failures; retained history for retry:', result.failures);
    if (result.deletedJobs || result.deletedFiles) console.log('[local-cleanup]', result);
  } catch (error) { console.error('[local-cleanup] failed; will retry next interval:', error); }
}
export function startLocalRetentionLoop(intervalSeconds?: number) {
  stopLocalRetentionLoop();
  runScheduledCleanup();
  const configured = config as typeof config & { localCleanupInterval?: number };
  timer = setInterval(runScheduledCleanup, Math.max(1, intervalSeconds ?? configured.localCleanupInterval ?? 86400) * 1000);
  timer.unref();
}
export function stopLocalRetentionLoop() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
