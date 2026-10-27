import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { request } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createProjectGit } from '../lib/project-git.mjs';
import { createProjectFiles } from '../lib/project-files.mjs';
import { HttpError } from '../lib/store.mjs';
import { createApp } from '../server.mjs';

process.env.GIT_CONFIG_NOSYSTEM = '1';

const exec = promisify(execFile);
const gitEnv = () => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  GIT_EDITOR: 'true',
  GIT_CONFIG_NOSYSTEM: '1',
});

async function git(cwd, args) {
  const { stdout } = await exec('git', args, { cwd, env: gitEnv() });
  return stdout.trim();
}

async function makeRepo() {
  const root = await mkdtemp(join(tmpdir(), 'prime-studio-git-read-'));
  const cwd = join(root, 'repo');
  await mkdir(cwd, { recursive: true });
  await git(root, ['init', '--quiet', '-b', 'main', 'repo']);
  await git(cwd, ['config', 'user.name', 'Test']);
  await git(cwd, ['config', 'user.email', 'test@example.com']);
  await git(cwd, ['config', 'commit.gpgsign', 'false']);
  await git(cwd, ['config', 'core.autocrlf', 'false']);
  return { root, cwd };
}

async function commitFile(cwd, name, content, message, binary = false) {
  if (binary) await writeFile(join(cwd, name), content);
  else await writeFile(join(cwd, name), content, 'utf8');
  await git(cwd, ['add', '-A']);
  await git(cwd, ['commit', '--quiet', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

function serviceFor(known) {
  const knownSet = new Set(known);
  const store = {
    findProject: async (cwd) => {
      if (typeof cwd !== 'string' || !knownSet.has(cwd)) throw new HttpError(404, 'missing');
      return { cwd };
    },
  };
  const filesFor = () => createProjectFiles({ store, protectedRoots: [] });
  return createProjectGit({ store, filesFor, dataDir: join(tmpdir(), 'prime-studio-git-read-data') });
}

async function richRepo() {
  // root commit, feature branch, merge commit, annotated + lightweight tags.
  const { root, cwd } = await makeRepo();
  const c1 = await commitFile(cwd, 'a.txt', 'one\n', 'first');
  await git(cwd, ['checkout', '--quiet', '-b', 'feature']);
  await commitFile(cwd, 'feature.txt', 'feat\nline\n', 'feature work');
  await git(cwd, ['checkout', '--quiet', 'main']);
  await git(cwd, ['merge', '--quiet', '--no-ff', '-m', 'merge feature', 'feature']);
  const merge = await git(cwd, ['rev-parse', 'HEAD']);
  await git(cwd, ['tag', 'light1']);
  await git(cwd, ['tag', '-a', 'annot1', '-m', 'annotated']);
  // Rename + binary + deletion on top.
  await commitFile(cwd, 'deleteme.txt', 'gone\n', 'add doomed file');
  const { rename } = await import('node:fs/promises');
  await rename(join(cwd, 'a.txt'), join(cwd, 'renamed.txt'));
  await git(cwd, ['add', '-A']);
  await git(cwd, ['commit', '--quiet', '-m', 'rename a']);
  const renameSha = await git(cwd, ['rev-parse', 'HEAD']);
  await commitFile(cwd, 'bin.dat', Buffer.from([0, 1, 2, 255, 254, 0, 9]), 'binary blob', true);
  const binSha = await git(cwd, ['rev-parse', 'HEAD']);
  await git(cwd, ['rm', '--quiet', 'deleteme.txt']);
  await git(cwd, ['commit', '--quiet', '-m', 'delete file']);
  const delSha = await git(cwd, ['rev-parse', 'HEAD']);
  return { root, cwd, c1, merge, renameSha, binSha, delSha };
}

test('history lists commits, tags, branches and pages', async (t) => {
  const { root, cwd, merge } = await richRepo();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const svc = serviceFor([cwd]);

  const head = await git(cwd, ['rev-parse', 'HEAD']);
  const full = await svc.history(cwd, {});
  assert.equal(full.ref, head);
  assert.equal(full.commits[0].hash, head);
  assert.ok(Array.isArray(full.commits));
  assert.equal(full.hasMore, false);
  assert.ok(full.commits.length >= 6);
  assert.equal(full.commits[0].hash, await git(cwd, ['rev-parse', 'HEAD']));
  for (const c of full.commits) {
    assert.match(c.hash, /^[0-9a-f]{40}$/);
    assert.equal(c.shortHash, c.hash.slice(0, 7));
    assert.ok(typeof c.subject === 'string' && c.subject.length > 0);
    assert.ok(Array.isArray(c.parents));
    assert.ok(Array.isArray(c.tags) && Array.isArray(c.branches));
  }
  const tagged = full.commits.find((c) => c.hash === merge);
  assert.ok(tagged);
  assert.ok(tagged.tags.includes('light1') && tagged.tags.includes('annot1'));

  const page1 = await svc.history(cwd, { limit: 2, offset: 0 });
  assert.equal(page1.commits.length, 2);
  assert.equal(page1.hasMore, true);
  const page2 = await svc.history(cwd, { limit: 2, offset: 2 });
  assert.equal(page2.commits.length, 2);
  assert.notEqual(page2.commits[0].hash, page1.commits[0].hash);

  const byBranch = await svc.history(cwd, { ref: 'main' });
  assert.equal(byBranch.ref, head);
  const byTag = await svc.history(cwd, { ref: 'light1' });
  assert.ok(byTag.commits.some((c) => c.hash === merge));
  const byShort = await svc.history(cwd, { ref: merge.slice(0, 12) });
  assert.equal(byShort.ref, merge);
});

test('history rejects injection, bad refs and unknown roots', async (t) => {
  const { root, cwd } = await richRepo();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const svc = serviceFor([cwd]);
  for (const ref of ['--upload-pack=evil', '-p', 'HEAD; rm -rf /', 'HEAD\x00evil', 'a'.repeat(300)]) {
    await assert.rejects(() => svc.history(cwd, { ref }), (e) => e?.status === 400, ref);
  }
  await assert.rejects(() => svc.history(cwd, { ref: 'no-such-branch-xyz' }), (e) => e?.status === 404);
  await assert.rejects(() => svc.history(cwd, { limit: 0 }), (e) => e?.status === 400);
  await assert.rejects(() => svc.history(cwd, { limit: 'zzz' }), (e) => e?.status === 400);
  await assert.rejects(() => svc.history(cwd, { offset: -1 }), (e) => e?.status === 400);
  await assert.rejects(() => svc.history(join(root, 'elsewhere'), {}), (e) => e?.status === 404);
  // Empty repository fails closed (no HEAD yet).
  const fresh = await makeRepo();
  t.after(() => rm(fresh.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const svc2 = serviceFor([fresh.cwd]);
  await assert.rejects(() => svc2.history(fresh.cwd, {}), (e) => e?.status === 404);
});

test('commit detail covers root, merge, rename, binary and deletion', async (t) => {
  const { root, cwd, c1, merge, renameSha, binSha, delSha } = await richRepo();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const svc = serviceFor([cwd]);

  const rootDetail = await svc.commitInfo(cwd, c1);
  assert.equal(rootDetail.hash, c1);
  assert.equal(rootDetail.parents.length, 0);
  assert.equal(rootDetail.subject, 'first');
  assert.ok(rootDetail.files.some((f) => f.path === 'a.txt' && f.status === 'A'));

  const merged = await svc.commitInfo(cwd, merge);
  assert.ok(merged.parents.length >= 1);
  assert.ok(merged.files.some((f) => f.path === 'feature.txt'));

  const renamed = await svc.commitInfo(cwd, renameSha);
  const entry = renamed.files.find((f) => f.path === 'renamed.txt');
  assert.ok(entry);
  assert.equal(entry.status, 'R');
  assert.equal(entry.oldPath, 'a.txt');

  const binary = await svc.commitInfo(cwd, binSha);
  const blob = binary.files.find((f) => f.path === 'bin.dat');
  assert.ok(blob);
  assert.equal(blob.binary, true);
  assert.equal(blob.additions, null);
  assert.equal(blob.deletions, null);
  assert.ok(binary.stats.additions >= 0 && binary.stats.files >= 1);

  const deleted = await svc.commitInfo(cwd, delSha);
  assert.ok(deleted.files.some((f) => f.path === 'deleteme.txt' && f.status === 'D'));

  await assert.rejects(() => svc.commitInfo(cwd, 'short'), (e) => e?.status === 400);
  await assert.rejects(
    () => svc.commitInfo(cwd, '0'.repeat(40)),
    (e) => e?.status === 404,
  );
});

test('commit-diff returns bounded inert patch and guards paths', async (t) => {
  const { root, cwd, merge, renameSha, binSha } = await richRepo();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const svc = serviceFor([cwd]);

  const diff = await svc.commitDiff(cwd, merge, 'feature.txt');
  assert.equal(diff.path, 'feature.txt');
  assert.equal(diff.binary, false);
  assert.equal(diff.truncated, false);
  assert.ok(diff.patch.includes('+feat'));

  const renameDiff = await svc.commitDiff(cwd, renameSha, 'renamed.txt');
  assert.equal(renameDiff.path, 'renamed.txt');
  assert.ok(renameDiff.patch.length > 0);

  const blob = await svc.commitDiff(cwd, binSha, 'bin.dat');
  assert.equal(blob.binary, true);
  assert.equal(blob.patch, '');

  await assert.rejects(() => svc.commitDiff(cwd, merge, 'missing.txt'), (e) => e?.status === 404);
  await assert.rejects(() => svc.commitDiff(cwd, 'nope', 'feature.txt'), (e) => e?.status === 400);
  for (const bad of ['../evil.txt', '/abs.txt', '', '.git/config', 'node_modules/x']) {
    await assert.rejects(() => svc.commitDiff(cwd, merge, bad), (e) => e?.status === 400 || e?.status === 403, bad);
  }
});

test('commit-diff truncates huge patches', async (t) => {
  const { root, cwd } = await makeRepo();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const svc = serviceFor([cwd]);
  const big = Array.from({ length: 6000 }, (_, i) => `line ${i} with some content to inflate the diff`).join('\n') + '\n';
  const sha = await commitFile(cwd, 'big.txt', big, 'big file');
  const diff = await svc.commitDiff(cwd, sha, 'big.txt');
  assert.equal(diff.binary, false);
  assert.equal(diff.truncated, true);
  assert.ok(Buffer.byteLength(diff.patch, 'utf8') < 6000 * 60);
});

test('native worktree list includes linked worktrees', async (t) => {
  const { root, cwd } = await makeRepo();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await commitFile(cwd, 'a.txt', 'one\n', 'first');
  const svc = serviceFor([cwd]);
  const linked = join(root, 'linked');
  await git(cwd, ['worktree', 'add', '--quiet', linked, '-b', 'linked-branch']);
  await writeFile(join(linked, 'dirty.txt'), 'dirty\n', 'utf8');
  await writeFile(join(cwd, 'untracked.txt'), 'untracked\n', 'utf8');

  const listed = await svc.nativeWorktrees(cwd);
  assert.ok(listed.currentPath);
  assert.equal(listed.worktrees.length, 2);
  const current = listed.worktrees.find((w) => w.isCurrent);
  assert.ok(current);
  assert.equal(current.branch, 'main');
  assert.match(current.head, /^[0-9a-f]{40}$/);
  assert.equal(current.dirty, true);
  const other = listed.worktrees.find((w) => !w.isCurrent);
  assert.equal(other.branch, 'linked-branch');
  // Unmanaged roots are never status-probed: dirty stays unknown.
  assert.equal(other.dirty, undefined);
  assert.equal(other.bare, false);
  assert.equal(other.detached, false);
  assert.equal(other.managed, undefined);

  // Verified managed entries do get a bounded dirty check.
  const managed = await svc.nativeWorktrees(cwd, { isManaged: async () => true });
  assert.equal(managed.worktrees.find((w) => !w.isCurrent).dirty, true);

  await assert.rejects(() => svc.nativeWorktrees(join(root, 'missing')), (e) => e?.status === 404);
});

test('selected commit treats glob-like names literally', async (t) => {
  const { root, cwd } = await makeRepo();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await commitFile(cwd, 'a.txt', 'one\n', 'first');
  await commitFile(cwd, 'b.txt', 'one\n', 'first');
  await commitFile(cwd, '[ab].txt', 'one\n', 'first');
  const svc = serviceFor([cwd]);
  for (const name of ['a.txt', 'b.txt', '[ab].txt']) {
    await writeFile(join(cwd, name), 'two\n', 'utf8');
    await git(cwd, ['add', name]);
  }
  await svc.commit(cwd, { message: 'literal only', paths: ['[ab].txt'] });
  const names = (await git(cwd, ['show', '--name-only', '--pretty=format:', 'HEAD']))
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  assert.deepEqual(names, ['[ab].txt']);
});

test('suggest-message works on verified task roots with stub model', async (t) => {
  const { root, cwd } = await makeRepo();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await commitFile(cwd, 'a.txt', 'one\n', 'first');
  await writeFile(join(cwd, 'a.txt'), 'two\n', 'utf8');
  const taskPath = join(root, 'task-cwd');
  await mkdir(taskPath, { recursive: true });
  const { createProjectGitSuggest } = await import('../lib/project-git-suggest.mjs');
  const store = {
    findProject: async (value) => {
      if (value === cwd) return { cwd };
      const error = new HttpError(404, 'missing');
      throw error;
    },
  };
  const filesFor = () => createProjectFiles({ store, protectedRoots: [] });
  const suggest = createProjectGitSuggest({
    store,
    filesFor,
    resolveProject: async (value) => (value === taskPath ? { cwd } : store.findProject(value)),
  });
  const out = await suggest.suggestMessage(
    taskPath,
    { paths: ['a.txt'] },
    { complete: async () => 'feat: stub message', subjects: ['first'] },
  );
  assert.equal(out.message, 'feat: stub message');
});

test('selected-only commit leaves unrelated staged files intact', async (t) => {
  const { root, cwd } = await makeRepo();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await commitFile(cwd, 'a.txt', 'one\n', 'first');
  const svc = serviceFor([cwd]);
  // Unrelated file staged by another flow; selected commit must not sweep it in.
  await writeFile(join(cwd, 'selected.txt'), 'v1\n', 'utf8');
  await git(cwd, ['add', 'selected.txt']);
  await writeFile(join(cwd, 'selected.txt'), 'v2\n', 'utf8');
  await writeFile(join(cwd, 'other.txt'), 'other\n', 'utf8');
  await git(cwd, ['add', 'other.txt']);

  await svc.commit(cwd, { message: 'selected only', paths: ['selected.txt'] });
  const names = (await git(cwd, ['show', '--name-only', '--pretty=format:', 'HEAD']))
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  assert.ok(names.includes('selected.txt'));
  assert.ok(!names.includes('other.txt'));
  const staged = (await git(cwd, ['diff', '--cached', '--name-only']))
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  assert.ok(staged.includes('other.txt'));
});

test('http routes: history/commit/diff/worktrees on project, task and readonly gateway', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'prime-studio-git-http-'));
  const cwd = join(root, 'proj');
  const sessionDir = join(root, 'sessions');
  await mkdir(cwd, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await git(root, ['init', '--quiet', '-b', 'main', 'proj']);
  await git(cwd, ['config', 'user.name', 'Test']);
  await git(cwd, ['config', 'user.email', 'test@example.com']);
  await git(cwd, ['config', 'commit.gpgsign', 'false']);
  await git(cwd, ['config', 'core.autocrlf', 'false']);
  await commitFile(cwd, 'a.txt', 'one\n', 'first');
  const head = await git(cwd, ['rev-parse', 'HEAD']);

  const runtime = { run: () => {}, activeRuns: () => [], onChanged: () => {}, async close() {} };
  const app = createApp({
    agentHome: join(root, 'agent'),
    sessionDir,
    dataDir: join(root, 'data'),
    initialCwd: cwd,
    runtime,
  });
  await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
  const port = app.server.address().port;
  const get = (path) =>
    new Promise((resolve, reject) => {
      request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
        let raw = '';
        res.on('data', (d) => { raw += d; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(raw); } catch {}
          resolve({ status: res.statusCode, json });
        });
      })
        .on('error', reject)
        .end();
    });
  const post = (path, body) =>
    new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        },
        (res) => {
          let raw = '';
          res.on('data', (d) => { raw += d; });
          res.on('end', () => {
            let json = null;
            try { json = JSON.parse(raw); } catch {}
            resolve({ status: res.statusCode, json });
          });
        },
      );
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  t.after(async () => {
    try { await app.close(); } catch {}
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const at = (p, q) => `/api/project-git/${p}?cwd=${encodeURIComponent(q)}`;
  const history = await get(`${at('history', cwd)}&limit=10`);
  assert.equal(history.status, 200);
  assert.equal(history.json.ref, head);
  assert.equal(history.json.commits.length, 1);
  assert.equal(history.json.commits[0].subject, 'first');

  const detail = await get(`${at('commit', cwd)}&hash=${head}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.hash, head);
  assert.ok(detail.json.files.some((f) => f.path === 'a.txt'));

  const patch = await get(`${at('commit-diff', cwd)}&hash=${head}&path=${encodeURIComponent('a.txt')}`);
  assert.equal(patch.status, 200);
  assert.ok(patch.json.patch.includes('+one'));

  const native = await get(at('worktrees', cwd));
  assert.equal(native.status, 200);
  assert.equal(native.json.worktrees.length, 1);
  assert.equal(native.json.worktrees[0].isCurrent, true);
  assert.equal(native.json.worktrees[0].managed, false);

  // Managed task worktree: same Git APIs must work on the verified task cwd.
  const created = await post('/api/worktrees', { cwd, name: 'task1' });
  assert.equal(created.status, 201);
  const taskPath = created.json.worktree.path;
  assert.ok(taskPath && taskPath !== cwd);
  const taskHistory = await get(`${at('history', taskPath)}&limit=5`);
  assert.equal(taskHistory.status, 200);
  assert.equal(taskHistory.json.ref, head);
  const enriched = await get(at('worktrees', taskPath));
  assert.equal(enriched.status, 200);
  assert.ok(enriched.json.worktrees.length >= 2);
  const owned = enriched.json.worktrees.find((w) => w.path === taskPath);
  assert.ok(owned);
  assert.equal(owned.managed, true);
  assert.ok(owned.id);
  assert.equal(owned.dirty, false);

  // Unknown roots fail closed at the HTTP layer too.
  assert.equal((await get(`${at('history', join(root, 'nope'))}&limit=5`)).status, 404);

  // Read-only gateway keeps the new GETs, still refuses writes.
  const { createLanGateway, hashAccessCode } = await import('../lib/lan.mjs');
  const salt = 'e54d6dd09bb15f7c347b38b671472aa9';
  const gateway = createLanGateway({
    host: '127.0.0.1',
    upstreamPort: port,
    config: { salt, codeHash: hashAccessCode('86420975', salt), readOnly: true },
  });
  await new Promise((done) => gateway.listen(0, '127.0.0.1', done));
  const gwPort = gateway.address().port;
  t.after(async () => {
    gateway.closeAllConnections();
    await new Promise((done, reject) => gateway.close((e) => (e ? reject(e) : done())));
  });
  const gw = (path, options = {}) =>
    new Promise((resolve, reject) => {
      const isPost = options.method === 'POST';
      const data = isPost ? JSON.stringify(options.body || {}) : null;
      const req = request(
        {
          host: '127.0.0.1',
          port: gwPort,
          path,
          method: options.method || 'GET',
          headers: {
            ...(options.headers || {}),
            ...(isPost
              ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
              : {}),
          },
        },
        (res) => {
          let raw = '';
          res.on('data', (d) => { raw += d; });
          res.on('end', () => {
            let json = null;
            try { json = JSON.parse(raw); } catch {}
            resolve({ status: res.statusCode, json, headers: res.headers });
          });
        },
      );
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  const rawLogin = await new Promise((resolve, reject) => {
    const data = new URLSearchParams({ code: '86420975' }).toString();
    const req = request(
      {
        host: '127.0.0.1',
        port: gwPort,
        path: '/lan/login',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) },
      },
      (res) => {
        let raw = '';
        res.on('data', (d) => { raw += d; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
  assert.equal(rawLogin.status, 303);
  const cookie = rawLogin.headers['set-cookie'][0].split(';')[0];
  const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
  const roHistory = await gw(`${at('history', cwd)}&limit=5`, { headers });
  assert.equal(roHistory.status, 200);
  assert.equal(roHistory.json.commits.length, 1);
  const roWorktrees = await gw(at('worktrees', cwd), { headers });
  assert.equal(roWorktrees.status, 200);
  const refused = await gw('/api/project-git/commit', { method: 'POST', headers, body: { cwd } });
  assert.equal(refused.status, 405);
});
