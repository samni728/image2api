import type { FastifyInstance } from 'fastify';
import { chatgptDriver } from '../driver/chatgpt-driver.js';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/healthz', async () => ({ ok: true, service: 'web-to-api-image' }));
  app.get('/readyz', async (_req, reply) => {
    const browser = await chatgptDriver.ping();
    if (!browser.ok) reply.code(503);
    return { ok: browser.ok, browser };
  });
}
