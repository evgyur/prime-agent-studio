import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../server.mjs';
import { createProjectFiles } from '../lib/project-files.mjs';
import { createFilePreviewSettings } from '../lib/file-preview-settings.mjs';
import { createLanGateway, hashAccessCode } from '../lib/lan.mjs';

const ACCESS_CODE = '49283175';
const PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function http(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((done, reject) => {
    const outgoing = {
      ...(body !== undefined ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      ...headers,
    };
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: outgoing }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        text += chunk;
      });
      response.on('error', (error) => reject(error));
      response.on('end', () => {
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          /* non-JSON */
        }
        done({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('fixture request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

function fakeRuntime() {
  return {
    controls: [],
    async getStatus() {
      return { available: true, version: 'fixture', nodeVersion: process.versions.node };
    },
    async getModels() {
      return { models: [], default: { model: 'fixture/no-provider' } };
    },
    async start() {
      throw new Error('no agents in fixture');
    },
    async close() {},
  };
}

async function tempProject(t) {
  const root = await mkdtemp(join(tmpdir(), 'prime-file-preview-'));
  const project = join(root, 'project');
  const outside = join(root, 'outside');
  await mkdir(project, { recursive: true });
  await mkdir(outside, { recursive: true });
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  return { root, project, outside };
}

test('file preview settings default to enabled and persist a strict boolean', async (t) => {
  const { root } = await tempProject(t);
  const dataDir = join(root, 'data');
  const settings = createFilePreviewSettings({ dataDir });
  assert.deepEqual(await settings.get(), { allowOutsideProject: true });
  assert.deepEqual(await settings.set({ allowOutsideProject: false }), { allowOutsideProject: false });
  assert.deepEqual(await settings.get(), { allowOutsideProject: false });
  const reopened = createFilePreviewSettings({ dataDir });
  assert.deepEqual(await reopened.get(), { allowOutsideProject: false });
  assert.deepEqual(await reopened.set({ allowOutsideProject: true }), { allowOutsideProject: true });
  for (const bad of [
    {},
    { allowOutsideProject: 'yes' },
    { allowOutsideProject: 1 },
    { allowOutsideProject: true, extra: true },
    [],
    null,
    'yes',
  ])
    await assert.rejects(settings.set(bad), { status: 400 });
});

test('external preview serves real outside text and images only for explicit references', async (t) => {
  const { project, outside } = await tempProject(t);
  await writeFile(join(outside, 'notes.md'), '# Outside\nhello\n');
  await writeFile(join(project, 'inside.md'), '# Inside\n');
  await writeFile(join(outside, 'pixel.png'), Buffer.from(PIXEL_PNG_BASE64, 'base64'));
  const files = createProjectFiles({
    store: { findProject: async () => ({ cwd: project }) },
    protectedRoots: [],
  });
  const allow = { allowOutsideProject: true };
  const absolute = join(outside, 'notes.md');
  const text = await files.externalPreview(project, absolute, '', allow);
  assert.equal(text.type, 'text');
  assert.match(text.text, /hello/);
  assert.equal(text.external, true);
  assert.equal(text.absolutePath, text.path);
  // Exact explicit ../ reference with a line suffix resolves to the same file.
  const viaRelative = await files.externalPreview(project, '../outside/notes.md:2', '', allow);
  assert.equal(viaRelative.type, 'text');
  assert.equal(viaRelative.absolutePath, text.absolutePath);
  // file:/// URL works too.
  const viaUrl = await files.externalPreview(project, pathToFileURL(absolute).toString(), '', allow);
  assert.equal(viaUrl.absolutePath, text.absolutePath);
  const image = await files.externalPreview(project, join(outside, 'pixel.png'), '', allow);
  assert.equal(image.type, 'image');
  assert.match(image.image, /^data:image\/png;base64,/);
  assert.equal(image.external, true);
  // Bare names never search the outside: no enumeration.
  await assert.rejects(files.externalPreview(project, 'notes.md', '', allow), { status: 400 });
  // A project file is not an external reference.
  await assert.rejects(files.externalPreview(project, join(project, 'inside.md'), '', allow), {
    status: 400,
  });
  // A directory is never listed through the external route.
  await assert.rejects(files.externalPreview(project, outside, '', allow), { status: 400 });
});

test('external preview blocks protected roots, symlinks, UNC, ADS and missing files', async (t) => {
  const { project, outside, root } = await tempProject(t);
  const protectedDir = join(root, 'protected');
  await mkdir(protectedDir, { recursive: true });
  await mkdir(join(outside, '.git'), { recursive: true });
  await writeFile(join(protectedDir, 'secret.md'), '# Secret\n');
  await writeFile(join(outside, '.git', 'config'), '[core]\n');
  await writeFile(join(outside, 'notes.md'), '# Outside\n');
  const files = createProjectFiles({
    store: { findProject: async () => ({ cwd: project }) },
    protectedRoots: [protectedDir],
  });
  const allow = { allowOutsideProject: true };
  await assert.rejects(files.externalPreview(project, join(protectedDir, 'secret.md'), '', allow), {
    status: 403,
  });
  await assert.rejects(files.externalPreview(project, join(outside, '.git', 'config'), '', allow), {
    status: 403,
  });
  const link = join(outside, 'link.md');
  await symlink(join(protectedDir, 'secret.md'), link);
  await assert.rejects(files.externalPreview(project, link, '', allow), { status: 403 });
  for (const reference of [
    '//server/share/file.md',
    '\\\\server\\share\\file.md',
    'file://server/share/file.md',
    `${join(outside, 'notes.md')}:stream`,
    `${join(outside, 'notes.md')}.`,
  ])
    await assert.rejects(files.externalPreview(project, reference, '', allow), (error) => {
      assert.ok([400, 403, 404].includes(error.status), `${reference} -> ${error.status}`);
      return true;
    });
  await assert.rejects(files.externalPreview(project, join(outside, 'missing.md'), '', allow), {
    status: 404,
  });
  // The setting is enforced on every external read.
  await assert.rejects(files.externalPreview(project, join(outside, 'notes.md'), '', {}), {
    status: 403,
  });
  await assert.rejects(
    files.externalPreview(project, join(outside, 'notes.md'), '', { allowOutsideProject: false }),
    { status: 403 },
  );
});

test('ordinary project routes stay confined while the server shares the preview payload', async (t) => {
  const { project, outside, root } = await tempProject(t);
  await writeFile(join(outside, 'notes.md'), '# Outside\nhello\n');
  await writeFile(join(project, 'inside.md'), '# Inside\n');
  const files = createProjectFiles({
    store: { findProject: async () => ({ cwd: project }) },
    protectedRoots: [],
  });
  await assert.rejects(files.resolveReference(project, join(outside, 'notes.md')), { outside: true });
  const checked = await files.checkReferences(project, [join(outside, 'notes.md')]);
  assert.equal(checked.results[0].status, 'outside');
  await assert.rejects(files.preview(project, '../outside/notes.md'), (error) => {
    assert.ok([400, 403, 404].includes(error.status), `project preview -> ${error.status}`);
    return true;
  });

  const app = createApp({
    agentHome: join(root, 'agent'),
    sessionDir: join(root, 'sessions'),
    dataDir: join(root, 'data'),
    initialCwd: project,
    runtime: fakeRuntime(),
  });
  await mkdir(join(root, 'sessions'), { recursive: true });
  await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
  t.after(() => app.close());
  const port = app.server.address().port;
  const get = (path) => http(port, path);
  const post = (path, body) =>
    http(port, path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  assert.deepEqual((await get('/api/file-preview-settings')).json, { allowOutsideProject: true });
  assert.equal((await post('/api/file-preview-settings', { allowOutsideProject: 'yes' })).status, 400);
  assert.deepEqual((await post('/api/file-preview-settings', { allowOutsideProject: false })).json, {
    allowOutsideProject: false,
  });
  assert.deepEqual((await get('/api/file-preview-settings')).json, { allowOutsideProject: false });
  const blocked = await get(
    `/api/file-previews/external?cwd=${encodeURIComponent(project)}&reference=${encodeURIComponent(join(outside, 'notes.md'))}`,
  );
  assert.equal(blocked.status, 403);
  assert.deepEqual((await post('/api/file-preview-settings', { allowOutsideProject: true })).json, {
    allowOutsideProject: true,
  });
  const external = await get(
    `/api/file-previews/external?cwd=${encodeURIComponent(project)}&reference=${encodeURIComponent(join(outside, 'notes.md:1'))}`,
  );
  assert.equal(external.status, 200, external.text);
  assert.equal(external.json.external, true);
  assert.equal(external.json.absolutePath, external.json.path);
  assert.equal(external.json.type, 'text');
  assert.match(external.json.text, /hello/);
  const projectPreview = await get(
    `/api/project-files/preview?cwd=${encodeURIComponent(project)}&path=${encodeURIComponent('inside.md')}`,
  );
  assert.equal(projectPreview.status, 200, projectPreview.text);
  assert.equal(projectPreview.json.type, 'text');
});

test('gateway keeps external reads and setting writes in full control only', async (t) => {
  for (const readOnly of [true, false]) {
    const root = await mkdtemp(join(tmpdir(), 'prime-studio-lan-external-'));
    t.after(async () => {
      assert.equal(dirname(resolve(root)), resolve(tmpdir()));
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    const cwd = join(root, 'project');
    const sessionDir = join(root, 'sessions');
    await mkdir(cwd, { recursive: true });
    await mkdir(sessionDir, { recursive: true });
    const outside = join(root, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'notes.md'), '# Outside\nhello\n');
    await writeFile(
      join(sessionDir, 'native-session.jsonl'),
      [
        { type: 'session', id: 'native-session', cwd, timestamp: '2026-09-04T00:00:00.000Z' },
        {
          type: 'message',
          id: 'initial-message',
          parentId: null,
          message: { role: 'user', content: 'Existing conversation' },
        },
      ]
        .map((value) => JSON.stringify(value))
        .join('\n') + '\n',
    );
    const app = createApp({
      agentHome: join(root, 'agent'),
      sessionDir,
      dataDir: join(root, 'data'),
      initialCwd: cwd,
      runtime: fakeRuntime(),
    });
    await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
    const upstreamPort = app.server.address().port;
    const salt = 'e54d6dd09bb15f7c347b38b671472aa9';
    const gateway = createLanGateway({
      host: '127.0.0.1',
      port: 0,
      upstreamPort,
      config: { salt, codeHash: hashAccessCode(ACCESS_CODE, salt), readOnly },
    });
    t.after(async () => {
      gateway.closeAllConnections();
      await new Promise((done) => gateway.close(done));
      await app.close();
    });
    await new Promise((done) => gateway.listen(0, '127.0.0.1', done));
    const port = gateway.address().port;
    const api = (path, options) => http(port, path, options);
    const login = await api('/lan/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: ACCESS_CODE }).toString(),
    });
    assert.equal(login.status, 303, login.text);
    const Cookie = login.headers['set-cookie'][0].split(';')[0];
    const authed = (path, options = {}) => {
      const headers = { ...(options.headers || {}), Cookie, Origin: `http://127.0.0.1:${port}` };
      return api(path, { ...options, headers });
    };
    const settings = await authed('/api/file-preview-settings');
    assert.equal(settings.status, readOnly ? 404 : 200, settings.text);
    const write = await authed('/api/file-preview-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowOutsideProject: true }),
    });
    assert.equal(write.status, readOnly ? 405 : 200, write.text);
    const external = await authed(
      `/api/file-previews/external?cwd=${encodeURIComponent(cwd)}&reference=${encodeURIComponent(join(outside, 'notes.md'))}`,
    );
    assert.equal(external.status, readOnly ? 404 : 200, external.text);
    if (!readOnly) assert.equal(external.json.external, true);
    // Cleanup is registered before assertions, including failure paths.
  }
});

test('damaged saved preview settings do not silently enable external access', async (t) => {
  const { root } = await tempProject(t);
  const settings = createFilePreviewSettings({ dataDir: root });
  for (const content of ['{broken', '{}', '{"allowOutsideProject":"yes"}']) {
    await writeFile(join(root, 'file-preview-settings.json'), content);
    assert.equal((await settings.get()).allowOutsideProject, false);
  }
});
