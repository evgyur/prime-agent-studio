import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createConversationSync, normalizeGitRemote } from '../lib/conversation-sync.mjs';
import { mergeEntries, parse, serialize } from '../lib/sync-merge.mjs';
import { discoverCli } from '../lib/agent.mjs';

function localStore(root) {
  return {
    async put(key, body) {
      const file = join(root, key);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file + '.tmp', body);
      await rename(file + '.tmp', file);
    },
    async get(key) {
      try {
        return await readFile(join(root, key));
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
    },
    async list(prefix) {
      try {
        return (await readdir(join(root, prefix))).filter((n) => !n.endsWith('.tmp')).map((n) => prefix + n);
      } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
      }
    },
  };
}

const zero = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const user = (text, image) => ({
  role: 'user',
  timestamp: Date.now(),
  content: [
    { type: 'text', text },
    ...(image ? [{ type: 'image', data: image, mimeType: 'image/png' }] : []),
  ],
});
const reply = (text) => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  api: 'openai-responses',
  provider: 'fixture',
  model: 'fixture',
  usage: zero,
  stopReason: 'stop',
  timestamp: Date.now(),
});
const pause = () => new Promise((r) => setTimeout(r, 15));
const URL_ = 'https://account.r2.cloudflarestorage.com/bucket';

async function createMachine(root, objectStore, active, name, projects) {
  const dataDir = join(root, name, 'data'),
    sessionDir = join(root, name, 'sessions');
  const list = [];
  for (const [project, sync, git] of projects) {
    const cwd = join(root, name, project);
    await mkdir(cwd, { recursive: true });
    if (git) {
      await mkdir(join(cwd, '.git'), { recursive: true });
      await writeFile(
        join(cwd, '.git', 'config'),
        `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${git}\n`,
      );
    }
    list.push({ cwd, name: project, sync, exists: true });
  }
  await mkdir(sessionDir, { recursive: true });
  const meta = {};
  const sessions = async () => {
    const out = [];
    for (const name of await readdir(sessionDir)) {
      const header = parse(await readFile(join(sessionDir, name), 'utf8'))[0];
      const info = await stat(join(sessionDir, name));
      out.push({
        id: header.id,
        cwd: header.cwd,
        file: join(sessionDir, name),
        updatedAt: info.mtime.toISOString(),
      });
    }
    return out;
  };
  const store = {
    overview: async () => {
      const all = await sessions();
      return { projects: list.map((p) => ({ ...p, sessions: all.filter((s) => s.cwd === p.cwd) })) };
    },
    history: async (id) => (await sessions()).find((s) => s.id === id),
    sessionMeta: (id) => ({ pinned: false, archived: false, metaAt: 0, ...meta[id] }),
    applySessionMeta: async (id, next) => {
      const current = meta[id] || {};
      let changed = false;
      if (next.metaAt > (current.metaAt || 0)) {
        meta[id] = { ...current, ...next, read: current.read, readAt: current.readAt };
        changed = true;
      }
      if ((next.readAt || 0) > (current.readAt || 0)) {
        meta[id] = { ...meta[id], read: next.read, readAt: next.readAt };
        changed = true;
      }
      return changed;
    },
    markRead: (id, read) => (meta[id] = { ...meta[id], read, readAt: Date.now() }),
    pin: (id, pinned) => (meta[id] = { ...meta[id], pinned, archived: false, metaAt: Date.now() }),
    setProjectSyncId: async (cwd, syncId) => {
      const p = list.find((x) => x.cwd === cwd);
      p.syncId = syncId;
      delete p.syncManual;
    },
    applyProjectColor: async (cwd, color, colorAt) => {
      const p = list.find((x) => x.cwd === cwd);
      if (!p) return false;
      if ((Number(colorAt) || 0) <= (Number(p.colorAt) || 0)) return false;
      if (color === '' || color === undefined || color === null) delete p.color;
      else p.color = color;
      p.colorAt = Number(colorAt) || 0;
      return true;
    },
    setColor: (project, color) => {
      const p = list.find((x) => x.name === project);
      if (color) p.color = color;
      else delete p.color;
      p.colorAt = Date.now();
    },
    link: (project, syncId) =>
      Object.assign(
        list.find((x) => x.name === project),
        { syncId, syncManual: true },
      ),
  };
  const { createRoadmapService } = await import('../lib/roadmap.mjs');
  const roadmap = createRoadmapService({
    resolveProject: async (cwd) => {
      const found = list.find((x) => x.cwd === cwd);
      if (!found) throw Object.assign(new Error('missing'), { status: 404, code: 'roadmap_missing' });
      return { cwd, name: found.name };
    },
  });
  const sync = createConversationSync({
    dataDir,
    sessionDir,
    store,
    objectStore,
    roadmap,
    isSessionActive: (id) => active.has(`${name}:${id}`),
  });
  const change = async (project, action, params = {}) => {
    const cwd = list.find((x) => x.name === project).cwd;
    const revision = (await roadmap.read(cwd)).revision;
    return roadmap.mutate(cwd, { action, expectedRevision: revision, ...params });
  };
  const readRaw = async (project) => roadmap.readRaw(list.find((x) => x.name === project).cwd);
  return {
    name,
    dataDir,
    sessionDir,
    store,
    roadmap,
    change,
    readRaw,
    cwd: (p) => list.find((x) => x.name === p).cwd,
    sync,
  };
}

test('merge keeps both offline branches, converges and remaps colliding short ids', () => {
  const t = (s) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
  const header = { type: 'session', id: 'S', cwd: '/p' };
  const base = [
    { id: 'a', parentId: null, timestamp: t(1) },
    { id: 'b', parentId: 'a', timestamp: t(2) },
  ];
  const mine = [...base, { id: 'c', parentId: 'b', timestamp: t(3), v: 'mine' }];
  const theirs = [
    ...base,
    { id: 'c', parentId: 'b', timestamp: t(4), v: 'theirs' },
    { id: 'd', parentId: 'c', timestamp: t(5) },
  ];
  const merged = mergeEntries([header, ...mine], theirs, 'd');
  assert.equal(merged.remapped, 1);
  assert.equal(merged.entries.length, 6);
  const last = merged.entries.at(-1);
  assert.equal(merged.active, last.id);
  const parent = merged.entries.find((e) => e.id === last.parentId);
  assert.equal(parent.v, 'theirs', 'remapped entry keeps its child chain');
  assert.equal(mergeEntries(merged.entries, theirs.slice(0, 2), 'b').added, 0, 'idempotent');
});

test('two machines sync through an encrypted passive store', async (t) => {
  const cli = discoverCli();
  if (!cli?.packageDir) return t.skip('Prime Agent engine unavailable');
  const { SessionManager } = await import(
    pathToFileURL(join(cli.packageDir, 'dist/core/session-manager.js')).href
  );
  const root = await mkdtemp(join(tmpdir(), 'studio-sync-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const objectStore = localStore(join(root, 'r2'));
  const active = new Set();
  const machine = (name, projects) => createMachine(root, objectStore, active, name, projects);
  const A = await machine('A', [['Projet'], ['Privé', false]]);
  const B = await machine('B', [['Projet'], ['Privé']]);
  const passphrase = 'correct horse battery staple';
  await A.sync.configure({
    url: URL_,
    accessKeyId: 'id',
    secretAccessKey: 'secret',
    passphrase,
    device: 'PC A',
  });
  await assert.rejects(
    B.sync.configure({
      url: URL_,
      accessKeyId: 'id',
      secretAccessKey: 'secret',
      passphrase: 'wrong passphrase!!',
    }),
    { status: 400 },
  );
  await B.sync.configure({
    url: URL_,
    accessKeyId: 'id',
    secretAccessKey: 'secret',
    passphrase,
    device: 'PC B',
  });
  const status = await A.sync.status();
  assert.equal(status.configured, true);
  assert.equal(JSON.stringify(status).includes('secret"'), false, 'secrets are never returned');
  assert.equal(status.hasSecret, true);

  const sm = SessionManager.create(A.cwd('Projet'), A.sessionDir);
  const image = randomBytes(120_000).toString('base64');
  sm.appendMessage(user('capture', image));
  sm.appendMessage(reply('vu'));
  const file = basename(sm.getSessionFile());
  const hidden = SessionManager.create(A.cwd('Privé'), A.sessionDir);
  hidden.appendMessage(user('privé'));
  hidden.appendMessage(reply('reste local'));
  const context = (m) =>
    SessionManager.open(join(m.sessionDir, file), m.sessionDir)
      .buildSessionContext()
      .messages.map((x) => JSON.stringify(x.content));

  const first = (await A.sync.run()).lastSync;
  assert.equal(first.ok, true);
  assert.equal(first.pushed, 2, 'only the synced project is sent');
  await B.sync.run();
  assert.deepEqual(context(B), context(A));
  assert.equal(parse(await readFile(join(B.sessionDir, file), 'utf8'))[0].cwd, B.cwd('Projet'));
  assert.deepEqual(await readdir(B.sessionDir), [file], 'opted-out project stays local');
  // Stored objects are encrypted: no plaintext text or image in the bucket.
  for (const name of await readdir(join(root, 'r2', 'objects'))) {
    const raw = await readFile(join(root, 'r2', 'objects', name));
    assert.equal(raw.includes('capture'), false);
    assert.equal(raw.includes(image.slice(0, 64)), false);
  }
  // Nothing changed: nothing sent. Same image again: only text is sent.
  assert.equal((await A.sync.run()).lastSync.sent, 0);
  const a = SessionManager.open(join(A.sessionDir, file), A.sessionDir);
  await pause();
  a.appendMessage(user('encore', image));
  await pause();
  a.appendMessage(reply('identique'));
  const delta = (await A.sync.run()).lastSync;
  assert.ok(delta.sent < 4096, `delta sent ${delta.sent} bytes`);
  await B.sync.run();
  // Both machines work offline, then converge on the newest branch.
  await pause();
  a.appendMessage(user('A hors ligne'));
  a.appendMessage(reply('A ok'));
  const b = SessionManager.open(join(B.sessionDir, file), B.sessionDir);
  await pause();
  b.appendMessage(user('B hors ligne'));
  b.appendMessage(reply('B ok'));
  await A.sync.run();
  await B.sync.run();
  await A.sync.run();
  assert.deepEqual(context(A), context(B));
  assert.match(context(A).at(-1), /B ok/);
  // A running conversation is never rewritten by a pull.
  const sid0 = parse(await readFile(join(A.sessionDir, file), 'utf8'))[0].id;
  active.add(`B:${sm.getSessionId?.() ?? parse(await readFile(join(A.sessionDir, file), 'utf8'))[0].id}`);
  await pause();
  a.appendMessage(user('pendant exécution'));
  a.appendMessage(reply('ok'));
  const before = await readFile(join(B.sessionDir, file), 'utf8');
  await A.sync.run();
  const skipped = (await B.sync.run()).lastSync;
  assert.equal(await readFile(join(B.sessionDir, file), 'utf8'), before);
  // On the PC running it, unsent changes read as "sent at turn end", not "to send".
  active.add(`A:${sid0}`);
  await pause();
  a.appendMessage(user('tour en cours'));
  const runningStatus = await A.sync.status();
  assert.equal(runningStatus.sessions[sid0], 'running');
  assert.equal(runningStatus.pending, 0);
  active.delete(`A:${sid0}`);
  a.appendMessage(reply('fin du tour'));
  await A.sync.run();
  assert.ok(skipped.skipped >= 1);
  active.clear();
  await B.sync.run();
  assert.deepEqual(context(B), context(A));
  // Status, pinned metadata and the quick per-conversation check.
  const sid = parse(await readFile(join(A.sessionDir, file), 'utf8'))[0].id;
  // State written by an older build (no ids/mtime): one run restores 'synced'.
  const statePath = join(A.dataDir, 'sync-state.json');
  const oldState = JSON.parse(await readFile(statePath, 'utf8'));
  await writeFile(
    statePath,
    JSON.stringify({ ...oldState, ids: undefined, mtime: undefined, meta: undefined }),
  );
  assert.equal((await A.sync.status()).sessions[sid], 'pending');
  assert.equal((await A.sync.run()).lastSync.sent, 0);
  assert.equal((await A.sync.status()).sessions[sid], 'synced');
  A.store.pin(sid, true);
  assert.equal((await A.sync.status()).sessions[sid], 'pending', 'local pin waits to be sent');
  assert.equal((await A.sync.checkSession(sid)).state, 'synced');
  const seen = await B.sync.checkSession(sid);
  assert.equal(seen.changed, true);
  assert.equal(B.store.sessionMeta(sid).pinned, true, 'pin arrives on the other PC');
  await pause();
  a.appendMessage(user('vérifiée à l’ouverture'));
  a.appendMessage(reply('ok'));
  await A.sync.checkSession(sid);
  assert.equal((await B.sync.checkSession(sid)).changed, true);
  assert.deepEqual(context(B), context(A));
  // A running full cycle never makes the quick check skip: it waits, then syncs.
  await pause();
  a.appendMessage(user('pendant un cycle complet'));
  a.appendMessage(reply('ok'));
  const cycle = A.sync.run();
  const during = await A.sync.checkSession(sid);
  await cycle;
  assert.equal(during.state, 'synced', 'checked after the cycle, not reported busy');
  assert.equal((await B.sync.checkSession(sid)).changed, true);
  assert.deepEqual(context(B), context(A));
  assert.equal((await B.sync.checkSession(sid)).changed, false);
  assert.equal((await A.sync.checkSession(hidden.getSessionId())).state, 'off');
  await A.sync.forget();
  assert.equal((await A.sync.status()).configured, false);
  // Reconnecting the same bucket keeps this PC's identity and sends nothing again.
  await A.sync.configure({
    url: URL_,
    accessKeyId: 'id',
    secretAccessKey: 'secret',
    passphrase,
    device: 'PC A',
  });
  const again = (await A.sync.run()).lastSync;
  assert.equal(again.sent, 0);
  assert.equal(again.received, 0);
  assert.equal((await readdir(join(root, 'r2', 'refs'))).length, 2, 'no orphan ref for the same PC');
});

test('git remotes normalize to the same project id', () => {
  for (const url of [
    'git@github.com:Me/Repo.git',
    'https://github.com/me/repo',
    'https://user:token@github.com/me/repo.git/',
    'ssh://git@github.com/me/repo.git',
  ])
    assert.equal(normalizeGitRemote(url), 'github.com/me/repo');
  assert.equal(normalizeGitRemote(''), null);
});

test('projects match across PCs by id, Git remote, then name, or an explicit link', async (t) => {
  const cli = discoverCli();
  if (!cli?.packageDir) return t.skip('Prime Agent engine unavailable');
  const { SessionManager } = await import(
    pathToFileURL(join(cli.packageDir, 'dist/core/session-manager.js')).href
  );
  const root = await mkdtemp(join(tmpdir(), 'studio-sync-link-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const objectStore = localStore(join(root, 'r2'));
  const A = await createMachine(root, objectStore, new Set(), 'A', [
    ['Alpha', true, 'git@github.com:me/repo.git'],
    ['Beta'],
    ['Delta'],
  ]);
  const B = await createMachine(root, objectStore, new Set(), 'B', [
    ['Renamed', true, 'https://github.com/me/repo'],
    ['Beta'],
    ['Other'],
  ]);
  const config = {
    url: URL_,
    accessKeyId: 'id',
    secretAccessKey: 'secret',
    passphrase: 'correct horse battery staple',
  };
  await A.sync.configure({ ...config, device: 'PC A' });
  await B.sync.configure({ ...config, device: 'PC B' });
  const talk = (m, project, text) => {
    const sm = SessionManager.create(m.cwd(project), m.sessionDir);
    sm.appendMessage(user(text));
    sm.appendMessage(reply(`${text} ok`));
    return sm.getSessionId();
  };
  const alpha = talk(A, 'Alpha', 'alpha'),
    beta = talk(A, 'Beta', 'beta'),
    delta = talk(A, 'Delta', 'delta');
  await A.sync.run();
  await B.sync.run();
  const headers = async (m) =>
    Object.fromEntries(
      await Promise.all(
        (await readdir(m.sessionDir)).map(async (f) => {
          const h = parse(await readFile(join(m.sessionDir, f), 'utf8'))[0];
          return [h.id, h.cwd];
        }),
      ),
    );
  let onB = await headers(B);
  assert.equal(onB[alpha], B.cwd('Renamed'), 'same Git remote, different name');
  assert.equal(onB[beta], B.cwd('Beta'), 'same name');
  assert.equal(onB[delta], undefined, 'no match: stays available');
  const status = await B.sync.status();
  assert.equal(status.projectLinks[B.cwd('Renamed')].via, 'git');
  assert.equal(status.projectLinks[B.cwd('Beta')].via, 'name');
  const remoteDelta = status.remoteProjects.find((p) => p.name === 'Delta');
  assert.equal(remoteDelta.local, null);
  assert.deepEqual(remoteDelta.devices, ['PC A']);
  assert.equal(remoteDelta.sessions, 1);
  // Explicit link: a differently named project receives the remote conversations.
  B.store.link('Other', remoteDelta.id);
  await B.sync.run();
  onB = await headers(B);
  assert.equal(onB[delta], B.cwd('Other'));
  assert.equal((await B.sync.status()).projectLinks[B.cwd('Other')].via, 'manual');
  // Ids are stable: B's new conversations land in A's projects too.
  const back = talk(B, 'Renamed', 'retour');
  await B.sync.run();
  await A.sync.run();
  assert.equal((await headers(A))[back], A.cwd('Alpha'));
});

test('read state follows the conversation to the other PC, including after an upgrade', async (t) => {
  const cli = discoverCli();
  if (!cli?.packageDir) return t.skip('Prime Agent engine unavailable');
  const { SessionManager } = await import(
    pathToFileURL(join(cli.packageDir, 'dist/core/session-manager.js')).href
  );
  const root = await mkdtemp(join(tmpdir(), 'studio-sync-read-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const objectStore = localStore(join(root, 'r2'));
  const A = await createMachine(root, objectStore, new Set(), 'A', [['Projet']]);
  const B = await createMachine(root, objectStore, new Set(), 'B', [['Projet']]);
  const config = {
    url: URL_,
    accessKeyId: 'id',
    secretAccessKey: 'secret',
    passphrase: 'correct horse battery staple',
  };
  await A.sync.configure({ ...config, device: 'PC A' });
  await B.sync.configure({ ...config, device: 'PC B' });
  const sm = SessionManager.create(A.cwd('Projet'), A.sessionDir);
  sm.appendMessage(user('question'));
  sm.appendMessage(reply('réponse'));
  const sid = sm.getSessionId();
  const answer = sm.getEntries().at(-1).id;
  await A.sync.run();
  await B.sync.run();
  // Read on A: B shows it read after A's quick check and B's next check.
  A.store.markRead(sid, answer);
  assert.equal((await A.sync.status()).sessions[sid], 'pending');
  await A.sync.checkSession(sid);
  assert.equal((await A.sync.status()).sessions[sid], 'synced');
  assert.equal((await B.sync.checkSession(sid)).changed, true);
  assert.equal(B.store.sessionMeta(sid).read, answer);
  // Mark unread on B travels back.
  await new Promise((r) => setTimeout(r, 5));
  B.store.markRead(sid, '');
  await B.sync.run();
  await A.sync.run();
  assert.equal(A.store.sessionMeta(sid).read, '');
  // State written before read sync (no metaFormat): unchanged sessions resend metadata once.
  const statePath = join(A.dataDir, 'sync-state.json');
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  await writeFile(statePath, JSON.stringify({ ...saved, metaFormat: undefined }));
  const upgrade = (await A.sync.run()).lastSync;
  assert.ok(upgrade.sent > 0 && upgrade.pushed === 0, 'metadata only, no message resent');
  assert.equal((await A.sync.run()).lastSync.sent, 0, 'once only');
});

test('roadmaps sync three-way with plan colors, project colors and device colors', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-sync-roadmap-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const objectStore = localStore(join(root, 'r2'));
  const active = new Set();
  const machine = (name, projects) => createMachine(root, objectStore, active, name, projects);
  const A = await machine('A', [['Projet']]);
  const B = await machine('B', [['Projet']]);
  const config = {
    url: URL_,
    accessKeyId: 'id',
    secretAccessKey: 'secret',
    passphrase: 'correct horse battery staple',
  };
  await A.sync.configure({ ...config, device: 'PC A', color: '#0891b2' });
  await B.sync.configure({ ...config, device: 'PC B', color: '#c026d3' });
  assert.equal((await A.sync.status()).color, '#0891b2');
  // The panel's swatches send the color alone: it must not need the full configuration.
  await A.sync.configure({ color: '#ca8a04' });
  assert.equal((await A.sync.status()).color, '#ca8a04');
  assert.equal((await A.sync.status()).configured, true);
  await assert.rejects(A.sync.configure({ color: '#3b82f6' }), { status: 400 });
  await A.sync.configure({ color: '#0891b2' });

  // Roadmap created on A arrives on B with backlog ids.
  await A.change('Projet', 'init');
  const created = await A.change('Projet', 'plan.create', { title: 'Plan partage' });
  const planId = created.plans[0].id;
  await A.change('Projet', 'backlog.add', { items: [{ text: 'Idée' }] });
  const first = (await A.sync.run()).lastSync;
  assert.equal(first.roadmapsSent, 1);
  await B.sync.run();
  const onB = await B.readRaw('Projet');
  assert.equal(onB.plans[0].title, 'Plan partage');
  assert.ok(onB.backlog.items[0].id, 'stable id generated on first sync');
  assert.ok(onB.backlog.items[0].updatedAt, 'updatedAt generated on first sync');
  const second = (await B.sync.run()).lastSync;
  assert.equal(second.roadmapsSent, 0, 'unchanged roadmap is not pushed again');

  // Offline edits on both sides merge: newest plan wins, both backlog items kept.
  await A.change('Projet', 'plan.patch', { planId, title: 'Plan A' });
  await new Promise((r) => setTimeout(r, 5));
  await B.change('Projet', 'plan.patch', { planId, title: 'Plan B' });
  await B.change('Projet', 'backlog.add', { items: [{ text: 'Ajout B' }] });
  await A.sync.run();
  await B.sync.run();
  await A.sync.run();
  const afterA = await A.readRaw('Projet');
  const afterB = await B.readRaw('Projet');
  assert.equal(afterA.plans[0].title, 'Plan B', 'newest timestamp wins');
  assert.equal(afterB.plans[0].title, 'Plan B');
  assert.equal(afterA.backlog.items.length, 2, 'both backlog additions kept');
  assert.equal(afterB.backlog.items.length, 2);

  // Plan color change travels with the plan.
  await A.change('Projet', 'plan.patch', { planId, color: '#0d9488' });
  await A.sync.run();
  await B.sync.run();
  assert.equal((await B.readRaw('Projet')).plans[0].color, '#0d9488');
  await B.change('Projet', 'plan.patch', { planId, color: '' });
  await B.sync.run();
  await A.sync.run();
  assert.equal((await A.readRaw('Projet')).plans[0].color, undefined);

  // Project color: newest colorAt wins across PCs.
  A.store.setColor('Projet', '#3b82f6');
  await A.sync.run();
  await B.sync.run();
  assert.equal((await B.store.overview()).projects[0].color, '#3b82f6');
  assert.ok((await B.store.overview()).projects[0].colorAt > 0);

  // Devices list carries both PCs with colors, sessionDevices maps the origin.
  const header = { type: 'session', id: 'conv-1', cwd: A.cwd('Projet') };
  const t0 = new Date(Date.UTC(2026, 0, 1)).toISOString();
  await writeFile(
    join(A.sessionDir, 'conv-1.jsonl'),
    serialize([header, { id: 'm1', parentId: null, timestamp: t0 }]),
  );
  await A.sync.run();
  await B.sync.run();
  const statusB = await B.sync.status();
  const names = new Map(statusB.devices.map((d) => [d.name, d]));
  assert.equal(names.get('PC A').color, '#0891b2');
  assert.equal(names.get('PC B').color, '#c026d3');
  assert.equal(names.get('PC B').self, true);
  const idA = statusB.devices.find((d) => d.name === 'PC A').id;
  assert.ok(idA, 'remote device id present');
  assert.equal(statusB.sessionDevices['conv-1'], idA, 'origin is the pushing PC');
  const statusA = await A.sync.status();
  const selfA = statusA.devices.find((d) => d.self).id;
  assert.equal(statusA.sessionDevices['conv-1'], selfA, 'local push reads as self');
  // Re-publishing the same leaf (read state on B) must not steal the origin:
  // both PCs keep A as the origin, on every later cycle.
  const lastId = 'm1';
  B.store.markRead('conv-1', lastId);
  await B.sync.run();
  await A.sync.run();
  await B.sync.run();
  await A.sync.run();
  assert.equal((await B.sync.status()).sessionDevices['conv-1'], idA, 'B still shows PC A');
  assert.equal((await A.sync.status()).sessionDevices['conv-1'], selfA, 'A still shows itself');
  // A new turn written on B moves the origin to B on both PCs.
  await writeFile(
    join(B.sessionDir, 'conv-1.jsonl'),
    serialize([
      { ...header, cwd: B.cwd('Projet') },
      { id: 'm1', parentId: null, timestamp: t0 },
      { id: 'm2', parentId: 'm1', timestamp: new Date(Date.UTC(2026, 0, 2)).toISOString() },
    ]),
  );
  await B.sync.run();
  await A.sync.run();
  const idB = (await B.sync.status()).devices.find((d) => d.self).id;
  assert.equal((await A.sync.status()).sessionDevices['conv-1'], idB);
  assert.equal((await B.sync.status()).sessionDevices['conv-1'], idB);
  // A backlog reorder on one PC reaches the other (it used to keep its own order).
  await A.change('Projet', 'backlog.add', { items: [{ text: 'Troisième' }] });
  await A.sync.run();
  await B.sync.run();
  const numbers = (doc) => doc.backlog.items.map((e) => e.number);
  const before = numbers(await A.readRaw('Projet'));
  assert.deepEqual(numbers(await B.readRaw('Projet')), before);
  await new Promise((r) => setTimeout(r, 5));
  await A.change('Projet', 'backlog.move', { number: before.at(-1), targetNumber: before[0], position: 'before' });
  const moved = numbers(await A.readRaw('Projet'));
  assert.notDeepEqual(moved, before);
  await A.sync.run();
  await B.sync.run();
  assert.deepEqual(numbers(await B.readRaw('Projet')), moved, 'reorder propagates');
  await A.sync.run();
  assert.deepEqual(numbers(await A.readRaw('Projet')), moved, 'and stays on A');
});

