import test from 'node:test';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, appendFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createStore, validateDirectory } from '../lib/store.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'prime-studio-store-'));
  const options = {
    sessionDir: join(root, 'sessions'),
    dataDir: join(root, 'local'),
    initialCwd: join(root, 'projet é'),
  };
  await Promise.all([mkdir(options.sessionDir), mkdir(options.initialCwd)]);
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const store = createStore(options);
  async function native(id, entries, tail = '') {
    const directory = join(options.sessionDir, 'native-project');
    await mkdir(directory, { recursive: true });
    const file = join(directory, `2026-09-04T00-00-00_${id}.jsonl`);
    const header = { type: 'session', id, cwd: options.initialCwd, timestamp: '2026-09-04T00:00:00.000Z' };
    await writeFile(
      file,
      [header, ...entries].map((entry) => JSON.stringify(entry)).join('\n') + '\n' + tail,
    );
    return file;
  }
  return { root, options, store, native };
}

const message = (id, parentId, role, content, extra = {}) => ({
  type: 'message',
  id,
  parentId,
  timestamp: '2026-09-04T00:01:00.000Z',
  message: { role, content, ...extra },
});

test('removing a project persists across reload and native discovery, preserves files, and supports re-adding', async (t) => {
  const { store, native, options } = await fixture(t);
  const file = await native('kept-session', [message('kept', null, 'user', 'À conserver')]);
  const before = await readFile(file, 'utf8');
  await store.project({ cwd: options.initialCwd, pinned: true }, true);
  assert.equal((await store.overview()).projects[0].pinned, true);
  await store.removeProject(options.initialCwd);
  assert.deepEqual((await store.overview()).projects, []);
  const reopened = createStore(options);
  assert.deepEqual((await reopened.overview()).projects, []);
  assert.equal(await readFile(file, 'utf8'), before);
  assert.equal((await reopened.history('kept-session')).messages[0].text, 'À conserver');
  await reopened.project({ cwd: options.initialCwd });
  assert.equal((await reopened.overview()).projects[0].sessions[0].id, 'kept-session');
});

test('native history follows the selected branch and attaches tool results to their call', async (t) => {
  const { store, native } = await fixture(t);
  const usage = { input: 12, output: 30, totalTokens: 42, cost: { total: 0.001 } };
  await native(
    'native-session',
    [
      message('root', null, 'user', 'Original task'),
      message('abandoned', 'root', 'assistant', [{ type: 'text', text: 'Abandoned answer' }]),
      message('revised', 'root', 'user', [{ type: 'text', text: 'Use this branch' }]),
      message(
        'answer',
        'revised',
        'assistant',
        [
          { type: 'thinking', thinking: 'Read the source first.' },
          { type: 'text', text: 'Reading the source.' },
          { type: 'toolCall', id: 'tool-1', name: 'read', arguments: { path: 'source.js' } },
        ],
        { provider: 'openai', model: 'gpt-5.6-luna', usage: { input: 1 } },
      ),
      message('result', 'answer', 'toolResult', 'source contents', {
        toolCallId: 'tool-1',
        toolName: 'read',
      }),
      { type: 'model_change', id: 'model', parentId: 'result', provider: 'openai', modelId: 'gpt-5.6-luna' },
      { type: 'session_info', id: 'name', parentId: 'model', name: 'Native session name' },
      { type: 'child_usage_attributed', targetId: 'answer', aggregateUsage: usage },
    ],
    'not json\n{"type":"message"',
  );
  const history = await store.history('native-session');
  assert.equal(history.title, 'Native session name');
  assert.equal(history.model, 'openai/gpt-5.6-luna');
  assert.deepEqual(
    history.messages.map((entry) => entry.id),
    ['root', 'revised', 'answer'],
  );
  assert.equal(history.messages[0].text, 'Original task');
  assert.equal(history.messages[2].thinking, 'Read the source first.');
  assert.deepEqual(history.messages[2].usage, usage);
  assert.deepEqual(history.messages[2].tools, [
    {
      id: 'tool-1',
      name: 'read',
      args: { path: 'source.js' },
      status: 'done',
      result: 'source contents',
      isError: false,
    },
  ]);
  const overview = await store.overview();
  const summary = overview.projects[0].sessions[0];
  assert.equal(summary.messageCount, 3);
  assert.equal('messages' in summary, false);
  assert.equal('file' in summary, false);
});

test('damaged JSON records and null content blocks do not make all native sessions unreadable', async (t) => {
  const { store, native } = await fixture(t);
  await native(
    'recoverable-session',
    [
      null,
      17,
      'unexpected primitive',
      [],
      message('user', null, 'user', [null, { type: 'text', text: 'Readable task' }]),
      message('assistant', 'user', 'assistant', [null, { type: 'text', text: 'Readable answer' }]),
    ],
    '{"unfinished":',
  );
  const history = await store.history('recoverable-session');
  assert.deepEqual(
    history.messages.map((entry) => entry.text),
    ['Readable task', 'Readable answer'],
  );
  assert.equal((await store.overview()).totalSessions, 1);
});

test('model metadata follows the active branch and the latest assistant model', async (t) => {
  const { store, native } = await fixture(t);
  await native('model-branch-session', [
    {
      type: 'model_change',
      id: 'model-initial',
      parentId: null,
      provider: 'openai',
      modelId: 'gpt-5.6-luna',
    },
    message('root', 'model-initial', 'user', 'Initial task'),
    {
      type: 'model_change',
      id: 'abandoned-model',
      parentId: 'root',
      provider: 'anthropic',
      modelId: 'abandoned-model',
    },
    message('abandoned-answer', 'abandoned-model', 'assistant', 'Old branch', {
      provider: 'anthropic',
      model: 'abandoned-model',
    }),
    message('revised', 'root', 'user', 'Take another branch'),
    message('active-answer', 'revised', 'assistant', 'Current answer', {
      provider: 'openai',
      model: 'gpt-5.6-sol',
    }),
  ]);
  const history = await store.history('model-branch-session');
  assert.equal(history.model, 'openai/gpt-5.6-sol');
  assert.deepEqual(
    history.messages.map((entry) => entry.id),
    ['root', 'revised', 'active-answer'],
  );
});

test('actual thinking follows the selected branch, preserves off and never invents an unknown level', async (t) => {
  const { store, native } = await fixture(t);
  await native('thinking-branch', [
    { type: 'thinking_level_change', id: 'initial', parentId: null, thinkingLevel: 'off' },
    message('root', 'initial', 'user', 'Task'),
    { type: 'thinking_level_change', id: 'abandoned', parentId: 'root', thinkingLevel: 'max' },
    message('discarded', 'abandoned', 'assistant', 'Discarded answer'),
    message('current', 'root', 'assistant', 'Current answer'),
  ]);
  assert.equal((await store.history('thinking-branch')).thinking, 'off');
  await native('thinking-unknown', [message('root', null, 'user', 'Old task')]);
  assert.equal((await store.history('thinking-unknown')).thinking, null);
});

test('standalone tool results, failed shell commands and visible native notes survive history projection', async (t) => {
  const { store, native } = await fixture(t);
  await native('tool-session', [
    {
      type: 'message',
      id: 'result',
      message: {
        role: 'toolResult',
        toolCallId: 'missing-call',
        toolName: 'read',
        content: [{ type: 'text', text: 'No such file' }],
        isError: true,
      },
    },
    {
      type: 'message',
      id: 'shell',
      message: { role: 'bashExecution', command: 'exit 1', output: 'failure', exitCode: 1 },
    },
    { type: 'compaction', id: 'compact', summary: 'Earlier context summary' },
    { type: 'message', id: 'note', message: { role: 'custom', content: 'Visible note', display: true } },
    { type: 'message', id: 'hidden', message: { role: 'custom', content: 'Hidden note', display: false } },
    {
      type: 'custom_message',
      id: 'native-note',
      content: 'Native extension note',
      display: true,
      customType: 'fixture',
    },
    {
      type: 'custom_message',
      id: 'native-hidden',
      content: 'Hidden extension note',
      display: false,
      customType: 'fixture',
    },
  ]);
  const { messages } = await store.history('tool-session');
  assert.equal(messages.length, 5);
  assert.equal(messages[0].tools[0].status, 'error');
  assert.equal(messages[0].tools[0].result, 'No such file');
  assert.equal(messages[1].tools[0].args.command, 'exit 1');
  assert.equal(messages[1].tools[0].isError, true);
  assert.equal(messages[2].text, 'Earlier context summary');
  assert.equal(messages[3].text, 'Visible note');
  assert.equal(messages[4].text, 'Native extension note');
});

test('local titles, pinning and archive status persist without rewriting the native session', async (t) => {
  const { options, store, native } = await fixture(t);
  const file = await native('metadata-session', [message('user', null, 'user', 'Original title')]);
  const before = await readFile(file, 'utf8');
  const updated = await store.patchSession({
    id: 'metadata-session',
    title: '  Renamed locally  ',
    pinned: true,
    archived: true,
  });
  assert.equal(updated.title, 'Renamed locally');
  assert.equal(updated.pinned, true);
  assert.equal('file' in updated, false);
  assert.equal(await readFile(file, 'utf8'), before);
  const reloaded = createStore(options);
  const history = await reloaded.history('metadata-session');
  assert.equal(history.title, 'Renamed locally');
  assert.equal(history.archived, true);
  assert.equal(history.pinned, true);
});

test('native files appended during a run refresh cached history and removed files disappear', async (t) => {
  const { store, native } = await fixture(t);
  const file = await native('growing-session', [message('user', null, 'user', 'First message')]);
  assert.equal((await store.history('growing-session')).messages.length, 1);
  await appendFile(file, JSON.stringify(message('answer', 'user', 'assistant', 'New answer')) + '\n');
  assert.equal((await store.history('growing-session')).messages.length, 2);
  await unlink(file);
  assert.equal((await store.overview()).totalSessions, 0);
  await assert.rejects(store.history('growing-session'), { status: 404 });
});

test('directory and session operations reject traversal, invalid types and nonexistent paths', async (t) => {
  const { root, options, store, native } = await fixture(t);
  const file = await native('validation-session', [message('user', null, 'user', 'Task')]);
  for (const id of ['../secrets', '..\\secrets', '/absolute', '', null, {}, 10]) {
    await assert.rejects(store.history(id), { status: 400 });
  }
  for (const cwd of ['relative/path', join(root, 'missing'), file, {}, 10, null]) {
    await assert.rejects(validateDirectory(cwd), { status: 400 });
  }
  await assert.rejects(store.project({ cwd: options.initialCwd, pinned: 'yes' }), { status: 400 });
  await assert.rejects(store.patchSession({ id: 'validation-session', archived: 'yes' }), { status: 400 });
  await assert.rejects(store.patchSession({ id: 'validation-session', title: '   ' }), { status: 400 });
});

test('context notices expose presentation metadata only and never raw native details', async (t) => {
  const { store, native } = await fixture(t);
  await native('context-metadata', [
    message('user', null, 'user', 'Task'),
    {
      type: 'compaction',
      id: 'compact',
      parentId: 'user',
      summary: 'Compacted text',
      timestamp: '2026-09-04T00:02:00.000Z',
    },
    {
      type: 'branch_summary',
      id: 'branch',
      parentId: 'compact',
      summary: 'Branch text',
      timestamp: '2026-09-04T00:03:00.000Z',
    },
    {
      type: 'custom_message',
      id: 'goal',
      parentId: 'branch',
      customType: 'goal_context',
      display: true,
      details: { kind: 'continuation', secret: 'MUST_NOT_LEAK' },
      content: '[goal: continuation]',
      timestamp: '2026-09-04T00:04:00.000Z',
    },
    {
      type: 'custom_message',
      id: 'budget',
      parentId: 'goal',
      customType: 'goal_context',
      display: true,
      details: { kind: 'budget_limit' },
      content: '[goal: budget-limit]',
      timestamp: '2026-09-04T00:05:00.000Z',
    },
    {
      type: 'custom_message',
      id: 'objective',
      parentId: 'budget',
      customType: 'goal_context',
      display: true,
      details: { kind: 'objective_updated' },
      content: '[goal: objective-updated]',
      timestamp: '2026-09-04T00:06:00.000Z',
    },
    {
      type: 'custom_message',
      id: 'unknown',
      parentId: 'objective',
      customType: 'goal_context',
      display: true,
      details: { kind: 'future_kind' },
      content: '[goal: future-kind]',
      timestamp: '2026-09-04T00:07:00.000Z',
    },
    {
      type: 'custom_message',
      id: 'legacy',
      parentId: 'unknown',
      customType: 'goal_context',
      display: true,
      content: '[goal: continuation]',
      timestamp: '2026-09-04T00:08:00.000Z',
    },
    {
      type: 'custom_message',
      id: 'other',
      parentId: 'legacy',
      customType: 'fixture',
      display: true,
      details: { kind: 'continuation' },
      content: 'Other notice',
      timestamp: '2026-09-04T00:09:00.000Z',
    },
    {
      type: 'message',
      id: 'nested-goal',
      parentId: 'other',
      message: {
        role: 'custom',
        customType: 'goal_context',
        display: true,
        details: { kind: 'continuation' },
        content: 'Nested continuation',
      },
      timestamp: '2026-09-04T00:10:00.000Z',
    },
    {
      type: 'message',
      id: 'nested-unknown',
      parentId: 'nested-goal',
      message: {
        role: 'custom',
        customType: 'goal_context',
        display: true,
        details: { kind: 'future_kind' },
        content: 'Nested unknown',
      },
      timestamp: '2026-09-04T00:11:00.000Z',
    },
  ]);
  const { messages } = await store.history('context-metadata');
  const byId = new Map(messages.map((entry) => [entry.id, entry]));
  assert.equal(byId.get('compact').customType, 'compaction');
  assert.equal(byId.get('compact').role, 'system');
  assert.equal(byId.get('branch').customType, 'branch_summary');
  assert.equal(byId.get('goal').customType, 'goal_context');
  assert.equal(byId.get('goal').contextKind, 'continuation');
  assert.equal(byId.get('budget').contextKind, 'budget_limit');
  assert.equal(byId.get('objective').contextKind, 'objective_updated');
  assert.equal('contextKind' in byId.get('unknown'), false);
  assert.equal('contextKind' in byId.get('legacy'), false);
  assert.equal('contextKind' in byId.get('other'), false);
  assert.equal(byId.get('nested-goal').contextKind, 'continuation');
  assert.equal('contextKind' in byId.get('nested-unknown'), false);
  for (const entry of messages) assert.equal('details' in entry, false);
});

test('project sync links: explicit, new, automatic and reset', async (t) => {
  const { store, options } = await fixture(t);
  const cwd = options.initialCwd;
  const id = '0f0e0d0c-0b0a-4908-8706-050403020100';
  await store.project({ cwd, syncId: id }, true);
  let p = (await store.overview()).projects[0];
  assert.deepEqual([p.syncId, p.syncManual], [id, true]);
  await store.project({ cwd, syncId: 'new' }, true);
  p = (await store.overview()).projects[0];
  assert.match(p.syncId, /^[0-9a-f-]{36}$/);
  assert.notEqual(p.syncId, id);
  await store.setProjectSyncId(cwd, id);
  p = (await store.overview()).projects[0];
  assert.deepEqual([p.syncId, p.syncManual], [id, undefined]);
  await store.project({ cwd, syncId: null }, true);
  assert.equal((await store.overview()).projects[0].syncId, undefined);
  await assert.rejects(store.project({ cwd, syncId: '../evil' }, true), { status: 400 });
});

test('remote read state: newest wins, untimed receipts only move forward', async (t) => {
  const { store, native } = await fixture(t);
  const thread = [
    message('u1', null, 'user', 'Q1'),
    message('a1', 'u1', 'assistant', [{ type: 'text', text: 'R1' }], { stopReason: 'stop' }),
    message('u2', 'a1', 'user', 'Q2'),
    message('a2', 'u2', 'assistant', [{ type: 'text', text: 'R2' }], { stopReason: 'stop' }),
  ];
  await native('read-old', thread);
  await store.overview(); // existing history starts read
  await native('read-new', thread); // arrives later, e.g. pulled from another PC: unread
  const read = async (id) =>
    (await store.overview()).projects[0].sessions.find((s) => s.id === id).readState.read;
  assert.equal(await read('read-new'), '');
  const base = store.sessionMeta('read-new');
  // Untimed (older build): forward only.
  assert.equal(await store.applySessionMeta('read-new', { ...base, read: 'a2', readAt: 0 }), true);
  assert.equal(await read('read-new'), 'a2');
  assert.equal(await store.applySessionMeta('read-old', { ...base, read: 'a1', readAt: 0 }), false);
  // Timed: newest action wins, including "mark unread".
  await store.applySessionMeta('read-new', { ...base, read: '', readAt: Date.now() + 1000 });
  assert.equal(await read('read-new'), '');
  assert.equal(await store.applySessionMeta('read-new', { ...base, read: 'a2', readAt: 5 }), false);
  await store.markRead({ id: 'read-old', answer: 'a2' }).catch(() => {});
  await store.markUnread({ id: 'read-old' });
  assert.ok(store.sessionMeta('read-old').readAt > 0);
});

test('conversation Git context and project HEAD are exposed for information', async (t) => {
  const { store, native, options } = await fixture(t);
  const commit = 'a'.repeat(40);
  await native('git-info', [
    message('u1', null, 'user', 'Q'),
    {
      type: 'git_state',
      id: 'g1',
      parentId: 'u1',
      timestamp: '2026-09-04T00:02:00.000Z',
      git: { branch: 'feature', commit, repoUrl: 'https://user:token@github.com/me/repo' },
    },
  ]);
  const git = join(options.initialCwd, '.git');
  await mkdir(join(git, 'refs', 'heads'), { recursive: true });
  await writeFile(join(git, 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(join(git, 'packed-refs'), `# pack\n${'b'.repeat(40)} refs/heads/main\n`);
  const project = (await store.overview()).projects[0];
  assert.deepEqual(project.sessions[0].git, {
    branch: 'feature',
    commit,
    repo: 'https://github.com/me/repo',
    at: '2026-09-04T00:02:00.000Z',
  });
  assert.deepEqual(project.gitHead, { branch: 'main', commit: 'b'.repeat(40) });
});

test('inspected artifact histories use a bounded LRU separate from the session listing', async (t) => {
  const f = await fixture(t);
  const dir = join(f.root, 'session-artifacts', 'root', 'children');
  await mkdir(dir, { recursive: true });
  const paths = Array.from({ length: 201 }, (_, i) => join(dir, `child-${i}.jsonl`));
  await Promise.all(paths.map((file, i) => writeFile(file, JSON.stringify({
    type: 'session', id: `child-${i}`, cwd: f.options.initialCwd,
  }) + '\n')));
  const oldest = await f.store.inspectFile(paths[0]);
  const retained = await f.store.inspectFile(paths[1]);
  for (const file of paths.slice(2, 200)) await f.store.inspectFile(file);
  assert.equal(await f.store.inspectFile(paths[1]), retained, 'cache hit refreshes recency');
  await f.store.inspectFile(paths[200]);
  await f.store.overview();
  assert.equal(await f.store.inspectFile(paths[1]), retained, 'normal directory scans preserve artifacts');
  assert.notEqual(await f.store.inspectFile(paths[0]), oldest, 'oldest artifact is evicted at 200 entries');
});

test('workspace initialization is single-flight and failed reads can retry', { timeout: 10000 }, async (t) => {
  const { store, options } = await fixture(t);
  const original = fsPromises.readFile;
  let calls = 0, release;
  const blocked = new Promise((done) => { release = done; });
  const read = t.mock.method(fsPromises, 'readFile', async (path, ...args) => {
    if (path !== join(options.dataDir, 'workspace.json')) return original(path, ...args);
    calls++;
    await blocked;
    return JSON.stringify({ projects: [], sessions: {}, preferences: { computerModel: 'saved/model' } });
  });
  syncBuiltinESMExports();
  t.after(() => { read.mock.restore(); syncBuiltinESMExports(); });
  const first = store.init(), second = store.init();
  try { assert.equal(calls, 1, 'concurrent callers must share one workspace read'); }
  finally { release(); await Promise.all([first, second]); }
  await store.setStudioPreferences({ computerModel: 'updated/model' });
  assert.equal((await store.getStudioPreferences()).computerModel, 'updated/model');
  assert.equal(calls, 1);
  read.mock.restore();
  let attempts = 0;
  const retryRead = t.mock.method(fsPromises, 'readFile', async (path, ...args) => {
    if (path === join(options.dataDir, 'workspace.json') && attempts++ === 0) throw Object.assign(new Error('fixture read failure'), { code: 'EIO' });
    return original(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { retryRead.mock.restore(); syncBuiltinESMExports(); });
  const retry = createStore(options);
  await assert.rejects(retry.init(), /fixture read failure/);
  await retry.init();
  assert.equal((await retry.getStudioPreferences()).computerModel, 'updated/model');
  assert.equal(attempts, 2);
});
