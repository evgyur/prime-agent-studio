// Isolated paged-history + windowed live-stream regression. No product edits.
// Real createApp server + MOCK runtime. No native model/CLI, no user Studio.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect } from '@playwright/test';
import { createApp } from '../server.mjs';
import { launchStudioBrowser } from './fixtures/browser.mjs';

const out = resolve('.local/dynamic-history');
await mkdir(out, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'studio-history-stream-'));
const cwd = join(temp, 'StreamFixture');
const sessionDir = join(temp, 'sessions');
await Promise.all([mkdir(cwd, { recursive: true }), mkdir(sessionDir, { recursive: true })]);

const UPPER = 'stream-upper';
const LOWER = 'stream-lower';
const UPPER_N = 300;
const LOWER_N = 20;
const STREAM_PROMPT = 'Stream the paged window probe.';
const FOLLOW_TOKEN = 'STREAM-FOLLOW-42';
const DETACH_TOKEN = 'STREAM-DETACHED-77';
const MARKER_A = 'STREAM-BUFFER-A-11';
const MARKER_B = 'STREAM-BUFFER-B-22';
const FINAL_TOKEN = 'STREAM-FINAL-99';
const para = (token, n) =>
  Array.from({ length: n }, () => `${token} live line of the streaming answer.\n\n`).join('');

const rowsUpper = [{ type: 'session', id: UPPER, cwd, timestamp: '2026-10-01T12:00:00Z' }];
for (let i = 0; i < UPPER_N; i++)
  rowsUpper.push({
    type: 'message',
    id: `${UPPER}-${i}`,
    parentId: i ? `${UPPER}-${i - 1}` : UPPER,
    timestamp: new Date(1790856000000 + i * 1000).toISOString(),
    message: {
      role: i % 2 ? 'assistant' : 'user',
      stopReason: 'stop',
      content:
        `STREAM HISTORY ${i}\n\n` + 'Saved **content** with an inline `value`. No model call.\n\n'.repeat(2),
    },
  });
const rowsLower = [{ type: 'session', id: LOWER, cwd, timestamp: '2026-10-01T12:00:00Z' }];
for (let i = 0; i < LOWER_N; i++)
  rowsLower.push({
    type: 'message',
    id: `${LOWER}-${i}`,
    parentId: i ? `${LOWER}-${i - 1}` : LOWER,
    timestamp: new Date(1790856000000 + i * 1000).toISOString(),
    message: {
      role: i % 2 ? 'assistant' : 'user',
      stopReason: 'stop',
      content: `LOWER HISTORY ${i}\n\nQuiet side pane.\n\n`,
    },
  });
await writeFile(join(sessionDir, `${UPPER}.jsonl`), rowsUpper.map(JSON.stringify).join('\n') + '\n');
await writeFile(join(sessionDir, `${LOWER}.jsonl`), rowsLower.map(JSON.stringify).join('\n') + '\n');

const startInputs = [];
const controls = new Map();
let modelCalls = 0;
const runtime = {
  getStatus: async () => ({ available: true, version: 'fixture' }),
  getModels: async () => ({
    models: [{ id: 'fixture/model', name: 'Fixture', provider: 'fixture' }],
    default: { model: 'fixture/model' },
  }),
  async start(input) {
    startInputs.push({
      cwd: input.cwd,
      message: input.message,
      sessionId: input.sessionId,
      sessionFile: input.sessionFile || null,
      model: input.model || null,
      keys: Object.keys(input).sort(),
    });
    let resolveDone;
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });
    let liveText = '';
    const control = {
      done,
      emit: (event) => {
        if (event?.kind === 'text' && typeof event.delta === 'string') liveText += event.delta;
        input.onEvent(event);
      },
      async finish(status = 'completed', text = `${FINAL_TOKEN} complete.`) {
        // Native fidelity: the saved answer is the FULL streamed text.
        const full = liveText + (liveText.endsWith('\n\n') ? '' : '\n\n') + text;
        control.savedText = full;
        const now = new Date().toISOString();
        const userId = `${UPPER}-live-user`;
        const assistantId = `${UPPER}-live-assistant`;
        await appendFile(
          join(sessionDir, `${input.sessionId}.jsonl`),
          [
            {
              type: 'message',
              id: userId,
              parentId: `${UPPER}-${UPPER_N - 1}`,
              timestamp: now,
              message: { role: 'user', content: STREAM_PROMPT },
            },
            {
              type: 'message',
              id: assistantId,
              parentId: userId,
              timestamp: now,
              message: { role: 'assistant', stopReason: 'stop', content: full },
            },
          ]
            .map(JSON.stringify)
            .join('\n') + '\n',
        );
        if (status === 'completed')
          input.onEvent({
            kind: 'message',
            message: { role: 'assistant', text: full, tools: [], stopReason: 'stop' },
          });
        const event = { kind: 'done', sessionId: input.sessionId, status, code: 0 };
        input.onEvent(event);
        resolveDone(event);
      },
      cancel() {
        const event = { kind: 'done', sessionId: input.sessionId, status: 'stopped', code: 130 };
        input.onEvent(event);
        resolveDone(event);
      },
    };
    controls.set(input.sessionId, control);
    input.onEvent({ kind: 'session', sessionId: input.sessionId, cwd: input.cwd });
    input.onEvent({ kind: 'message_start', role: 'assistant' });
    return { done: control.done, cancel: () => control.cancel() };
  },
  async close() {},
};
const app = createApp({
  initialCwd: cwd,
  sessionDir,
  dataDir: join(temp, 'data'),
  agentHome: join(temp, 'agent'),
  commands: { list: async () => ({ commands: [] }) },
  runtime,
});

let browser, page;
const errors = [],
  history = [],
  checks = [];
const proof = {};
const check = (name) => {
  checks.push(name);
  console.log('PASS', name);
};
const gapOf = (locator) => locator.evaluate((s) => s.scrollHeight - s.clientHeight - s.scrollTop);
const anchorOf = (scroller) =>
  scroller.evaluate((s) => {
    const box = s.getBoundingClientRect();
    const nodes = [...s.querySelectorAll('[data-message-id]')];
    const node = nodes.find((n) => {
      const b = n.getBoundingClientRect();
      return b.bottom > box.top + 10 && b.top < box.bottom;
    });
    return node
      ? { id: node.dataset.messageId, top: node.getBoundingClientRect().top - box.top, scroll: s.scrollTop }
      : null;
  });
const anchorTop = (scroller, id) =>
  scroller.evaluate((s, mid) => {
    const node = [...s.querySelectorAll('[data-message-id]')].find((n) => n.dataset.messageId === mid);
    return node ? node.getBoundingClientRect().top - s.getBoundingClientRect().top : null;
  }, id);
const mountedIds = (root) =>
  root.evaluate((r) =>
    [...r.children]
      .filter((n) => n.hasAttribute && n.hasAttribute('data-message-id'))
      .map((n) => n.dataset.messageId),
  );
const textCount = (root, token) =>
  root.evaluate((r, t) => ((r.innerText || '').match(new RegExp(t, 'g')) || []).length, token);

try {
  await app.store.project({ cwd });
  await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  browser = await launchStudioBrowser();
  const context = await browser.newContext({
    viewport: { width: 1680, height: 1500 },
    locale: 'fr-FR',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  await context.addInitScript(
    ({ cwd }) => {
      const group = (id, panel) => ({ kind: 'group', id, panels: [panel], active: panel });
      localStorage.setItem(
        'prime-studio.selection',
        JSON.stringify({ cwd, sessionId: 'stream-upper', projectOverview: false }),
      );
      localStorage.setItem(
        'prime-studio.docking.layout',
        JSON.stringify({
          version: 3,
          enabled: true,
          root: {
            kind: 'split',
            id: 'outer',
            dir: 'row',
            ratio: 0.78,
            first: {
              kind: 'split',
              id: 'vertical',
              dir: 'column',
              ratio: 0.5,
              first: group('top', 'conversation'),
              second: group('bottom', 'conv:lower'),
            },
            second: group('right', 'session'),
          },
        }),
      );
      localStorage.setItem(
        'prime-studio.docking.conversations',
        JSON.stringify({
          version: 1,
          activeId: 'conversation',
          entries: [
            {
              id: 'conversation',
              kind: 'session',
              nonce: 'stream-upper',
              sessionId: 'stream-upper',
              projectCwd: cwd,
              execCwd: cwd,
              viewRunId: null,
              gen: null,
            },
            {
              id: 'conv:lower',
              kind: 'session',
              nonce: 'stream-lower',
              sessionId: 'stream-lower',
              projectCwd: cwd,
              execCwd: cwd,
              viewRunId: null,
              gen: null,
            },
          ],
        }),
      );
    },
    { cwd },
  );
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', async (response) => {
    const parsed = new URL(response.url());
    if (parsed.pathname !== '/api/history') return;
    try {
      const body = await response.json();
      history.push({
        t: Date.now(),
        id: parsed.searchParams.get('id'),
        before: (parsed.searchParams.get('before') || '').slice(0, 12),
        limit: parsed.searchParams.get('limit'),
        status: response.status(),
        count: body.messages?.length,
        page: body.historyPage,
      });
    } catch {}
  });
  await context.route('**/*', (route) =>
    route.request().url().startsWith(url) ? route.continue() : route.abort(),
  );
  await page.goto(url);

  const upper = page.locator('#messages');
  const lower = page.locator('.cvw-messages').last();
  const upperScroll = page.locator('#conversation-scroll');
  const upperInput = page.locator('#composer');
  const lowerInput = page.locator('[data-cvw="composer"]');
  const olderButton = upper.getByRole('button', { name: 'Charger les messages précédents', exact: true });

  await expect(upper).toContainText(`STREAM HISTORY ${UPPER_N - 1}`, { timeout: 15000 });
  // Background pane: data completeness is the assertion (all 20 in one page);
  // snap it explicitly since unfocused panes have no force-scroll guarantee.
  await lower
    .evaluate((r) => {
      const s = r.closest('.cvw-scroller') || r.parentElement;
      if (s) s.scrollTop = s.scrollHeight;
    })
    .catch(() => {});
  await expect(lower).toContainText(`LOWER HISTORY ${LOWER_N - 1}`, { timeout: 15000 });
  await page.evaluate(() => (document.fonts ? document.fonts.ready : null)).catch(() => {});
  await page.waitForTimeout(500);
  assert.ok(
    history.filter((h) => h.status === 200).every((h) => h.limit === '80' && h.count <= 80),
    'initial UI requests must be limit=80 bounded',
  );
  assert.ok(history.some((h) => h.id === UPPER && h.page?.total === UPPER_N));
  assert.ok((await upper.locator(':scope > .message').count()) <= 80);
  const fullBefore = await (await fetch(`${url}/api/history?id=${UPPER}`)).json();
  assert.equal(fullBefore.messages.length, UPPER_N);
  assert.equal(fullBefore.historyPage, undefined);
  assert.ok(fullBefore.messages[0].text.includes('STREAM HISTORY 0'));
  const prefixBefore = fullBefore.messages.slice(0, 5).map((m) => m.id);
  proof.prefixBefore = prefixBefore;
  proof.totalBefore = fullBefore.messages.length;
  check('initial /api/history fetches limit=80 bounded; saved source prefix unchanged');

  // Start a real live run from the primary pane UI (real server SSE path).
  await page.locator('[data-dock-tab="conversation"]').click();
  const allow = page.locator('#allow-questions');
  if (await allow.count()) await allow.check().catch(() => {});
  await upperInput.fill(STREAM_PROMPT);
  await page.locator('#send-button').click();
  await expect.poll(() => controls.has(UPPER), { timeout: 15000 }).toBe(true);
  const control = controls.get(UPPER);
  await page.evaluate(() => (document.fonts ? document.fonts.ready : null)).catch(() => {});
  assert.equal(startInputs.length, 1);
  assert.equal(startInputs[0].sessionId, UPPER);
  assert.equal(startInputs[0].message, STREAM_PROMPT);
  assert.ok(
    !startInputs[0].keys.includes('messages') &&
      !startInputs[0].keys.includes('history') &&
      !startInputs[0].keys.includes('base'),
    `engine context must be sessionId+prompt only, got ${startInputs[0].keys}`,
  );
  proof.startKeys = startInputs[0].keys;
  check('run context is same sessionId+prompt only; UI cache never passed as engine context');
  // Live streaming follows the bottom (primary still focused: scroll-test-like). (No pre-delta bottom assert: windowed
  // spacers are estimates until the first streamed paint is measured.)
  control.emit({ kind: 'text', delta: para(FOLLOW_TOKEN, 15) });
  await expect(upper).toContainText(FOLLOW_TOKEN, { timeout: 15000 });
  await expect.poll(() => gapOf(upperScroll), { timeout: 30000 }).toBeLessThan(3);
  await expect(page.locator('#scroll-bottom')).toBeHidden();
  await page.screenshot({ path: join(out, 'stream-follow.png') });
  // Other-pane draft/focus from here on (covers detach, older-page, reconnect, completion).
  await lowerInput.fill('lower draft stays');
  await lowerInput.click();
  check('live streaming follows bottom');

  // Detach, then more streaming keeps the SAME visible anchor offset <3px.
  await upperScroll.hover();
  await page.mouse.wheel(0, -60);
  await expect.poll(() => gapOf(upperScroll)).toBeGreaterThan(30);
  const detached = await anchorOf(upperScroll);
  assert.ok(detached?.id, 'visible anchor while detached');
  const heldTop = await upperScroll.evaluate((s) => s.scrollTop);
  control.emit({ kind: 'text', delta: para(DETACH_TOKEN, 15) });
  await expect(upper).toContainText(DETACH_TOKEN, { timeout: 15000 });
  assert.equal(await upperScroll.evaluate((s) => s.scrollTop), heldTop);
  await expect(page.locator('#scroll-bottom')).toBeVisible();
  const heldAfter = await anchorTop(upperScroll, detached.id);
  assert.ok(
    heldAfter !== null && Math.abs(heldAfter - detached.top) < 3,
    `detached anchor moved: ${JSON.stringify({ detached, heldAfter })}`,
  );
  proof.detachedAnchor = {
    ...detached,
    heldAfter,
    drift: heldAfter === null ? null : Math.abs(heldAfter - detached.top),
  };
  await page.screenshot({ path: join(out, 'stream-detached.png') });
  check('detached streaming keeps same visible anchor offset <3px');

  // Older page during the live run: live output kept, no dup, other pane intact.
  const liveKept = await upper.evaluate((r, t) => (r.innerText || '').includes(t), DETACH_TOKEN);
  assert.ok(liveKept);
  const beforePages = history.filter((h) => h.id === UPPER && h.before && h.status === 200).length;
  await upperScroll.hover();
  await page.mouse.wheel(0, -100000);
  await expect
    .poll(() => history.filter((h) => h.id === UPPER && h.before && h.status === 200).length, {
      timeout: 15000,
    })
    .toBeGreaterThan(beforePages);
  const latestPage = history.filter((h) => h.id === UPPER && h.before && h.status === 200).at(-1);
  proof.olderDuringLive = {
    start: latestPage.page.start,
    end: latestPage.page.end,
    hasBefore: latestPage.page.hasBefore,
  };
  // Windowed renderer only mounts the visible slice: the live tail stays in
  // data (bottom spacer) while reading older pages. Prove the base grew,
  // then scroll back to the bottom to prove live output was not dropped.
  assert.ok(
    latestPage.page.start < 220,
    `older page must extend base backwards, got start=${latestPage.page.start}`,
  );
  await expect(upper).toContainText('STREAM HISTORY', { timeout: 10000 });
  const ids = await mountedIds(upper);
  assert.equal(new Set(ids).size, ids.length, 'live + older pages must not duplicate ids');
  assert.ok(ids.length <= 160, `windowed mount must stay bounded, got ${ids.length}`);
  await upperScroll.evaluate((s) => {
    s.scrollTop = s.scrollHeight;
  });
  await expect(upper).toContainText(DETACH_TOKEN, { timeout: 10000 });
  await expect(upper).toContainText(FOLLOW_TOKEN, { timeout: 10000 });
  await expect(lowerInput).toHaveValue('lower draft stays');
  await expect(lowerInput).toBeFocused();
  await expect(lower).toContainText(`LOWER HISTORY ${LOWER_N - 1}`);
  const fullDuring = await (await fetch(`${url}/api/history?id=${UPPER}`)).json();
  assert.equal(
    fullDuring.messages.length,
    UPPER_N,
    'source file unchanged while live (completion not yet written)',
  );
  assert.deepEqual(
    fullDuring.messages.slice(0, 5).map((m) => m.id),
    prefixBefore,
  );
  check('older page during live keeps live output without dup; other-pane draft/focus unchanged');

  // Controlled offline/online SSE reconnect: each buffered marker exactly once.
  await context.setOffline(true);
  await page.waitForTimeout(800);
  control.emit({ kind: 'text', delta: para(MARKER_A, 1) });
  control.emit({ kind: 'text', delta: para(MARKER_B, 1) });
  await page.waitForTimeout(800);
  await context.setOffline(false);
  await expect(upper).toContainText(MARKER_A, { timeout: 20000 });
  await expect(upper).toContainText(MARKER_B, { timeout: 20000 });
  assert.equal(await textCount(upper, MARKER_A), 1, 'buffered marker A must replay exactly once');
  assert.equal(await textCount(upper, MARKER_B), 1, 'buffered marker B must replay exactly once');
  await expect(lowerInput).toHaveValue('lower draft stays');
  await expect(upper).toContainText(DETACH_TOKEN);
  check('offline/online SSE replay gives each buffered marker once; drafts kept');

  // Completion writes canonical native ids; the done-triggered UI paged reload
  // must preserve a detached reader (<3px), with no wheel in between.
  await upperScroll.hover();
  await page.mouse.wheel(0, -800);
  await expect.poll(() => gapOf(upperScroll), { timeout: 10000 }).toBeGreaterThan(30);
  // Anchor to the live answer block itself: the reload replaces its transient
  // id with the canonical native id, but the full streamed text is identical
  // (native fidelity), so a correct renderer keeps the same visible offset.
  const preAnchor = await upper.evaluate((r, token) => {
    const s = r.closest('#conversation-scroll') || r;
    const box = s.getBoundingClientRect();
    const blocks = [...r.children].filter(
      (n) => n.hasAttribute && n.hasAttribute('data-message-id') && (n.innerText || '').includes(token),
    );
    const node = blocks[0] || null;
    return node
      ? { id: node.dataset.messageId, top: node.getBoundingClientRect().top - box.top, scroll: s.scrollTop }
      : null;
  }, DETACH_TOKEN);

  assert.ok(preAnchor?.id, 'detached live anchor before completion');
  proof.preAnchor = { ...preAnchor, gap: await gapOf(upperScroll) };
  const reloadsBefore = history.filter(
    (h) => h.id === UPPER && !h.before && h.status === 200 && h.page?.total === UPPER_N + 2,
  ).length;
  await control.finish('completed', `${FINAL_TOKEN} complete. All live markers above are saved.`);
  await expect(page.locator('#stop-button')).toBeHidden({ timeout: 15000 });
  // File-level canonical persistence first (always evidence, even if UI anchor fails).
  const rawJsonl = await readFile(join(sessionDir, `${UPPER}.jsonl`), 'utf8');
  const lines = rawJsonl
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const msgs = lines.filter((l) => l.type === 'message');
  assert.equal(msgs.length, UPPER_N + 2);
  assert.equal(msgs[msgs.length - 2].id, `${UPPER}-live-user`);
  assert.equal(msgs[msgs.length - 1].id, `${UPPER}-live-assistant`);
  assert.equal(msgs[msgs.length - 1].parentId, `${UPPER}-live-user`);
  assert.ok(msgs[msgs.length - 1].message.content.includes(FINAL_TOKEN));
  assert.ok(
    msgs[msgs.length - 1].message.content.includes(DETACH_TOKEN),
    'saved answer must keep the full streamed text',
  );
  assert.equal(new Set(msgs.map((m) => m.id)).size, msgs.length);
  proof.exportAfter = { count: msgs.length, lastIds: msgs.slice(-3).map((m) => m.id) };
  // Done-triggered paged reload of the detached view (newest page, grown total).
  await expect
    .poll(
      () =>
        history.filter(
          (h) => h.id === UPPER && !h.before && h.status === 200 && h.page?.total === UPPER_N + 2,
        ).length,
      { timeout: 15000 },
    )
    .toBeGreaterThan(reloadsBefore);
  // Let any preserveReading backfill settle without touching the viewport.
  for (let i = 0; i < 10; i++) {
    const n = history.filter((h) => h.id === UPPER && h.status === 200).length;
    await page.waitForTimeout(300);
    if (history.filter((h) => h.id === UPPER && h.status === 200).length === n) break;
  }
  const probe = await page.evaluate((uid) => {
    const root = document.querySelector('#messages');
    const scroller = document.querySelector('#conversation-scroll');
    return {
      scrollTop: scroller?.scrollTop,
      height: scroller?.scrollHeight,
      client: scroller?.clientHeight,
      topIds: [...(root?.children || [])]
        .filter((x) => x.hasAttribute && x.hasAttribute('data-message-id'))
        .map((x) => x.dataset.messageId),
      hasCanonical: !!root?.querySelector(`[data-message-id="${uid}"]`),
      hasTransientLive: [...(root?.querySelectorAll('[data-message-id]') || [])]
        .map((x) => x.dataset.messageId)
        .filter((id) => /-2$/.test(id)),
    };
  }, `${UPPER}-live-assistant`);
  proof.postReloadProbe = probe;
  // Completion replaces the transient run id with the canonical saved id.
  // Measure the same answer, without requiring stale transient DOM to survive.
  const canonicalId = `${UPPER}-live-assistant`;
  const preAfter = await anchorTop(upperScroll, canonicalId);
  const canonicalPainted = await upper.evaluate(
    (r, uid) => !!r.querySelector(`[data-message-id="${uid}"]`),
    canonicalId,
  );
  proof.canonicalPaintedAfterBackgroundCompletion = canonicalPainted;
  assert.ok(canonicalPainted, 'completed answer must use its canonical saved id');
  await expect(upper.locator(`[data-message-id="${preAnchor.id}"]`)).toHaveCount(0);
  assert.ok(
    preAfter !== null && Math.abs(preAfter - preAnchor.top) < 3,
    `paged reload moved reading anchor: ${JSON.stringify({ preAnchor, preAfter })}`,
  );
  proof.readAnchor = {
    ...preAnchor,
    readAfter: preAfter,
    drift: preAfter === null ? null : Math.abs(preAfter - preAnchor.top),
  };
  await upperScroll.evaluate((s) => {
    s.scrollTop = s.scrollHeight;
  });
  await expect(upper).toContainText(FINAL_TOKEN, { timeout: 15000 });
  // The giant answer fills this viewport. Older rows remain reachable by scrolling.
  await upperScroll.hover();
  await page.mouse.wheel(0, -100000);
  await expect(upper).toContainText('STREAM HISTORY', { timeout: 10000 });
  await upperScroll.hover();
  await page.mouse.wheel(0, 100000);
  await expect(upper).toContainText(FINAL_TOKEN);
  await expect(lower).toContainText(`LOWER HISTORY ${LOWER_N - 1}`);
  await expect(lowerInput).toHaveValue('lower draft stays');
  const fullAfter = await (await fetch(`${url}/api/history?id=${UPPER}`)).json();
  assert.equal(fullAfter.messages.length, UPPER_N + 2);
  assert.equal(fullAfter.historyPage, undefined);
  assert.deepEqual(
    fullAfter.messages.slice(0, 5).map((m) => m.id),
    prefixBefore,
  );
  assert.ok(fullAfter.messages.at(-1).text.includes(FINAL_TOKEN));
  await page.screenshot({ path: join(out, 'stream-final.png') });
  check(
    'completion persists canonical native ids; paged reload keeps anchor <3px, latest accessible, no pane reset',
  );

  assert.deepEqual(errors, []);
  assert.equal(modelCalls, 0);
  console.log(
    JSON.stringify(
      {
        checks,
        history,
        errors,
        proof,
        startInputs: startInputs.map((s) => ({ sessionId: s.sessionId, message: s.message, keys: s.keys })),
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(out, 'stream-failure.png') }).catch(() => {});
    const dom = await page
      .evaluate(() => ({
        active: document.activeElement?.outerHTML?.slice(0, 500),
        panes: [...document.querySelectorAll('#messages, .cvw-messages')].map((r) => ({
          count: r.querySelectorAll('[data-message-id]').length,
          text: (r.innerText || '').slice(-500),
        })),
      }))
      .catch(() => null);
    await writeFile(
      join(out, 'stream-failure.json'),
      JSON.stringify({ error: String(error?.stack || error), dom, checks, history, errors, proof }, null, 2),
    );
  }
  throw error;
} finally {
  await writeFile(
    join(out, 'stream-proof.json'),
    JSON.stringify(
      {
        checks,
        history,
        errors,
        proof,
        modelCalls,
        startInputs: startInputs.map((s) => ({ sessionId: s.sessionId, message: s.message, keys: s.keys })),
      },
      null,
      2,
    ),
  );
  await browser?.close();
  await app.close();
  await rm(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}
