import { config } from '../config.js';
import { chatgptDriver } from '../driver/chatgpt-driver.js';
import {
  deleteOrphanRecord,
  deleteSessionRecord,
  getKnownConversationIds,
  listExpiredSessions,
  listMatureOrphans,
  markOrphanDeleteFailure,
  pruneOrphanRecords,
  retrySessionCleanup,
  setSessionStatus,
  upsertOrphanConversation,
} from '../db.js';
import { isSessionInUse } from './image-service.js';

let timer: NodeJS.Timeout | undefined;
let cleanupInFlight: Promise<void> | undefined;
async function cleanupTrackedSessions() {
  for (const session of listExpiredSessions(20)) {
    if (isSessionInUse(session.id)) continue;
    setSessionStatus(session.id, 'deleting');
    try {
      const ok = await chatgptDriver.deleteConversation(session.conversation_url);
      if (!ok) throw new Error('Remote ChatGPT conversation deletion did not confirm success.');
      deleteSessionRecord(session.id, { keepLocalHistory: true });
      console.log(`[cleanup] deleted expired session ${session.id} conversation=${session.conversation_id}`);
    } catch (error) {
      retrySessionCleanup(session.id, 300);
      console.error(`[cleanup] failed ${session.id}; retry scheduled in 300s:`, error);
    }
  }
}

async function cleanupOrphanProjectConversations() {
  // Missing configuration is a skipped scan, not evidence that the Project is empty.
  if (!config.projectId || !config.projectUrl) return;
  let conversations: Awaited<ReturnType<typeof chatgptDriver.listProjectConversations>>;
  try {
    conversations = await chatgptDriver.listProjectConversations();
  } catch (error) {
    console.error('[cleanup] Project orphan scan failed:', error);
    return;
  }

  const known = getKnownConversationIds();
  const visible = new Set(conversations.map(x => x.conversationId));

  for (const conversation of conversations) {
    if (known.has(conversation.conversationId)) continue;
    upsertOrphanConversation(conversation);
  }

  pruneOrphanRecords(visible, known);

  for (const orphan of listMatureOrphans(config.defaultTtl)) {
    try {
      const ok = await chatgptDriver.deleteConversation(orphan.conversation_url);
      if (!ok) throw new Error('Remote ChatGPT orphan conversation deletion did not confirm success.');
      deleteOrphanRecord(orphan.conversation_id);
      console.log(`[cleanup] deleted orphan Project conversation ${orphan.conversation_id} title=${orphan.title || ''}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      markOrphanDeleteFailure(orphan.conversation_id, message);
      console.error(`[cleanup] orphan delete failed ${orphan.conversation_id}; will retry on next scan:`, error);
    }
  }
}

export function cleanupExpiredSessions(): Promise<void> {
  if (cleanupInFlight) return cleanupInFlight;
  cleanupInFlight = Promise.resolve().then(async () => {
    await cleanupTrackedSessions();
    await cleanupOrphanProjectConversations();
  }).finally(() => { cleanupInFlight = undefined; });
  return cleanupInFlight;
}

export function startCleanupLoop(intervalSeconds: number) {
  if (timer) clearInterval(timer);
  // Deliberately do not run a remote Project scan on service startup.
  // This avoids repeated ChatGPT Web navigation during frequent restarts.
  // The first cleanup happens after the configured interval, then repeats.
  timer = setInterval(() => {
    void cleanupExpiredSessions().catch(error => console.error('[cleanup] unexpected failure:', error));
  }, Math.max(300, intervalSeconds) * 1000);
  timer.unref();
}

export function stopCleanupLoop(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = undefined;
  return cleanupInFlight ?? Promise.resolve();
}
