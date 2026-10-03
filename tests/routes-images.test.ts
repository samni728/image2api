import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web2api-routes-'));
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3');
process.env.TMP_UPLOAD_DIR = path.join(root, 'uploads');
process.env.TMP_OUTPUT_DIR = path.join(root, 'outputs');
const { imageRoutes } = await import('../src/routes/images.js');
const { db } = await import('../src/db.js');
after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('invalid multipart request removes already written uploads', async () => {
  const app = Fastify();
  await app.register(multipart);
  await app.register(imageRoutes);
  const boundary = 'web2api-test';
  const payload = Buffer.from([
    `--${boundary}`,
    'Content-Disposition: form-data; name="image"; filename="ref.png"',
    'Content-Type: image/png', '', 'test-image',
    `--${boundary}--`, '',
  ].join('\r\n'));
  try {
    const response = await app.inject({
      method: 'POST', url: '/v1/images/edits',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload,
    });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(fs.readdirSync(path.join(root, 'uploads')), []);
  } finally { await app.close(); }
});
