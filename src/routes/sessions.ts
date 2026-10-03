import type { FastifyInstance } from 'fastify';
import { chatgptDriver } from '../driver/chatgpt-driver.js';
import { deleteSessionRecord, getSession, getSessionAssetPaths, setSessionStatus } from '../db.js';
import { isSessionInUse, removeFileQuietly } from '../services/image-service.js';

export async function sessionRoutes(app: FastifyInstance) {
  app.get('/v1/images/sessions/:id', async (req: any, reply) => {
    const row = getSession(req.params.id);
    if (!row) return reply.code(404).send({ error: { message: 'session not found', type: 'invalid_request_error' } });
    return {
      id: row.id,
      object: 'image.session',
      status: row.status,
      conversation_id: row.conversation_id,
      conversation_url: row.conversation_url,
      project_id: row.project_id,
      project_name: row.project_name,
      created_at: row.created_at,
      last_activity_at: row.last_activity_at,
      expires_at: row.expires_at,
      ttl_seconds: row.ttl_seconds,
    };
  });

  app.delete('/v1/images/sessions/:id', async (req: any, reply) => {
    const row = getSession(req.params.id);
    if (!row) return reply.code(404).send({ error: { message: 'session not found', type: 'invalid_request_error' } });
    if (isSessionInUse(row.id) || row.status === 'deleting') {
      return reply.code(409).send({ error: { message: 'session is currently in use or being deleted', type: 'invalid_request_error' } });
    }
    setSessionStatus(row.id, 'deleting');
    const deletedRemote = await chatgptDriver.deleteConversation(row.conversation_url);
    if (!deletedRemote) {
      setSessionStatus(row.id, row.status);
      return reply.code(502).send({ error: { message: 'Could not confirm ChatGPT conversation deletion.', type: 'upstream_error' } });
    }
    for (const p of getSessionAssetPaths(row.id)) removeFileQuietly(p);
    deleteSessionRecord(row.id);
    return { id: row.id, object: 'image.session.deleted', deleted: true };
  });
}
