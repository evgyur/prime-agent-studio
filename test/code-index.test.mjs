import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createCodeIndex, codeIndexProjectId } from '../lib/code-index.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { timeout: 10_000, windowsHide: true, stdio: 'pipe' });
async function fixture(t, onUpdate) {
  const dir = await mkdtemp(join(tmpdir(), 'studio-code-index-'));
  const root = join(dir, 'project'), dataDir = join(dir, 'studio-data');
  await mkdir(root); await mkdir(dataDir); git(root, 'init', '--quiet');
  const project = { id: '../unsafe', metricsId: 'fixture', path: root };
  const index = createCodeIndex({ dataDir, onUpdate });
  t.after(async () => { await index.close(); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return { dir, root, dataDir, project, index, write: (path, text) => writeFile(join(root, path), text) };
}

test('WAL FTS5, lexical definitions/references/imports, multilingual and incremental changes', { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  await f.write('main.ts', 'import { helper } from "./helper";\nexport function calculate(x: number) {\n return helper(x);\n}\n');
  await f.write('helper.py', 'def helper(value):\n return value\n');
  await f.write('rust.rs', 'pub fn rust_entry() { calculate(); }');
  await f.write('go.go', 'func go_entry() { calculate() }');
  await f.write('class.cs', 'public class Widget {}\npublic static int Compute(int x) { return x; }');
  git(f.root, 'add', 'main.ts'); // Tracked and untracked sources both included; no commits required.
  const status = await f.index.refresh(f.project);
  assert.equal(status.state, 'ready'); assert.equal(status.files, 5);
  const found = await f.index.search(f.project, { q: 'calculate', limit: 1 });
  assert.equal(found.results.length, 1); assert.ok(found.results[0].startLine > 0);
  assert.ok((await f.index.symbols(f.project, { symbol: 'helper' })).results.some((r) => r.kind === 'reference'));
  for (const symbol of ['calculate', 'helper', 'rust_entry', 'go_entry', 'Widget', 'Compute']) assert.ok((await f.index.symbols(f.project, { symbol })).results.some((r) => r.kind === 'definition'), symbol);
  const map = await f.index.map(f.project, { path: 'main.ts' });
  assert.match(map.results[0].imports[0].text, /helper/);
  assert.equal(map.results[0].imports[0].target, './helper');
  assert.equal(map.results[0].imports[0].resolvedPath, 'helper.py');
  assert.equal((await f.index.refresh(f.project)).changed, 0);
  await f.write('helper.py', 'def renamed(value):\n return value\n');
  await rm(join(f.root, 'rust.rs'));
  const next = await f.index.refresh(f.project);
  assert.equal(next.files, 4); assert.equal(next.changed, 2);
  assert.equal((await f.index.symbols(f.project, { symbol: 'rust_entry' })).results.length, 0);
  const id = await codeIndexProjectId(f.project); assert.match(id, /^[a-f0-9]{64}$/);
  const db = new DatabaseSync(join(f.dataDir, 'code-index', id, 'index.sqlite'), { readOnly: true });
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name='chunks'").get().sql, /fts5/);
  db.close();
});

test('secrets, ignored, binary, oversized, traversal, symlink and explicit exclusions never enter results', { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  await f.write('.gitignore', 'ignored.ts\n');
  for (const path of ['safe.ts', '.env.ts', 'credentials.ts', 'secret.json', 'private-key.ts', 'keys.ts', 'tokens.json', 'passwords.json', 'ignored.ts']) await f.write(path, 'function ForbiddenNeedle() {}');
  await f.write('embedded.ts', 'const api_key = "sensitive-value-123"; function ForbiddenNeedle() {}');
  await f.write('config.json', JSON.stringify({ api_key: 'fixture_not_a_real_secret' }));
  await f.write('config.yaml', 'access_token: fixture_not_a_real_secret');
  await f.write('auth.json', JSON.stringify({ authorization: 'Bearer fixture_not_a_real_secret' }));
  await f.write('signing.yaml', 'private_key: fixture_not_a_real_secret');
  await f.write('binary.ts', Buffer.from([0, 65, 66]));
  await f.write('large.ts', 'x'.repeat(1024 * 1024 + 1));
  await f.write('invalid.ts', Buffer.from([0xff, 0xfe, 65]));
  const outside = join(f.dir, 'outside'); await mkdir(outside); await writeFile(join(outside, 'escape.ts'), 'function EscapedNeedle() {}');
  await symlink(outside, join(f.root, 'linked'), 'junction');
  const status = await f.index.refresh(f.project);
  assert.equal(status.state, 'ready'); assert.equal(status.files, 1);
  assert.deepEqual((await f.index.search(f.project, { q: 'ForbiddenNeedle' })).results.map((r) => r.path), ['safe.ts']);
  assert.equal((await f.index.map(f.project, { path: '../outside/escape.ts' })).results.length, 0);
  assert.equal((await f.index.search(f.project, { q: 'EscapedNeedle' })).results.length, 0);
  for (const [method, options] of [['search', { q: 'ForbiddenNeedle' }], ['symbols', { symbol: 'ForbiddenNeedle' }], ['map', {}]]) {
    assert.equal((await f.index[method](f.project, { ...options, exclusions: ['safe.ts'] })).results.length, 0);
  }
  assert.equal((await f.index.refresh(f.project, { exclusions: ['**/*.ts'] })).files, 0);
  assert.equal((await f.index.search(f.project, { q: 'ForbiddenNeedle' })).results.length, 0);
  assert.equal((await f.index.refresh(f.project, { exclusions: [], rebuild: true })).files, 1);
});

test('bounded literal queries and readonly queries do not refresh or modify index', { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  await f.write('one.js', 'function original() {}'); await f.index.refresh(f.project);
  const reader = createCodeIndex({ dataDir: f.dataDir, readOnly: true });
  t.after(() => reader.close());
  const file = join(f.dataDir, 'code-index', await codeIndexProjectId(f.project), 'index.sqlite');
  const before = await readFile(file);
  assert.equal((await reader.search(f.project, { q: 'original' })).results.length, 1);
  for (const q of ['', '" OR * NOT : (', "' ; DROP TABLE files; --"]) assert.ok(Array.isArray((await reader.search(f.project, { q, limit: 100000 })).results));
  assert.equal((await reader.refresh(f.project)).state, 'error');
  assert.deepEqual(await readFile(file), before);
  await reader.close();
  const invalid = createCodeIndex({ dataDir: join(f.root, 'index-data') });
  assert.equal((await invalid.ensureProject(f.project)).state, 'error'); await invalid.close();
});

test('watcher debounces source edits and close stops worker', { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  await f.index.close();
  let resolveUpdate;
  const updated = new Promise((resolve) => { resolveUpdate = resolve; });
  let waiting = false;
  const index = createCodeIndex({ dataDir: f.dataDir, onUpdate: (_project, status) => { if (waiting && status.state === 'ready') resolveUpdate(status); } });
  t.after(() => index.close());
  await f.write('watch.js', 'function beforeWatch() {}');
  await index.refresh(f.project);
  waiting = true;
  await f.write('watch.js', 'function afterWatch() {}');
  await updated;
  assert.equal((await index.symbols(f.project, { symbol: 'afterWatch' })).results.length, 1);
  await index.close();
  assert.equal((await index.status(f.project)).state, 'error');
});


test('exclusions persist over restart and missing readonly index creates no files', { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const missing = createCodeIndex({ dataDir: f.dataDir, readOnly: true });
  assert.equal((await missing.search(f.project, { q: 'anything' })).results.length, 0);
  assert.deepEqual(await readdir(f.dataDir), []); await missing.close();
  await f.write('excluded.ts', 'function hiddenSymbol() {}');
  await f.write('visible.ts', 'function visibleSymbol() {}');
  assert.equal((await f.index.refresh(f.project, { exclusions: ['excluded.ts'] })).files, 1);
  await f.index.close();
  const reopened = createCodeIndex({ dataDir: f.dataDir });
  try {
    assert.equal((await reopened.refresh(f.project)).files, 1);
    assert.equal((await reopened.search(f.project, { q: 'hiddenSymbol' })).results.length, 0);
  } finally { await reopened.close(); }
});


test('opaque ID binding, folder maps, cold status and stopProject', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t), project = { ...f.project, metricsId: 'a'.repeat(64) };
  assert.equal(await codeIndexProjectId(project), project.metricsId);
  assert.equal((await f.index.status(project)).state, 'not-ready');
  assert.deepEqual(await readdir(f.dataDir), []);
  await mkdir(join(f.root, 'src'));
  await f.write('src/first.ts', 'function First() {}');
  await f.write('src/second.ts', 'function Second() {}');
  await f.index.ensureProject(project);
  assert.equal((await f.index.search(project, { q: 'First' })).results.length, 0);
  const status = await f.index.refresh(project, { exclusions: ['src/second.ts'] });
  assert.equal(status.symbols, 1);
  assert.deepEqual((await f.index.map(project, { path: 'src/' })).results.map((row) => row.path), ['src/first.ts']);
  assert.equal((await f.index.map(project, { path: '%' })).results.length, 0);
  const other = join(f.dir, 'other'); await mkdir(other);
  assert.equal((await f.index.ensureProject({ ...project, path: other })).state, 'error');
  await f.index.stopProject(project);
  assert.equal((await f.index.status(project)).state, 'not-ready');
  const reader = createCodeIndex({ dataDir: f.dataDir, readOnly: true });
  try { assert.equal((await reader.search({ ...project, path: other }, { q: 'First' })).state, 'error'); }
  finally { await reader.close(); }
});


test('extensionless build manifests and Go module files are indexed', { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  for (const path of ['Makefile', 'GNUmakefile', 'Dockerfile', 'Justfile', 'go.mod', 'go.sum']) await f.write(path, 'buildfixture: deterministic-local');
  const status = await f.index.refresh(f.project);
  assert.equal(status.files, 6);
  assert.equal((await f.index.search(f.project, { q: 'buildfixture', limit: 20 })).results.length, 6);
  assert.deepEqual((await f.index.search(f.project, { path: 'Makefile' })).results.map((row) => row.path), ['Makefile']);
  assert.equal((await f.index.search(f.project, { path: 'Makefile', q: 'buildfixture' })).results.length, 1);
  assert.equal((await f.index.search(f.project, { path: 'Makefile', exclusions: ['Makefile'] })).results.length, 0);
});


test('LRU admission keeps the ninth and first indexed projects queryable', { timeout: 30_000 }, async (t) => {
  let watching = false, resolveUpdate;
  const watched = new Promise((resolve) => { resolveUpdate = resolve; });
  const f = await fixture(t, (project, status) => {
    if (watching && project.metricsId === '0'.repeat(64) && status.state === 'ready') resolveUpdate();
  }), projects = [];
  for (let i = 0; i < 9; i++) {
    const path = join(f.dir, `project-${i}`); await mkdir(path); git(path, 'init', '--quiet');
    await writeFile(join(path, 'source.ts'), `function Project${i}() {}`);
    const project = { path, metricsId: String(i).repeat(64) }; projects.push(project);
    assert.equal((await f.index.refresh(project)).state, 'ready');
  }
  assert.equal((await f.index.search(projects[8], { q: 'Project8' })).results.length, 1);
  await writeFile(join(projects[0].path, 'source.ts'), 'function ReopenedFresh() {}');
  assert.equal((await f.index.search(projects[0], { q: 'ReopenedFresh' })).results.length, 1);
  watching = true;
  await writeFile(join(projects[0].path, 'source.ts'), 'function WatchedAfterReopen() {}');
  await watched;
  assert.equal((await f.index.search(projects[0], { q: 'WatchedAfterReopen' })).results.length, 1);
});


test('concurrent admission stays bounded and busy projects can retry', { timeout: 30_000 }, async (t) => {
  const f = await fixture(t), projects = [];
  for (let i = 0; i < 12; i++) {
    const path = join(f.dir, `parallel-${i}`); await mkdir(path); git(path, 'init', '--quiet');
    await writeFile(join(path, 'source.ts'), `function Concurrent${i}() {}`);
    projects.push({ path, metricsId: i.toString(16).repeat(64) });
  }
  const attempts = await Promise.all(projects.map((project) => f.index.refresh(project)));
  assert.ok(attempts.filter((result) => result.state === 'ready').length <= 8);
  for (let i = 0; i < projects.length; i++) {
    assert.equal((await f.index.refresh(projects[i])).state, 'ready');
    assert.equal((await f.index.search(projects[i], { q: `Concurrent${i}` })).results.length, 1);
  }
});


test('status returns cached snapshot while worker refresh is pending', { timeout: 20_000 }, async (t) => {
  let resolveIndexing;
  const indexing = new Promise((resolve) => { resolveIndexing = resolve; });
  const f = await fixture(t, (_project, status) => { if (status.state === 'indexing') resolveIndexing(); });
  for (let i = 0; i < 100; i++) await f.write(`source-${i}.ts`, `function pending${i}() {}\n`.repeat(200));
  await f.index.ensureProject(f.project);
  const refresh = f.index.refresh(f.project);
  await indexing;
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Cached status blocked behind refresh')), 500); });
  try {
    const status = await Promise.race([f.index.status(f.project), deadline]);
    assert.ok(['indexing', 'ready'].includes(status.state));
  } finally { clearTimeout(timer); }
  assert.equal((await refresh).state, 'ready');
});


test('large Unicode query output remains usable within 48 KiB', { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  const text = Array.from({ length: 80 }, (_, i) => `import item${i} from "${'界'.repeat(120)}";`).join('\n') + '\nfunction boundedNeedle() {}';
  for (let i = 0; i < 20; i++) await f.write(`large-${i}.ts`, text);
  assert.equal((await f.index.refresh(f.project)).state, 'ready');
  for (const [method, options] of [['map', { limit: 50 }], ['search', { q: 'import', limit: 50 }], ['symbols', { symbol: 'boundedNeedle', limit: 50 }]]) {
    const result = await f.index[method](f.project, options);
    assert.equal(result.state, 'ready');
    assert.ok(result.results.length > 0, method);
    assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 48 * 1024, method);
    if (method !== 'symbols') assert.equal(result.truncated, true);
    if (method === 'map') assert.ok(result.results.every((row) => row.imports.length <= 20 && row.definitions.length <= 20 && row.references.length <= 20));
  }
  await f.write('oversized-row.ts', `import huge from "${'界'.repeat(20000)}";\nfunction StillUsable() {}`);
  await f.index.refresh(f.project);
  const single = await f.index.map(f.project, { path: 'oversized-row.ts' });
  assert.equal(single.truncated, true);
  assert.equal(single.results.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(single), 'utf8') <= 48 * 1024);
});


test('non-Git projects create no SQLite or watcher handles and allow immediate cleanup', { timeout: 15_000 }, async (t) => {
  const f = await fixture(t), path = join(f.dir, 'non-git'); await mkdir(path);
  await writeFile(join(path, 'source.ts'), 'function NotIndexed() {}');
  const project = { path, metricsId: 'e'.repeat(64) };
  assert.equal((await f.index.ensureProject(project)).state, 'unavailable');
  assert.equal((await f.index.refresh(project)).reason, 'not-git');
  assert.equal((await f.index.search(project, { q: 'NotIndexed' })).results.length, 0);
  assert.ok(!(await readdir(f.dataDir, { recursive: true })).some((file) => file.includes('sqlite')));
  // Deliberately delete before close, matching server test teardown order on Windows.
  await rm(path, { recursive: true });
  await rm(f.dataDir, { recursive: true });
});


test('refresh emits bounded monotonic progress and terminal ready', { timeout: 20_000 }, async (t) => {
  const events = [];
  const f = await fixture(t, (_project, status) => events.push(status));
  for (let i = 0; i < 205; i++) await f.write(`progress-${i}.ts`, `function progress${i}() {}`);
  const result = await f.index.refresh(f.project);
  const progress = events.filter((event) => event.progress);
  assert.equal(result.state, 'ready');
  assert.deepEqual(result.progress, { completed: 205, total: 205 });
  assert.equal(progress[0].progress.completed, 0);
  assert.equal(progress.at(-1).state, 'ready');
  assert.ok(progress.length <= 5);
  for (let i = 1; i < progress.length; i++) assert.ok(progress[i].progress.completed >= progress[i - 1].progress.completed);
  assert.ok(events.filter((event) => event.state === 'indexing').every((event) => event.files === 0));
});
