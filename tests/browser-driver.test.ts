import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatGPTImageDriver } from '../src/driver/chatgpt-driver.js';
import * as scan from '../src/driver/project-scan-helper.js';
import * as deletion from '../src/driver/delete-helper.js';
import { config } from '../src/config.js';

const id = '12345678-1234-1234-1234-123456789abc';
const url = `https://chatgpt.com/c/${id}`;
const tick = () => new Promise(resolve => setImmediate(resolve));

function fakePage(overrides: Record<string, unknown> = {}) {
  return {
    goto: async () => {},
    evaluate: async (js: string) => js.includes('composer:')
      ? { url: 'https://chatgpt.com/g/g-p-test/project', composer: true }
      : [],
    click: async () => {}, nativeType: async () => {}, closeWindow: async () => {},
    ...overrides,
  };
}
function driverWith(page: ReturnType<typeof fakePage>) {
  const driver = new ChatGPTImageDriver(page as any);
  // Guard against accidental network access while testing the new injection boundary.
  assert.equal((driver as any).page, page);
  return driver;
}

test('generate holds the shared page until failure, then queued ping/delete/scan continue', async () => {
  const saved = { projectUrl: config.projectUrl, projectId: config.projectId };
  config.projectUrl = 'https://chatgpt.com/g/g-p-test/project'; config.projectId = 'test';
  const navigations: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const page = fakePage({ goto: async (target: string) => {
    navigations.push(target);
    if (navigations.length === 1) { await gate; throw new Error('generation failed'); }
  }});
  try {
    const driver = driverWith(page);
    const generated = assert.rejects(driver.generate({ prompt: 'test' }), /generation failed/);
    const ping = driver.ping();
    const deleted = driver.deleteConversation(url);
    const scanned = driver.listProjectConversations();
    await tick();
    assert.deepEqual(navigations, [config.projectUrl]);
    release();
    await generated;
    assert.equal((await ping).ok, true);
    assert.equal(await deleted, false);
    assert.deepEqual(await scanned, []);
    assert.deepEqual(navigations, [config.projectUrl, 'https://chatgpt.com', url, config.projectUrl]);
  } finally { Object.assign(config, saved); }
});

test('close waits for pending work and releases only its own page once', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let closed = 0;
  const page = fakePage({ goto: async () => { await gate; }, closeWindow: async () => { closed++; } });
  const driver = driverWith(page);
  const other = driverWith(fakePage({ closeWindow: async () => { throw new Error('other session touched'); } }));
  const ping = driver.ping();
  const closing = driver.close();
  await tick(); assert.equal(closed, 0);
  release(); await ping; await closing; await driver.close();
  assert.equal(closed, 1);
  await assert.rejects(driver.generate({ prompt: 'after close' }), /closed/i);
  assert.equal((await other.ping()).ok, true);
});

test('scan propagates navigation failures and rejects malformed page results', async () => {
  const saved = { projectUrl: config.projectUrl, projectId: config.projectId };
  config.projectUrl = 'https://chatgpt.com/g/g-p-test/project'; config.projectId = 'test';
  try {
    assert.equal(typeof scan.listProjectConversations, 'function');
    await assert.rejects(scan.listProjectConversations(fakePage({ goto: async () => { throw new Error('offline'); } }) as any), /offline/);
    await assert.rejects(scan.listProjectConversations(fakePage({ evaluate: async (js: string) => js.includes('composer:') ? { url: config.projectUrl, composer: true } : null }) as any), /invalid|malformed/i);
    await assert.rejects(scan.listProjectConversations(fakePage({ evaluate: async () => ({ url: 'https://chatgpt.com/auth/login', composer: false }) }) as any), /login|ready|redirect/i);
  } finally { Object.assign(config, saved); }
});

test('delete cannot interpret login redirects or a missing row as successful deletion', async () => {
  assert.equal(typeof deletion.deleteConversation, 'function');
  const login = fakePage({ evaluate: async () => ({ url: 'https://chatgpt.com/auth/login', composer: false }) });
  assert.equal(await deletion.deleteConversation(login as any, url), false);
  const missingRow = fakePage({ evaluate: async (js: string) => js.includes('composer:') ? { url, composer: true } : { ok: false, link: false, row: false } });
  assert.equal(await deletion.deleteConversation(missingRow as any, url), false);
});

test('scan returns project conversation data using the supplied page', async () => {
  const saved = { projectUrl: config.projectUrl, projectId: config.projectId };
  config.projectUrl = 'https://chatgpt.com/g/g-p-test/project'; config.projectId = 'test';
  try {
    const page = fakePage({ evaluate: async (js: string) => js.includes('composer:')
      ? { url: config.projectUrl, composer: true }
      : [{ href: `/g/g-p-test/c/${id}`, title: 'Example image' }] });
    assert.deepEqual(await scan.listProjectConversations(page as any), [{
      conversationId: id, conversationUrl: `https://chatgpt.com/g/g-p-test/c/${id}`, title: 'Example image',
    }]);
  } finally { Object.assign(config, saved); }
});

test('delete waits for a loaded page instead of accepting missing DOM', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const page = fakePage({ evaluate: async () => ({ url, composer: false }) });
  const result = deletion.deleteConversation(page as any, url);
  await tick();
  t.mock.timers.tick(16_000);
  assert.equal(await result, false);
});

test('delete succeeds only after menu, dialog confirmation and a ready page without the row', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clicks: string[] = [];
  let confirmed = false;
  const page = fakePage({
    click: async (selector: string) => { clicks.push(selector); if (selector.includes('confirm')) confirmed = true; },
    evaluate: async (js: string) => {
      if (js.includes('dialogOpen:')) return { url: 'https://chatgpt.com/', composer: true, exists: false, dialogOpen: false };
      if (js.includes('composer:')) return { url: confirmed ? 'https://chatgpt.com/' : url, composer: true };
      if (js.includes('data-w2a-delete-menu')) return { ok: true };
      if (js.includes('data-w2a-delete-item')) return true;
      if (js.includes('data-w2a-delete-confirm')) return true;
      if (js.includes('.some(')) return false;
      throw new Error('Unexpected page operation');
    },
  });
  const result = deletion.deleteConversation(page as any, url);
  await tick(); t.mock.timers.tick(650);
  await tick(); t.mock.timers.tick(650);
  await tick(); t.mock.timers.tick(1200);
  assert.equal(await result, true);
  assert.deepEqual(clicks, ['[data-w2a-delete-menu="1"]', '[data-w2a-delete-item="1"]', '[data-w2a-delete-confirm="1"]']);
});


test('successful generation exports its image and queued ping reuses the same page', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-driver-test-'));
  const savedOutput = config.outputDir;
  config.outputDir = outputDir;
  const navigations: string[] = [];
  const prompts: string[] = [];
  const page = fakePage({
    goto: async (target: string) => { navigations.push(target); },
    nativeType: async (text: string) => { prompts.push(text); },
    evaluate: async (js: string) => {
      if (js.includes('composer:')) return { url, composer: true };
      if (js === 'location.href') return url;
      if (js.includes('generating:')) return { generating: false, sources: ['data:image/png;base64,aGVsbG8='] };
      if (js.startsWith('(async()=>')) return { mimeType: 'image/png', base64: 'aGVsbG8=', width: 1, height: 1 };
      if (js.includes('[...document.images]')) return [];
      return true;
    },
  });
  try {
    const driver = driverWith(page);
    const generated = driver.generate({ prompt: 'a red cube', conversationUrl: url });
    const ping = driver.ping();
    await tick();
    assert.deepEqual(navigations, [url]);
    t.mock.timers.tick(2500); await tick();
    t.mock.timers.tick(2500); await tick();
    const result = await generated;
    assert.equal(result.conversationId, id);
    assert.equal(result.assets.length, 1);
    assert.equal(fs.readFileSync(result.assets[0].filePath!, 'utf8'), 'hello');
    assert.equal((await ping).ok, true);
    assert.deepEqual(navigations, [url, 'https://chatgpt.com']);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /a red cube/);
  } finally { config.outputDir = savedOutput; fs.rmSync(outputDir, { recursive: true, force: true }); }
});

for (const [name, finalUrl, dialogOpen] of [
  ['still on the target conversation', url, false],
  ['confirmation dialog still open', 'https://chatgpt.com/', true],
] as const) {
  test(`delete rejects missing sidebar row when ${name}`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
    let confirmed = false;
    const page = fakePage({
      click: async (selector: string) => { if (selector.includes('confirm')) confirmed = true; },
      evaluate: async (js: string) => {
        if (js.includes('dialogOpen:')) return { url: finalUrl, composer: true, exists: false, dialogOpen };
        if (js.includes('composer:')) return { url: confirmed ? finalUrl : url, composer: true };
        if (js.includes('data-w2a-delete-menu')) return { ok: true };
        if (js.includes('data-w2a-delete-item') || js.includes('data-w2a-delete-confirm')) return true;
        if (js.includes('.some(')) return false;
        throw new Error('Unexpected page operation');
      },
    });
    const result = deletion.deleteConversation(page as any, url);
    await tick(); t.mock.timers.tick(650);
    await tick(); t.mock.timers.tick(650);
    await tick(); t.mock.timers.tick(1200);
    // Allow the bounded eight-second confirmation poll to expire.
    for (let i = 0; i < 21; i++) { await tick(); t.mock.timers.tick(400); }
    assert.equal(await result, false);
  });
}
