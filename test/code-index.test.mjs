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
  assert.equal(status.state, 'ready'); assert.equal(status.files, 9);
  const retained = ['credentials.ts', 'embedded.ts', 'keys.ts', 'private-key.ts', 'safe.ts'];
  assert.deepEqual((await f.index.search(f.project, { q: 'ForbiddenNeedle' })).results.map((r) => r.path).sort(), retained);
  const database = await readFile(join(f.dataDir, 'code-index', await codeIndexProjectId(f.project), 'index.sqlite'));
  for (const literal of ['sensitive-value-123', 'fixture_not_a_real_secret']) assert.ok(!database.includes(Buffer.from(literal)));
  assert.equal((await f.index.map(f.project, { path: '../outside/escape.ts' })).results.length, 0);
  assert.equal((await f.index.search(f.project, { q: 'EscapedNeedle' })).results.length, 0);
  for (const [method, options] of [['search', { q: 'ForbiddenNeedle' }], ['symbols', { symbol: 'ForbiddenNeedle' }], ['map', {}]]) {
    assert.equal((await f.index[method](f.project, { ...options, exclusions: [...retained, 'config.json', 'config.yaml', 'auth.json', 'signing.yaml'] })).results.length, 0);
  }
  assert.equal((await f.index.refresh(f.project, { exclusions: ['**/*.ts'] })).files, 4);
  assert.equal((await f.index.search(f.project, { q: 'ForbiddenNeedle' })).results.length, 0);
  assert.equal((await f.index.refresh(f.project, { exclusions: [], rebuild: true })).files, 9);
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
  assert.equal(status.files, 5);
  assert.equal((await f.index.search(f.project, { q: 'buildfixture', limit: 20 })).results.length, 5);
  assert.equal((await f.index.refresh(f.project, { includeGenerated: true })).files, 6);
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


test('literal credentials are redacted without dropping source and automatic exclusions are visible', { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  const secret = 'fixture_literal_credential_984237';
  await f.write('handler.ts', `const apiKey = value.credentialEnv;\nconst password = "${secret}";\nexport function retainedHandler() { return apiKey; }`);
  await f.write('auth.md', 'Authorization: Bearer\nUse your environment configuration.');
  await f.write('credentials.json', '{"value":"excluded"}');
  await f.write('package-lock.json', '{"name":"retainedHandler"}');
  await f.write('bundle.min.js', 'function retainedHandler() {}');
  const status = await f.index.refresh(f.project);
  assert.equal(status.files, 2);
  assert.ok(status.automaticExclusions.some((row) => row.path === 'credentials.json' && row.reason === 'sensitive-name'));
  assert.ok(status.automaticExclusions.some((row) => row.path === 'package-lock.json' && row.reason === 'lockfile'));
  const result = await f.index.search(f.project, { q: 'retainedHandler' });
  assert.equal(result.results[0].path, 'handler.ts');
  assert.ok(result.indexedAt); assert.equal(result.results[0].stale, false);
  assert.ok(result.excludedCount >= 3);
  const dbPath = join(f.dataDir, 'code-index', await codeIndexProjectId(f.project), 'index.sqlite');
  assert.ok(!(await readFile(dbPath)).includes(Buffer.from(secret)));
  assert.equal((await f.index.search(f.project, { q: 'credentialEnv' })).results.length, 1);
  assert.equal((await f.index.refresh(f.project, { includeGenerated: true })).files, 4);
});

test('TypeScript methods, multiline imports, split search and stale evidence', { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  await f.write('conductor.mts', `import {\n type ImportedType, helper\n} from './helper';\nexport class Conductor {\n async launchNode(task: string): Promise<void> {\n helper(task); task.slice(0); edge.from(task);\n }\n syncConversation(\n task: string\n ): void { helper(task); }\n}\n`);
  await f.write('helper.cts', 'export function helper(task: string) {}');
  await f.write('noise.ts', Array.from({ length: 12 }, (_, i) => `function noise${i}() { /* le la les the and launch node */ }`).join('\n'));
  await f.index.refresh(f.project);
  for (const symbol of ['launchNode', 'syncConversation']) assert.ok((await f.index.symbols(f.project, { symbol })).results.some((r) => r.kind === 'definition'), symbol);
  assert.equal((await f.index.symbols(f.project, { symbol: 'ImportedType' })).results.length, 0);
  const map = (await f.index.map(f.project, { path: 'conductor.mts' })).results[0];
  assert.equal(map.imports.length, 1); assert.equal(map.imports[0].target, './helper');
  assert.equal(map.imports[0].resolvedPath, 'helper.cts');
  assert.ok(!map.references.some((r) => r.name === 'slice'));
  assert.equal(map.totals.definitions, 3);
  const found = await f.index.search(f.project, { q: 'le la the launch node', limit: 20 });
  assert.equal(found.results[0].path, 'conductor.mts');
  assert.ok(found.results.every((r) => r.text.length <= 1500));
  assert.ok(found.results.filter((r) => r.path === 'noise.ts').length <= 2);
  const readonly = createCodeIndex({ dataDir: f.dataDir, readOnly: true }); t.after(() => readonly.close());
  await f.write('conductor.mts', '// changed after indexing');
  const stale = await readonly.search(f.project, { q: 'launchNode' });
  assert.equal(stale.results[0].stale, true); assert.ok(stale.indexedAt);
  await readonly.close();
});


test('redaction keeps secret-handling modules and removes quoted, YAML, bearer and PEM values', { timeout: 30_000 }, async (t) => {
  const f = await fixture(t), literal = 'fixtureCredentialLiteral903621';
  await f.write('secrets.ts', `export function configureSecret(value) { return { apiKey: value.credentialEnv }; }\nconst apiKey = '${literal}';`);
  await f.write('auth.yaml', `access_token: ${literal}\nauthorization: Bearer ${literal}\n`);
  await f.write('signing.ts', `const privateKey = "-----BEGIN PRIVATE KEY-----\n${literal}\n-----END PRIVATE KEY-----";\nfunction loadSigning() {}`);
  const status = await f.index.refresh(f.project);
  assert.equal(status.files, 3);
  assert.equal((await f.index.symbols(f.project, { symbol: 'configureSecret' })).results[0].kind, 'definition');
  const dbPath = join(f.dataDir, 'code-index', await codeIndexProjectId(f.project), 'index.sqlite');
  assert.ok(!(await readFile(dbPath)).includes(Buffer.from(literal)));
  assert.equal((await f.index.search(f.project, { q: literal })).results.length, 0);
});


test('credential templates and docs stay intact while generic high entropy literals are masked', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const literal = 'K9mP2xR7vT4nQ8sL3wY6aB5d';
  await f.write('client.ts', 'const authorization = `Bearer ${token}`;\nconst password = "example";\nconst fixture = "' + literal + '";');
  await f.index.refresh(f.project);
  const row = (await f.index.search(f.project, { path: 'client.ts' })).results[0];
  assert.match(row.text, /Bearer \$\{token\}/);
  assert.match(row.text, /"example"/);
  assert.ok(!row.text.includes(literal));
});


test('private methods and arrow fields are definitions and long lines stay searchable', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  await f.write('private.ts', 'class Service {\n #launchNode() {}\n syncConversation = async (task: string) => { return task; };\n}\n' + '// filler '.repeat(1000) + ' TailEvidenceUnique');
  await f.index.refresh(f.project);
  for (const symbol of ['#launchNode', 'syncConversation']) assert.ok((await f.index.symbols(f.project, { symbol })).results.some((r) => r.kind === 'definition'));
  assert.equal((await f.index.search(f.project, { q: 'TailEvidenceUnique' })).results.length, 1);
});


test('old schemas request rebuild read-only and migrate without retaining raw secrets', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t), literal = 'obsoleteRawCredentialFixture992283';
  await f.write('safe.ts', 'function preservedAfterMigration() {}');
  await f.index.refresh(f.project); await f.index.close();
  const dbPath = join(f.dataDir, 'code-index', await codeIndexProjectId(f.project), 'index.sqlite');
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE meta SET value='1' WHERE key='schemaVersion'").run();
  db.prepare('INSERT INTO chunks(path,startLine,endLine,text) VALUES(?,?,?,?)').run('obsolete.ts', 1, 1, literal);
  db.close();
  const reader = createCodeIndex({ dataDir: f.dataDir, readOnly: true });
  try { assert.equal((await reader.search(f.project, { q: literal })).reason, 'rebuild-required'); }
  finally { await reader.close(); }
  const writer = createCodeIndex({ dataDir: f.dataDir });
  try {
    assert.equal((await writer.refresh(f.project)).state, 'ready');
    assert.ok(!(await readFile(dbPath)).includes(Buffer.from(literal)));
  } finally { await writer.close(); }
});


test('exact path excerpts preserve late manifest commands and long-line content', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const source = '{"description":"' + 'documentation '.repeat(180) + '","scripts":{"typecheck":"npx tsc --noEmit"}}';
  await f.write('package.json', source);
  await f.index.refresh(f.project);
  const result = await f.index.search(f.project, { path: 'package.json', limit: 20 });
  assert.equal(result.results.map((row) => row.text).join(''), source);
  assert.ok(result.results.every((row) => row.text.length <= 1500));
});


test('short explicit credential literals never enter raw SQLite', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  await f.write('client.ts', 'const auth = { password: "hunter2", apiKey: "ABC1234" };');
  await f.index.refresh(f.project);
  const bytes = await readFile(join(f.dataDir, 'code-index', await codeIndexProjectId(f.project), 'index.sqlite'));
  for (const literal of ['hunter2', 'ABC1234']) assert.ok(!bytes.includes(Buffer.from(literal)), literal);
});


test('wrong-root legacy databases are rejected before schema migration writes', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  await f.write('safe.ts', 'function preserveWrongRootData() {}');
  await f.index.refresh(f.project); await f.index.close();
  const dbPath = join(f.dataDir, 'code-index', await codeIndexProjectId(f.project), 'index.sqlite');
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE meta SET value='1' WHERE key='schemaVersion'").run();
  db.prepare("UPDATE meta SET value=? WHERE key='root'").run(join(f.dir, 'other-root'));
  db.exec('DROP TABLE excluded; PRAGMA wal_checkpoint(TRUNCATE)'); db.close();
  const before = await readFile(dbPath), writer = createCodeIndex({ dataDir: f.dataDir });
  try { assert.equal((await writer.ensureProject(f.project)).state, 'error'); }
  finally { await writer.close(); }
  assert.deepEqual(await readFile(dbPath), before);
});


test('exact symbol definitions outrank repeated README prose', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  await f.write('core.ts', 'export const launchNode = () => true;');
  await f.write('README.md', 'Launch node function documentation\n'.repeat(40));
  await f.index.refresh(f.project);
  for (const q of ['launchNode', 'launch node']) assert.equal((await f.index.search(f.project, { q })).results[0].path, 'core.ts');
});


test('French action words find code definitions rather than translated prose', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  await f.write('worker.ts', 'export function launchTask(task) { return syncConversation(task.machine); }\nexport function syncConversation(machine) { return machine; }');
  await f.write('fr.ts', 'export const labels = { hint: "lancer tâche synchroniser conversation machine" };');
  await f.write('README.md', 'lancer tâche synchroniser conversation machine\n'.repeat(40));
  await f.write('node-panel.ts', '// launch node '.repeat(20));
  await f.write('core.ts', 'export const launchNode = () => true;');
  await f.index.refresh(f.project);
  assert.equal((await f.index.search(f.project, { q: 'lancer tâche synchroniser conversation machine' })).results[0].path, 'worker.ts');
  assert.equal((await f.index.search(f.project, { q: 'launchNode' })).results[0].path, 'core.ts');
});


test('bounded excerpts retain the source start line when a match is late in the chunk', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const source = 'export function sourceRange() {\n' + '  // padding for source range\n'.repeat(25) + '  return LateRangeKeyword;\n}';
  await f.write('range.ts', source);
  await f.index.refresh(f.project);
  const row = (await f.index.search(f.project, { q: 'LateRangeKeyword' })).results[0];
  assert.equal(row.startLine, 1);
  assert.equal(row.text, source);
  assert.equal(row.textTruncated, false);
});


test('exact identifier definitions inside i18n outrank helper references', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'i18n'));
  await f.write('i18n/fr.ts', 'export function translateMessage(key) { return key; }');
  await f.write('helper.ts', 'export function translateMessageReference(key) { return translateMessage(key); }');
  await f.index.refresh(f.project);
  assert.equal((await f.index.search(f.project, { q: 'translateMessage' })).results[0].path, 'i18n/fr.ts');
});


test('exact filename search explains exclusions without treating prose as a path', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  await f.write('.env.local', 'PRIVATE_SETTING=not-indexed');
  await f.write('package-lock.json', '{}');
  await f.write('safe.ts', 'export function safeSource() {}');
  await f.index.refresh(f.project);
  const secret = await f.index.search(f.project, { q: '.env.local' });
  assert.deepEqual(secret.excludedPath, { path: '.env.local', reason: 'sensitive-name' });
  const generated = await f.index.search(f.project, { q: 'package-lock.json' });
  assert.deepEqual(generated.excludedPath, { path: 'package-lock.json', reason: 'lockfile' });
  const configured = await f.index.search(f.project, { q: 'safe.ts', exclusions: ['safe.ts'] });
  assert.deepEqual(configured.excludedPath, { path: 'safe.ts', reason: 'configured' });
  const prose = await f.index.search(f.project, { q: 'explain .env.local configuration' });
  assert.equal(prose.excludedPath, undefined);
});


test('directory maps do not report unsupported-file exclusions', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'src'));
  await mkdir(join(f.root, '.github', 'workflows'), { recursive: true });
  await f.write('src/main.ts', 'export function mappedSource() {}');
  await f.write('.github/workflows/check.yaml', 'name: checks');
  await f.index.refresh(f.project);
  for (const path of ['src', '.github/workflows']) {
    const result = await f.index.map(f.project, { path });
    assert.equal(result.results.length, 1);
    assert.equal(result.excludedPath, undefined);
  }
  const configured = await f.index.map(f.project, { path: 'src', exclusions: ['src'] });
  assert.deepEqual(configured.excludedPath, { path: 'src', reason: 'configured' });
});
