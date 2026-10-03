import fs from 'node:fs';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { config } from './config.js';
import { db } from './db.js';
import { healthRoutes } from './routes/health.js';
import { imageRoutes } from './routes/images.js';
import { sessionRoutes } from './routes/sessions.js';
import { startCleanupLoop, stopCleanupLoop } from './services/cleanup-service.js';
import { startLocalRetentionLoop, stopLocalRetentionLoop } from './services/local-retention-service.js';
import { chatgptDriver } from './driver/chatgpt-driver.js';

fs.mkdirSync(config.uploadDir, { recursive: true });
fs.mkdirSync(config.outputDir, { recursive: true });

const app = Fastify({ logger: true, bodyLimit: 30 * 1024 * 1024 });
await app.register(multipart, {
  limits: {
    files: 8,
    fileSize: config.maxInputBytes,
    fields: 40,
  },
});

app.addHook('onRequest', async (req, reply) => {
  if (req.url === '/healthz' || req.url === '/readyz') return;
  if (!config.apiKey) return;
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${config.apiKey}`) {
    return reply.code(401).send({ error: { message: 'Invalid API key.', type: 'authentication_error' } });
  }
});

app.setErrorHandler((error: any, _req, reply) => {
  const code = Number(error?.statusCode) || 500;
  if (code >= 500) app.log.error(error);
  reply.code(code).send({
    error: {
      message: error?.message || 'Internal server error',
      type: code >= 500 ? 'server_error' : 'invalid_request_error',
    },
  });
});

await app.register(healthRoutes);
await app.register(imageRoutes);
await app.register(sessionRoutes);

app.get('/v1/models', async () => ({
  object: 'list',
  data: [{ id: 'gpt-image-2', object: 'model', owned_by: 'chatgpt-web' }],
}));

app.addHook('onClose', async () => {
  stopLocalRetentionLoop();
  await stopCleanupLoop();
  await chatgptDriver.close();
  db.close();
});

await app.listen({ host: config.host, port: config.port });
startCleanupLoop(config.cleanupInterval);
startLocalRetentionLoop();
app.log.info({ host: config.host, port: config.port, projectId: config.projectId }, 'Web to API image service started');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'Graceful shutdown requested');
    void app.close().catch(error => { app.log.error(error); process.exitCode = 1; });
  });
}
