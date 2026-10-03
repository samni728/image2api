import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { executeImageRequest, removeFileQuietly } from '../services/image-service.js';
import { protectLocalResources } from '../services/local-retention-service.js';
import { makeId, nowSec } from '../utils/ids.js';

function normalizeBool(v: unknown) {
  if (typeof v === 'boolean') return v;
  return ['1','true','yes','on'].includes(String(v ?? '').toLowerCase());
}

function normalizeInt(v: unknown, fallback?: number) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function validateCommon(body: any) {
  if (!body?.prompt || typeof body.prompt !== 'string') throw Object.assign(new Error('prompt is required.'), { statusCode: 400 });
  const n = normalizeInt(body.n, 1) ?? 1;
  if (n !== 1) throw Object.assign(new Error('This Web2API MVP currently supports n=1 only.'), { statusCode: 400 });
  if (body.response_format && body.response_format !== 'b64_json') {
    throw Object.assign(new Error('Only response_format=b64_json is supported for GPT image compatibility.'), { statusCode: 400 });
  }
}

function buildResponse(result: Awaited<ReturnType<typeof executeImageRequest>>) {
  return {
    created: nowSec(),
    data: result.result.assets.map(asset => ({ b64_json: asset.base64, revised_prompt: null })),
    session: {
      session_id: result.session.id,
      conversation_id: result.session.conversation_id,
      conversation_url: result.session.conversation_url,
      expires_at: result.session.expires_at,
      ttl_seconds: result.session.ttl_seconds,
    },
  };
}

export async function imageRoutes(app: FastifyInstance) {
  app.post('/v1/images/generations', async (req: FastifyRequest<{ Body: any }>, reply) => {
    const body = (req.body || {}) as any;
    validateCommon(body);
    const result = await executeImageRequest({
      kind: 'generation',
      prompt: body.prompt,
      sessionId: body.session_id,
      newChat: normalizeBool(body.new_chat),
      ttlSeconds: normalizeInt(body.session_ttl_seconds),
      size: body.size,
      quality: body.quality,
      background: body.background,
      rawRequest: body,
    });
    reply.header('x-image-session-id', result.session.id);
    return buildResponse(result);
  });

  app.post('/v1/images/edits', async (req, reply) => {
    if (!req.isMultipart()) throw Object.assign(new Error('images/edits requires multipart/form-data.'), { statusCode: 415 });
    fs.mkdirSync(config.uploadDir, { recursive: true });
    const fields: Record<string, string> = {};
    const imagePaths: string[] = [];
    const releases: Array<() => void> = [];
    let succeeded = false;
    try {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          if (part.fieldname === 'mask') {
            part.file.resume();
            throw Object.assign(new Error('mask editing is not supported by the ChatGPT Web driver.'), { statusCode: 400 });
          }
          if (!part.fieldname.startsWith('image')) {
            part.file.resume();
            continue;
          }
          const ext = safeImageExt(part.filename || '', part.mimetype);
          const filePath = path.join(config.uploadDir, `${makeId('input')}.${ext}`);
          imagePaths.push(filePath);
          releases.push(protectLocalResources({ paths: [filePath] }));
          await pipeline(part.file, fs.createWriteStream(filePath));
          if (part.file.truncated || fs.statSync(filePath).size > config.maxInputBytes) {
            throw Object.assign(new Error('Input image exceeds MAX_INPUT_IMAGE_BYTES.'), { statusCode: 413 });
          }
        } else {
          fields[part.fieldname] = String(part.value ?? '');
        }
      }
      validateCommon(fields);
      if (!imagePaths.length && !fields.session_id) {
        throw Object.assign(new Error('At least one image is required unless session_id continues an existing image conversation.'), { statusCode: 400 });
      }
      const result = await executeImageRequest({
        kind: 'edit',
        prompt: fields.prompt,
        imagePaths,
        sessionId: fields.session_id,
        newChat: normalizeBool(fields.new_chat),
        ttlSeconds: normalizeInt(fields.session_ttl_seconds),
        size: fields.size,
        quality: fields.quality,
        background: fields.background,
        rawRequest: { ...fields, image_count: imagePaths.length },
      });
      reply.header('x-image-session-id', result.session.id);
      succeeded = true;
      return buildResponse(result);
    } finally {
      if (!succeeded) for (const filePath of imagePaths) removeFileQuietly(filePath);
      for (const release of releases) release();
    }
  });
}

function safeImageExt(filename: string, mime: string) {
  const ext = path.extname(filename).toLowerCase().replace('.', '');
  if (['png','jpg','jpeg','webp','gif'].includes(ext)) return ext === 'jpeg' ? 'jpg' : ext;
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  return 'jpg';
}
