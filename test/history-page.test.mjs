import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createApp } from '../server.mjs';
import { encodeHistoryCursor } from '../lib/history-page.mjs';

const userMessage = (id, parentId, text) => ({
  type: 'message',
  id,
  parentId,
  timestamp: '2026-09-04T00:01:00.000Z',
  message: { role: 'user', content: text },
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'prime-studio-history-page-'));
  const cwd = join(root, 'project');
  const sessionDir = join(root, 'sessions');
  const dataDir = join(root, 'local');
  const agentHome = join(root, 'agent');
  await Promise.all([mkdir(cwd), mkdir(sessionDir), mkdir(agentHome)]);
  const header = (id) => ({ type: 'session', id, cwd, timestamp: '2026-09-04T00:00:00.000Z' });
  const writeSession = async (id, entries) => {
    await writeFile(
      join(sessionDir, `${id}.jsonl`),
      [header(id), ...entries].map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    );
  };
  // Linear parent chain: all entries stay on the selected branch.
  const chain = (prefix, count, start = 0) => {
    const entries = [];
    let parent = start === 0 ? null : `${prefix}-${start - 1}`;
    for (let i = start; i < start + count; i++) {
      const id = `${prefix}-${i}`;
      entries.push(userMessage(id, parent, `note ${id}`));
      parent = id;
    }
    return entries;
  };
  await writeSession('paged', chain('u', 10));
  await writeSession('other', chain('o', 3));
  await writeSession('empty', []);
  await writeSession('tooled', [
    userMessage('t-user', null, 'run the check'),
    {
      type: 'message',
      id: 't-assistant',
      parentId: 't-user',
      timestamp: '2026-09-04T00:02:00.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'checking now' },
          { type: 'toolCall', id: 'tool-1', name: 'shell', arguments: { command: 'echo hi' } },
        ],
      },
    },
    {
      type: 'message',
      id: 't-result',
      parentId: 't-assistant',
      timestamp: '2026-09-04T00:03:00.000Z',
      message: { role: 'toolResult', content: 'hi', toolCallId: 'tool-1', toolName: 'shell' },
    },
  ]);
  const runtime = {
    async getStatus() {
      return { available: false, version: null };
    },
    async getModels() {
      return { models: [], default: null };
    },
    async close() {},
  };
  const app = createApp({ agentHome, sessionDir, dataDir, initialCwd: cwd, runtime });
  await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
  const port = app.server.address().port;
  t.after(async () => {
    await app.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  function raw(path, { headers = {} } = {}) {
    return new Promise((done, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path, method: 'GET', headers }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () =>
          done({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }),
        );
      });
      req.on('error', reject);
      req.end();
    });
  }
  const get = async (path, options) => {
    const response = await raw(path, options);
    let json = null;
    try {
      json = JSON.parse(response.body.toString('utf8'));
    } catch {}
    return { ...response, json };
  };
  const appendUserMessage = async (sessionId, id, parentId, text) => {
    await appendFile(
      join(sessionDir, `${sessionId}.jsonl`),
      JSON.stringify(userMessage(id, parentId, text)) + '\n',
    );
  };
  return { raw, get, appendUserMessage, sessionDir };
}

test('unpaged history stays FULL with no historyPage key', async (t) => {
  const f = await fixture(t);
  const response = await f.get('/api/history?id=paged');
  assert.equal(response.status, 200);
  assert.equal('file' in response.json, false);
  assert.equal('historyPage' in response.json, false);
  assert.equal(response.json.messages.length, 10);
  assert.deepEqual(
    response.json.messages.map((m) => m.id),
    Array.from({ length: 10 }, (_, i) => `u-${i}`),
  );
  assert.equal(response.json.messageCount, 10);
  assert.ok(response.json.readState);
});

test('limit returns the newest messages plus historyPage metadata', async (t) => {
  const f = await fixture(t);
  const full = (await f.get('/api/history?id=paged')).json;
  const page = await f.get('/api/history?id=paged&limit=4');
  assert.equal(page.status, 200);
  assert.deepEqual(
    page.json.messages.map((m) => m.id),
    ['u-6', 'u-7', 'u-8', 'u-9'],
  );
  // Paginated messages are identical to the matching FULL slice.
  assert.deepEqual(page.json.messages, full.messages.slice(6, 10));
  assert.deepEqual(page.json.historyPage, {
    total: 10,
    limit: 4,
    start: 6,
    end: 10,
    hasBefore: true,
    beforeCursor: page.json.historyPage.beforeCursor,
  });
  assert.equal(typeof page.json.historyPage.beforeCursor, 'string');
  // All non-message session fields stay FULL authoritative.
  assert.equal(page.json.messageCount, 10);
  assert.deepEqual(page.json.readState, full.readState);
  assert.equal(page.json.title, full.title);
  assert.equal(page.json.id, 'paged');
  assert.equal('file' in page.json, false);
});

test('deterministic before-pages reconstruct the FULL history', async (t) => {
  const f = await fixture(t);
  const full = (await f.get('/api/history?id=paged')).json;
  const newest = (await f.get('/api/history?id=paged&limit=4')).json;
  const middle = (await f.get(`/api/history?id=paged&limit=4&before=${newest.historyPage.beforeCursor}`))
    .json;
  assert.deepEqual(
    middle.messages.map((m) => m.id),
    ['u-2', 'u-3', 'u-4', 'u-5'],
  );
  assert.equal(middle.historyPage.total, 10);
  assert.equal(middle.historyPage.hasBefore, true);
  const first = (await f.get(`/api/history?id=paged&limit=4&before=${middle.historyPage.beforeCursor}`)).json;
  assert.deepEqual(
    first.messages.map((m) => m.id),
    ['u-0', 'u-1'],
  );
  assert.equal(first.historyPage.hasBefore, false);
  assert.equal(first.historyPage.beforeCursor, null);
  assert.deepEqual([...first.messages, ...middle.messages, ...newest.messages], full.messages);
  // Paged reads never mutate the source: FULL fetch is unchanged after paging.
  assert.deepEqual((await f.get('/api/history?id=paged')).json, full);
});

test('limit at or above total returns everything with hasBefore false', async (t) => {
  const f = await fixture(t);
  const full = (await f.get('/api/history?id=paged')).json;
  const page = await f.get('/api/history?id=paged&limit=200');
  assert.equal(page.status, 200);
  assert.deepEqual(page.json.messages, full.messages);
  assert.equal(page.json.historyPage.total, 10);
  assert.equal(page.json.historyPage.hasBefore, false);
  assert.equal(page.json.historyPage.beforeCursor, null);
});

test('appends between pages cause no duplication or skips', async (t) => {
  const f = await fixture(t);
  const newest = (await f.get('/api/history?id=paged&limit=4')).json;
  const cursor = newest.historyPage.beforeCursor;
  await f.appendUserMessage('paged', 'u-10', 'u-9', 'note u-10');
  await f.appendUserMessage('paged', 'u-11', 'u-10', 'note u-11');
  // The pre-append cursor still anchors by message id, not offset.
  const middle = await f.get(`/api/history?id=paged&limit=4&before=${cursor}`);
  assert.equal(middle.status, 200);
  assert.deepEqual(
    middle.json.messages.map((m) => m.id),
    ['u-2', 'u-3', 'u-4', 'u-5'],
  );
  assert.equal(middle.json.historyPage.total, 12);
  const fresh = (await f.get('/api/history?id=paged&limit=4')).json;
  assert.deepEqual(
    fresh.messages.map((m) => m.id),
    ['u-8', 'u-9', 'u-10', 'u-11'],
  );
  // A full backward walk after the appends rebuilds all 12 messages exactly once.
  const seen = [...fresh.messages];
  let page = fresh;
  while (page.historyPage.hasBefore) {
    page = (await f.get(`/api/history?id=paged&limit=4&before=${page.historyPage.beforeCursor}`)).json;
    seen.unshift(...page.messages);
  }
  const full = (await f.get('/api/history?id=paged')).json;
  assert.equal(full.messages.length, 12);
  assert.deepEqual(seen, full.messages);
});

test('invalid limits are rejected with 400', async (t) => {
  const f = await fixture(t);
  for (const limit of ['0', '-1', 'abc', '1.5', '201', '1000000', '', '9999999999999999999999', '80x']) {
    const response = await f.get(`/api/history?id=paged&limit=${limit}`);
    assert.equal(response.status, 400, `limit=${limit}`);
  }
});

test('before without limit is rejected with 400', async (t) => {
  const f = await fixture(t);
  const newest = (await f.get('/api/history?id=paged&limit=4')).json;
  const response = await f.get(`/api/history?id=paged&before=${newest.historyPage.beforeCursor}`);
  assert.equal(response.status, 400);
});

test('malformed cursors are rejected with 400', async (t) => {
  const f = await fixture(t);
  const newest = (await f.get('/api/history?id=paged&limit=4')).json;
  const truncated = newest.historyPage.beforeCursor.slice(0, 8);
  const notJson = Buffer.from('just a string', 'utf8').toString('base64url');
  const wrongVersion = Buffer.from(JSON.stringify({ v: 2, sid: 'paged', mid: 'u-6' }), 'utf8').toString(
    'base64url',
  );
  const missingMid = Buffer.from(JSON.stringify({ v: 1, sid: 'paged' }), 'utf8').toString('base64url');
  for (const cursor of [
    '!!!',
    'not-a-cursor!!',
    'e30',
    truncated,
    notJson,
    wrongVersion,
    missingMid,
    'a'.repeat(3000),
  ]) {
    const response = await f.get(`/api/history?id=paged&limit=4&before=${cursor}`);
    assert.equal(response.status, 400, cursor.slice(0, 40));
  }
});

test('cursor from another session is rejected with 400', async (t) => {
  const f = await fixture(t);
  const newest = (await f.get('/api/history?id=paged&limit=4')).json;
  const response = await f.get(`/api/history?id=other&limit=4&before=${newest.historyPage.beforeCursor}`);
  assert.equal(response.status, 400);
});

test('stale boundary cursor fails with 409 for recovery', async (t) => {
  const f = await fixture(t);
  const stale = encodeHistoryCursor('paged', 'missing-message-id');
  const response = await f.get(`/api/history?id=paged&limit=4&before=${stale}`);
  assert.equal(response.status, 409);
  // A replaced boundary (history rewritten without the anchor) also fails 409.
  const newest = (await f.get('/api/history?id=paged&limit=4')).json;
  const kept = (await readFile(join(f.sessionDir, 'paged.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.id !== 'u-6');
  await writeFile(
    join(f.sessionDir, 'paged.jsonl'),
    kept.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
  );
  const replaced = await f.get(`/api/history?id=paged&limit=4&before=${newest.historyPage.beforeCursor}`);
  assert.equal(replaced.status, 409);
});

test('empty history pages to an empty list with null cursor', async (t) => {
  const f = await fixture(t);
  const full = await f.get('/api/history?id=empty');
  assert.equal(full.status, 200);
  assert.deepEqual(full.json.messages, []);
  assert.equal('historyPage' in full.json, false);
  const page = await f.get('/api/history?id=empty&limit=4');
  assert.equal(page.status, 200);
  assert.deepEqual(page.json.messages, []);
  assert.deepEqual(page.json.historyPage, {
    total: 0,
    limit: 4,
    start: 0,
    end: 0,
    hasBefore: false,
    beforeCursor: null,
  });
  const stale = encodeHistoryCursor('empty', 'missing-message-id');
  assert.equal((await f.get(`/api/history?id=empty&limit=4&before=${stale}`)).status, 409);
});

test('tool calls, results and counts survive pagination without deletion', async (t) => {
  const f = await fixture(t);
  const full = (await f.get('/api/history?id=tooled')).json;
  assert.equal(full.messages.length, 2);
  const newest = await f.get('/api/history?id=tooled&limit=1');
  assert.equal(newest.status, 200);
  assert.deepEqual(newest.json.messages, [full.messages[1]]);
  assert.equal(newest.json.messages[0].tools.length, 1);
  assert.equal(newest.json.messages[0].tools[0].result, 'hi');
  assert.equal(newest.json.messages[0].tools[0].status, 'done');
  const older = await f.get(`/api/history?id=tooled&limit=1&before=${newest.json.historyPage.beforeCursor}`);
  assert.equal(older.status, 200);
  assert.deepEqual(older.json.messages, [full.messages[0]]);
  assert.equal(older.json.historyPage.beforeCursor, null);
  assert.equal(newest.json.messageCount, full.messageCount);
  assert.deepEqual(newest.json.readState, full.readState);
});

test('paged history keeps the gzip path byte-identical after gunzip', async (t) => {
  const f = await fixture(t);
  const identity = await f.raw('/api/history?id=paged&limit=4');
  const compressed = await f.raw('/api/history?id=paged&limit=4', {
    headers: { 'Accept-Encoding': 'gzip' },
  });
  assert.equal(identity.status, 200);
  assert.equal(compressed.status, 200);
  // Small payload stays identity; large paged payloads still compress via historyJson.
  if (compressed.headers['content-encoding'] === 'gzip') {
    assert.deepEqual(gunzipSync(compressed.body), identity.body);
  } else {
    assert.deepEqual(compressed.body, identity.body);
  }
  assert.ok(JSON.parse(identity.body.toString('utf8')).historyPage);
});
