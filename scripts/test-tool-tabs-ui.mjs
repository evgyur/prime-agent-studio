// Isolated multi-instance tool-tabs UI proof (5 kinds × locks × reload).
//
// SCOPE: this file ONLY creates scripts/test-tool-tabs-ui.mjs plus its OWN
// runtime artifacts under .local/tool-panel-instances/ui-* (captures +
// proof + fixture-owned manifest). No other Studio source is edited, no
// existing UI test is touched (other workers own theirs).
// NEVER: production server, real provider account, real model, user Lab 62542,
// installed Studio, native CU, install/build/commit/publish. Seeding uses the
// real createApp fixture API plus normal UI input and a stub runtime (records
// starts, emits sessions synchronously on send, never streams a model).
// Captures are genuine screenshots only: never force hidden/classes/DOM state
// for visuals. page.evaluate is read-only (ids, storage, text, network
// tallies) and is NOT UI forcing. All tab creation goes through the real
// AddTab menu; all moves through the real Move context-menu submenu; all
// sends through the real composer buttons.
//
// STATUS: "pass" when every check holds; "blocked" when the parent surface
// (app.js integration, still in flight) is missing pieces — gaps are listed
// explicitly instead of failing with an obscure timeout; "error" only for
// harness exceptions. DO NOT RUN until the parent signals integration-ready:
// pre-integration runs report "blocked" by design.

import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createApp } from '../server.mjs';
import { hashAccessCode } from '../lib/lan.mjs';

const OUT_ROOT = resolve('.local/tool-panel-instances/ui-captures');
const PROOF_PATH = resolve('.local/tool-panel-instances/ui-tool-tabs-proof.json');
const FIXTURE_DIR = resolve('.local/tool-panel-instances/ui-fixture-owned');
const KINDS = ['roadmap', 'session', 'agents', 'files', 'preferences'];

// Source fence: hashes prove the tree did not move mid-run.
const SOURCE_SURFACE = [
  'public/app.js',
  'public/tool-views.js',
  'public/panel-scope.js',
  'public/docking.js',
  'public/docking-layout.js',
  'public/docking-presets.js',
  'public/conversation-views.js',
  'public/conversation-picker.js',
  'public/roadmap.js',
  'public/inspector.js',
  'public/settings.js',
  'public/passkeys.js',
  'public/push.js',
  'public/mcp.js',
  'public/providers.js',
  'public/remote-access.js',
  'public/composer.js',
  'index.html',
];
function hashSurface() {
  const out = {};
  for (const file of SOURCE_SURFACE) {
    try {
      out[file] = createHash('sha256').update(readFileSync(resolve(file))).digest('hex').slice(0, 16);
    } catch {
      out[file] = 'missing';
    }
  }
  return out;
}
const runMeta = { startedAt: new Date().toISOString(), sourceStart: hashSurface() };

// ---------------------------------------------------------------------------
// Fixture: two projects + two native history sessions + roadmaps + drafts.
// ---------------------------------------------------------------------------
const temp = await mkdtemp(join(tmpdir(), 'prime-tooltabs-ui-'));
const cwdA = join(temp, 'Atelier');
const cwdB = join(temp, 'Vtrott');
const sessionDir = join(temp, 'sessions');
const dataDir = join(temp, 'data');
await mkdir(cwdA, { recursive: true });
await mkdir(cwdB, { recursive: true });
await mkdir(sessionDir, { recursive: true });
await mkdir(dataDir, { recursive: true });

const entry = (id, parentId, role, content, extra = {}) => ({
  type: 'message',
  id,
  parentId,
  message: { role, content, timestamp: Date.now(), ...extra },
});
async function seedSession(file, id, projectCwd, title, paragraphs) {
  const records = [{ type: 'session', id, cwd: projectCwd, version: 3, timestamp: new Date().toISOString() }];
  let parentId = null;
  const link = (record) => {
    record.parentId = parentId;
    records.push(record);
    parentId = record.id;
  };
  link({ type: 'message', id: `${id}-u0`, message: { role: 'user', content: title } });
  const toolCallId = `${id}-history-tool`;
  link(entry(`${id}-tool-call`, null, 'assistant', [{ type: 'toolCall', id: toolCallId, name: 'ipython', arguments: { code: 'print(2)' } }]));
  link(entry(`${id}-tool-result`, null, 'toolResult', `historical-tool-result:${id}`, { toolCallId, toolName: 'ipython', isError: false }));
  paragraphs.forEach((text, index) => {
    link(entry(`${id}-a${index}`, null, 'assistant', text));
    link(entry(`${id}-u${index + 1}`, null, 'user', `Suite ${index + 1} : que verifier ensuite ?`));
  });
  await writeFile(file, records.map(JSON.stringify).join('\n') + '\n');
}
const filler = Array.from({ length: 6 }, (_, i) => `Paragraphe outil ${i + 1} : ` + 'contenu stable. '.repeat(8));
await seedSession(join(sessionDir, 'sess-a.jsonl'), 'sess-a', cwdA, 'Alpha Atelier : calibrer la sortie', filler);
await seedSession(join(sessionDir, 'sess-b.jsonl'), 'sess-b', cwdB, 'Beta Vtrott : planifier la migration', filler.slice(0, 3));

const starts = [];
let newSessionSeq = 0;
const runtime = {
  getStatus: async () => ({ available: true, version: 'fixture' }),
  getModels: async () => ({
    models: [{ id: 'fixture/tooltabs', name: 'Fixture model', provider: 'fixture', reasoning: true }],
    default: { model: 'fixture/tooltabs', thinking: 'medium' },
  }),
  async start(input) {
    const record = { message: input.message, sessionId: input.sessionId || null, cwd: input.cwd };
    starts.push(record);
    let resolveDone;
    const done = new Promise((resolveCompletion) => {
      resolveDone = resolveCompletion;
    });
    const control = {
      record,
      done,
      stream(text) {
        input.onEvent({ kind: 'message', message: { role: 'assistant', text, tools: [] } });
      },
      async finish(status = 'completed') {
        const result = { kind: 'done', sessionId: record.sessionId, status, code: 0 };
        input.onEvent(result);
        resolveDone(result);
        return result;
      },
      cancel() {
        return control.finish('stopped');
      },
    };
    // Synchronous own-session emit for blank conversations (never a timer):
    // a delayed emit could land after finish() and misattribute the pin.
    if (!record.sessionId) {
      newSessionSeq += 1;
      record.sessionId = `tt-new-${newSessionSeq}`;
      try {
        input.onEvent({ kind: 'session', sessionId: record.sessionId, cwd: input.cwd });
      } catch {}
    } else {
      try {
        input.onEvent({ kind: 'session', sessionId: record.sessionId, cwd: input.cwd });
      } catch {}
    }
    await control.finish('completed');
    return control;
  },
  async close() {},
};

// Configured-but-disabled remote access (real supported state, no surface),
// seeded BEFORE createApp; the fixture gateway can never bind.
const remoteSalt = 't'.repeat(32);
await mkdir(dataDir, { recursive: true });
await writeFile(
  join(dataDir, 'lan-access.json'),
  JSON.stringify({
    salt: remoteSalt,
    codeHash: hashAccessCode('87654321', remoteSalt),
    enabled: false,
    tailscale: { enabled: false, https: { enabled: false } },
  }),
);
const app = createApp({
  runtime,
  agentHome: join(temp, 'agent'),
  sessionDir,
  dataDir,
  initialCwd: cwdA,
  networkOptions: {
    interfaces: () => ({}),
    makeGateway() {
      throw new Error('disabled fixture must not bind');
    },
  },
});
await app.store.project({ cwd: cwdA, color: '#16a34a' }, true);
await app.store.project({ cwd: cwdB, color: '#3b82f6' });
await mkdir(join(temp, 'agent'), { recursive: true });
// Roadmaps: A owns plan-PA (session sess-a) + a done plan (filter probe);
// B owns plan-PB (session sess-b).
for (const [cwd, planTitle, sess] of [
  [cwdA, 'plan-PA-atelier', 'sess-a'],
  [cwdB, 'plan-PB-vtrott', 'sess-b'],
]) {
  let doc = await app.roadmap.read(cwd);
  doc = await app.roadmap.mutate(cwd, { action: 'init', expectedRevision: doc.revision });
  doc = await app.roadmap.mutate(cwd, {
    action: 'plan.create',
    expectedRevision: doc.revision,
    title: planTitle,
    sessions: [sess],
    steps: [{ text: `${planTitle} etape 1` }],
  });
}
{
  let doc = await app.roadmap.read(cwdA);
  doc = await app.roadmap.mutate(cwdA, {
    action: 'plan.create',
    expectedRevision: doc.revision,
    title: 'plan-PA-termine',
    sessions: ['sess-a'],
    steps: [{ text: 'etape finie', check: { state: 'done' } }],
  });
}
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${app.server.address().port}`;
const fixtureManifest = {
  version: JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version,
  tempPrefix: 'prime-tooltabs-ui-',
  projects: [
    { cwd: cwdA, marker: 'Atelier' },
    { cwd: cwdB, marker: 'Vtrott' },
  ],
  sessions: ['sess-a', 'sess-b'],
  plans: ['plan-PA-atelier', 'plan-PA-termine', 'plan-PB-vtrott'],
};

// ---------------------------------------------------------------------------
// Browser + shared helpers (real clicks only; evaluate is read-only).
// ---------------------------------------------------------------------------
const browser = await launchStudioBrowser({ channel: 'chrome' });
const errors = [];
const checks = [];
const notes = [];
const requests = [];
const consoleErrors = [];
const marks = [];
const usedShots = {};
let proofWritten = false;
let proofPhase = 'boot';
function markPhase(name) {
  proofPhase = name;
  marks.push({ phase: name, at: new Date().toISOString() });
}
marks.push({ phase: 'boot', at: new Date().toISOString() });

function step(text) {
  checks.push(text);
  console.log(`ok - ${text}`);
}
function note(text) {
  notes.push(text);
  console.log(`note - ${text}`);
}
function gap(text) {
  notes.push(`GAP: ${text}`);
  console.log(`gap - ${text}`);
}
async function freshShot(name) {
  // Prior runs keep their evidence: never overwrite, spill to -rN names.
  const { access } = await import('node:fs/promises');
  const dot = name.lastIndexOf('.');
  const stem = dot >= 0 ? name.slice(0, dot) : name;
  const ext = dot >= 0 ? name.slice(dot) : '';
  const candidates = [name, `b-${name}`, `c-${name}`];
  for (let n = 4; n < 100; n++) candidates.push(`${stem}-r${n}${ext}`);
  for (const alt of candidates) {
    try {
      await access(join(OUT_ROOT, alt));
    } catch {
      usedShots[name] = alt;
      return join(OUT_ROOT, alt);
    }
  }
  throw new Error(`No free capture name for ${name}`);
}
async function shot(page, name) {
  await mkdir(OUT_ROOT, { recursive: true });
  await page.screenshot({ path: await freshShot(name), animations: 'disabled' });
}
async function seedSelection(context, selection) {
  await context.addInitScript((sel) => {
    if (!localStorage.getItem('prime-studio.selection'))
      localStorage.setItem('prime-studio.selection', JSON.stringify(sel));
    // Pre-existing drafts in A/B must survive focus switches and reload.
    if (!localStorage.getItem('prime-studio.drafts'))
      localStorage.setItem(
        'prime-studio.drafts',
        JSON.stringify({ 'session:sess-a': 'BROUILLON-A-outils', 'session:sess-b': 'BROUILLON-B-outils' }),
      );
  }, selection);
}
async function probeGaps(page, pairs) {
  const gaps = [];
  for (const [name, selector] of pairs) {
    const count = await page.locator(selector).count().catch(() => 0);
    if (!count) gaps.push(name);
  }
  return gaps;
}
const esc = (id) => id.replace(/"/g, '\\"');
const TAB = (id) => `button[data-dock-tab="${esc(id)}"]`;
const LOCK = (id) => `[data-dock-lock="${esc(id)}"]`;
const PRIMARY_TOOL_IDS = ['roadmap', 'session', 'agents', 'files', 'preferences'];
async function toolTabIds(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('button[data-dock-tab]')]
      .map((tab) => tab.dataset.dockTab)
      .filter((id) => String(id).startsWith('tool:')),
  );
}
// ALL mounted tool tabs: five primaries + dynamic tool:* refs. Binding
// records ALWAYS list the 5 primaries, mounted or not — never infer mounts
// from storage; read the DOM.
async function toolTabIdsAll(page) {
  return page.evaluate((primaries) => {
    return [...document.querySelectorAll('button[data-dock-tab]')]
      .map((tab) => tab.dataset.dockTab)
      .filter((id) => primaries.includes(id) || String(id).startsWith('tool:'));
  }, PRIMARY_TOOL_IDS);
}
const mountedLog = [];
async function logMounted(page, label) {
  const ids = await toolTabIdsAll(page);
  mountedLog.push({ label, at: new Date().toISOString(), ids });
  console.log(`mounted [${label}]: ${ids.join(' | ')}`);
  return ids;
}
async function convTabIds(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('button[data-dock-tab]')]
      .map((tab) => tab.dataset.dockTab)
      .filter((id) => id === 'conversation' || String(id).startsWith('conv:')),
  );
}
async function layoutSummary(page) {
  return page.evaluate(() => {
    let layout = null,
      tools = null;
    try {
      layout = JSON.parse(localStorage.getItem('prime-studio.docking.layout') || 'null');
    } catch {}
    try {
      tools = JSON.parse(localStorage.getItem('prime-studio.docking.tools') || 'null');
    } catch {}
    const groups = [];
    const stack = [layout?.root];
    let guard = 0;
    while (stack.length && guard++ < 50) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (node.kind === 'group') groups.push({ id: node.id, tabs: node.panels, active: node.active });
      else {
        if (node.first) stack.push(node.first);
        if (node.second) stack.push(node.second);
      }
    }
    return {
      version: layout?.version ?? null,
      enabled: layout?.enabled ?? null,
      groups,
      toolEntries: (tools?.entries || []).map((entry) => ({
        id: entry.id,
        locked: entry.locked,
        target: entry.target
          ? { sessionId: entry.target.sessionId, project: String(entry.target.projectCwd || '').slice(-14) }
          : null,
      })),
    };
  });
}
// Real AddTab path: group ellipsis -> context menu -> Add submenu -> kind.
async function openAddMenu(page, kind) {
  const grp =
    (await page.evaluate(() => [...document.querySelectorAll('[data-dock-group]')][0]?.dataset.dockGroup || null)) ||
    null;
  if (!grp) throw new Error('no dock group for AddTab');
  await page.locator(`[data-dock-group="${grp}"] .dock-bar > .dock-chrome-button:not([data-dock-close])`).first().click();
  await expect(page.locator('#docking-context-menu')).toBeVisible({ timeout: 10000 });
  await page.locator('#docking-context-menu [aria-controls="docking-add-menu"]').first().click();
  await expect(page.locator('#docking-add-menu')).toBeVisible({ timeout: 10000 });
  await page.locator(`#docking-add-menu [data-dock-add="${kind}"]`).click();
}
async function installToastWatch(page) {
  // Read-only toast insertion observer BEFORE the click: a transient
  // rejection toast is quoted verbatim instead of missed after 15s.
  await page.evaluate(() => {
    if (window.__ttToasts) return;
    window.__ttToasts = [];
    const root = document.getElementById('toasts');
    if (!root) return;
    new MutationObserver((changes) => {
      for (const change of changes)
        for (const node of change.addedNodes)
          window.__ttToasts.push({ at: new Date().toISOString(), text: (node.textContent || '').slice(0, 300) });
    }).observe(root, { childList: true, subtree: true });
  });
}
async function creationFailure(page, kind, clickedAt, what) {
  const toasts = await page.evaluate(() => (window.__ttToasts || []).slice(-4));
  const diag = await layoutSummary(page);
  throw new Error(
    `${what} ${kind} failed (clicked ${clickedAt}). toasts=${JSON.stringify(toasts).slice(0, 700)} console=${JSON.stringify(consoleErrors.slice(-4)).slice(0, 600)} diag=${JSON.stringify(diag).slice(0, 1200)}`,
  );
}
// A first Add reopens an unmounted primary (no tool:* id appears); only later
// Adds mint dynamic clones. Ensure the primary first, then mint clones.
async function ensurePrimaryMounted(page, kind) {
  if ((await toolTabIdsAll(page)).includes(kind)) return kind;
  await installToastWatch(page);
  await openAddMenu(page, kind);
  const clickedAt = new Date().toISOString();
  try {
    await expect.poll(() => toolTabIdsAll(page), { timeout: 15000 }).toContain(kind);
  } catch {
    await creationFailure(page, kind, clickedAt, 'primary reopen');
  }
  return kind;
}
async function addToolClone(page, kind) {
  const before = new Set(await toolTabIds(page));
  await installToastWatch(page);
  await openAddMenu(page, kind);
  const clickedAt = new Date().toISOString();
  const deadline = Date.now() + 15000;
  for (;;) {
    const found = (await toolTabIds(page)).find((tab) => !before.has(tab) && tab.startsWith(`tool:${kind}:`));
    if (found) return found;
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(250);
  }
  await creationFailure(page, kind, clickedAt, 'dynamic clone');
}
// Real Move path: right-click tab -> Move submenu -> zone/group item.
async function moveTab(page, id, zonePrefix = null) {
  await page.locator(TAB(id)).click({ button: 'right' });
  await expect(page.locator('#docking-context-menu')).toBeVisible({ timeout: 10000 });
  await page.locator('#docking-context-menu [aria-controls="docking-move-menu"]').click();
  await expect(page.locator('#docking-move-menu')).toBeVisible({ timeout: 10000 });
  const opened = (await page.locator('#docking-move-menu:not([hidden]) [data-dock-move]').count()) > 0;
  assert.ok(opened, `Move submenu opens for ${id}`);
  const items = zonePrefix
    ? page.locator(`#docking-move-menu [data-dock-move^="${zonePrefix}"]`)
    : page.locator('#docking-move-menu [data-dock-move]');
  const enabled = items.filter({ hasNot: page.locator('[disabled]') });
  assert.ok((await enabled.count()) > 0, `Move offers a live target for ${id}`);
  await enabled.first().click();
  await page.waitForTimeout(800);
}
async function lockState(page, id) {
  return page.evaluate((tabId) => {
    const lock = document.querySelector(`[data-dock-lock="${CSS.escape(tabId)}"]`);
    if (!lock) return null;
    return { pressed: lock.getAttribute('aria-pressed'), label: lock.getAttribute('aria-label') || lock.title || '' };
  }, id);
}
async function toolStorage(page) {
  return page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('prime-studio.docking.tools') || 'null');
    } catch {
      return null;
    }
  });
}
async function frameText(page, id) {
  return page.evaluate((tabId) => {
    const frame = document.getElementById(`dock-view-${tabId}`);
    return frame ? (frame.textContent || '').slice(0, 4000) : null;
  }, id);
}
async function frameVisible(page, id) {
  return page.evaluate((tabId) => {
    const frame = document.getElementById(`dock-view-${tabId}`);
    return !!frame && !frame.hidden;
  }, id);
}
// Sidebar clicks rebind the FOCUSED view; only the picker opens a dedicated
// conv tab for an existing session. Real menu + real rows, read-only waits.
async function openSessionInNewTab(page, projectText, sessionText, sessionId) {
  const grp = await page.evaluate(() => [...document.querySelectorAll('[data-dock-group]')][0]?.dataset.dockGroup || null);
  assert.ok(grp, 'dock group for conversation AddTab');
  await page.locator(`[data-dock-group="${grp}"] .dock-bar > .dock-chrome-button:not([data-dock-close])`).first().click();
  await expect(page.locator('#docking-context-menu')).toBeVisible({ timeout: 10000 });
  await page.locator('#docking-context-menu [aria-controls="docking-add-menu"]').first().click();
  await expect(page.locator('#docking-add-menu')).toBeVisible({ timeout: 10000 });
  await page.locator('#docking-add-menu [data-dock-add="new-conversation"]').click();
  await expect(page.locator('#conversation-picker')).toBeVisible({ timeout: 10000 });
  await page.locator('#conversation-picker .conv-pick-row', { hasText: projectText }).first().click();
  await page.waitForTimeout(500);
  await page.locator('#conversation-picker .conv-pick-row', { hasText: sessionText }).first().click();
  const resolveView = async () => {
    let sidecar = null;
    try {
      sidecar = JSON.parse(await page.evaluate(() => localStorage.getItem('prime-studio.docking.conversations') || 'null'));
    } catch {
      return null;
    }
    const entry = (sidecar?.entries || []).find((e) => e.sessionId === sessionId);
    if (!entry) return null;
    const tabs = await convTabIds(page);
    return tabs.includes(entry.id) ? entry.id : null;
  };
  await expect.poll(resolveView, { timeout: 20000 }).not.toBe(null);
  const viewId = await resolveView();
  assert.ok(viewId, 'picker-opened session view resolvable (required)');
  return viewId;
}
async function focusedCtx(page) {
  return page.evaluate(() => {
    let selection = null;
    try {
      selection = JSON.parse(localStorage.getItem('prime-studio.selection') || 'null');
    } catch {}
    const tab = document.querySelector('button[data-dock-tab].is-conversation.is-focused');
    const row = document.querySelector('.session-row.active[data-session-id]');
    return { tab: tab?.dataset.dockTab || null, sessionId: selection?.sessionId || null, row: row?.dataset.sessionId || null };
  });
}
// Activate a tool tab through the normal UI, then prove the focused
// conversation did NOT move (hidden views intentionally never poll/render,
// so every content read below goes through here first).
async function activateToolTab(page, id, label) {
  const before = await focusedCtx(page);
  await page.locator(TAB(id)).click();
  await page.waitForTimeout(400);
  const after = await focusedCtx(page);
  if (before.sessionId && after.sessionId)
    assert.equal(after.sessionId, before.sessionId, `${label}: tool activation must not retarget focus (was ${before.sessionId})`);
  if (before.row && after.row)
    assert.equal(after.row, before.row, `${label}: sidebar selection stable across tool activation`);
}
// Lock poll that attributes the failing layer on timeout: storage entry
// (toggle accepted) vs lock chrome (paint/sync) vs refusal (no entry flip).
async function expectLocked(page, id, label) {
  try {
    await expect.poll(() => lockState(page, id).then((s) => s?.pressed), { timeout: 10000 }).toBe('true');
    return;
  } catch {
    const diag = await page.evaluate((tabId) => {
      let tools = null,
        selection = null;
      try {
        tools = JSON.parse(localStorage.getItem('prime-studio.docking.tools') || 'null');
      } catch {}
      try {
        selection = JSON.parse(localStorage.getItem('prime-studio.selection') || 'null');
      } catch {}
      const lock = document.querySelector(`[data-dock-lock="${CSS.escape(tabId)}"]`);
      return {
        storageLocked: (tools?.entries || []).find((e) => e.id === tabId)?.locked ?? 'no-entry',
        ariaPressed: lock?.getAttribute('aria-pressed') ?? 'no-lock',
        lockDisabled: lock ? !!lock.disabled : 'no-lock',
        lockRects: lock ? lock.getClientRects().length : -1,
        selection,
        toasts: (window.__ttToasts || []).slice(-3),
      };
    }, id);
    assert.fail(`${label}: lock never engaged: ${JSON.stringify(diag).slice(0, 700)}`);
  }
}
// spec: { all: [...] (every substring), any: [...] (at least one) } — polls
// network/render instead of fixed sleeps.
async function readToolFrame(page, id, spec, label) {
  const all = [...(spec.all || []), ...(typeof spec === 'string' ? [spec] : [])];
  const any = [...(spec.any || [])];
  await activateToolTab(page, id, label);
  for (const sub of all) {
    await expect.poll(() => frameText(page, id).then((text) => text || ''), { timeout: 15000 }).toContain(sub);
  }
  if (any.length) {
    await expect
      .poll(
        () => frameText(page, id).then((text) => {
          const body = text || '';
          return any.some((sub) => body.includes(sub)) ? body : '';
        }),
        { timeout: 15000 },
      )
      .not.toBe('');
  }
  return (await frameText(page, id)) || '';
}
async function focusSession(page, sessionId) {
  await page.locator(`.session-row[data-session-id="${sessionId}"]`).first().click();
  await page.waitForTimeout(1200);
}
function roadmapPosts() {
  return requests.filter((r) => r.method === 'POST' && r.path === '/api/roadmap');
}
function inspectorSessionIds() {
  return [...new Set(requests.filter((r) => r.path.startsWith('/api/inspector')).map((r) => {
    try {
      return new URL(r.url).searchParams.get('sessionId');
    } catch {
      return null;
    }
  }).filter(Boolean))];
}

let page, context;
async function writeProof(status, extra = {}) {
  const payload = {
    version: 1,
    status,
    phase: proofPhase,
    marks,
    mountedLog,
    checks,
    notes,
    runs: { starts: starts.length },
    errors,
    requests: {
      total: requests.length,
      runPosts: requests.filter((r) => r.method === 'POST' && r.path === '/api/runs').length,
      roadmapPosts: roadmapPosts().length,
      inspectorSessionIds: inspectorSessionIds(),
    },
    sourceStart: runMeta.sourceStart,
    sourceEnd: hashSurface(),
    at: new Date().toISOString(),
    ...extra,
  };
  await mkdir(dirname(PROOF_PATH), { recursive: true });
  await writeFile(PROOF_PATH, JSON.stringify(payload, null, 2));
  await mkdir(FIXTURE_DIR, { recursive: true });
  await writeFile(join(FIXTURE_DIR, 'fixture-manifest.json'), JSON.stringify(fixtureManifest, null, 2));
  proofWritten = true;
  console.log(JSON.stringify({ status, checks: checks.length, errors, runPosts: payload.requests.runPosts }, null, 2));
}

try {
  await mkdir(OUT_ROOT, { recursive: true });
  context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' });
  await seedSelection(context, { cwd: cwdA, sessionId: 'sess-a', projectOverview: false });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(String(error?.stack || error?.message || error).slice(0, 800)));
  page.on('dialog', async (dialog) => {
    errors.push(`unexpected native dialog (${dialog.type()}): ${dialog.message()}`);
    await dialog.dismiss().catch(() => {});
  });
  page.on('console', (message) => {
    try {
      if (['error', 'warning'].includes(message.type()))
        consoleErrors.push({ at: new Date().toISOString(), type: message.type(), text: String(message.text()).slice(0, 400) });
    } catch {}
  });
  page.on('request', (request) => {
    try {
      const url = new URL(request.url());
      if (url.hostname !== '127.0.0.1') return;
      const rec = { method: request.method(), path: url.pathname, url: request.url() };
      if (request.method() === 'POST' && url.pathname === '/api/roadmap') {
        try {
          rec.body = request.postDataJSON();
        } catch {}
      }
      requests.push(rec);
    } catch {}
  });
  page.on('response', async (response) => {
    try {
      const request = response.request();
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/runs')
        requests.push({ method: 'POST-RESPONSE', path: '/api/runs', status: response.status() });
    } catch {}
  });

  await page.goto(url);
  await expect(page.locator('#connection-label')).toContainText('connect', { timeout: 20000 });
  await page.waitForTimeout(1200);

  // ------------------------------------------------ Phase 1: parent-surface preflight.
  markPhase('parent-contract');
  const gaps = await probeGaps(page, [
    ['dock-workspace', '#dock-workspace'],
    ['add-menu', '#docking-add-menu'],
    ['context-menu', '#docking-context-menu'],
    ['move-menu', '#docking-move-menu'],
    ...KINDS.map((kind) => [`add-tool-${kind}`, `#docking-add-menu [data-dock-add="${kind}"]`].slice(0, 2)),
  ]);
  // Add-menu items only exist while the menu is built; open it once to probe.
  let addProbe = gaps.filter((g) => g.startsWith('add-tool-'));
  if (addProbe.length) {
    try {
      const grp = await page.evaluate(() => [...document.querySelectorAll('[data-dock-group]')][0]?.dataset.dockGroup || null);
      if (grp) {
        await page.locator(`[data-dock-group="${grp}"] .dock-bar > .dock-chrome-button:not([data-dock-close])`).first().click();
        await expect(page.locator('#docking-context-menu')).toBeVisible({ timeout: 10000 });
        await page.locator('#docking-context-menu [aria-controls="docking-add-menu"]').first().click();
        await expect(page.locator('#docking-add-menu')).toBeVisible({ timeout: 10000 });
        const stillMissing = [];
        for (const kind of KINDS) {
          if (!(await page.locator(`#docking-add-menu [data-dock-add="${kind}"]`).count())) stillMissing.push(`add-tool-${kind}`);
        }
        await page.keyboard.press('Escape');
        for (const g of [...stillMissing]) await page.waitForTimeout(0);
        addProbe = stillMissing;
      }
    } catch (e) {
      gap(`AddTab probe failed: ${String(e?.message || e).slice(0, 200)}`);
    }
  }
  const hardGaps = [...gaps.filter((g) => !g.startsWith('add-tool-')), ...addProbe];
  if (hardGaps.length) {
    await shot(page, 'ui-blocked-contract.png');
    await writeProof('blocked', { contractGaps: hardGaps });
    console.log(`blocked - parent contract gaps: ${hardGaps.join(', ')}`);
    // Blocked is a FAILURE signal for automation (never exit 0): clean up
    // explicitly since process.exit skips the finally block.
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await app.close().catch(() => {});
    await rm(temp, { recursive: true, force: true }).catch(() => {});
    process.exit(2);
  }
  step('Parent contract present: dock workspace, context/add/move menus, 5 tool AddTab items.');

  // Dock defaults ON at desktop width with no saved choice (fresh profile).
  const dockVisible = await page.locator('#dock-workspace').isVisible().catch(() => false);
  assert.ok(dockVisible, 'dock defaults ON at 1600px with no saved choice');
  step('Modular layout defaults ON at desktop width with no saved choice.');
  await shot(page, 'ui-boot.png');

  // ------------------------------------------------ Phase 2: 3 roadmaps, independent DOM/editors/filter + pin A while focus B.
  markPhase('roadmaps');
  await ensurePrimaryMounted(page, 'roadmap');
  const rm1 = await addToolClone(page, 'roadmap');
  const rm2 = await addToolClone(page, 'roadmap');
  const rm3 = await addToolClone(page, 'roadmap');
  await logMounted(page, 'roadmaps-created');
  assert.ok(rm1 && rm2 && rm3 && new Set([rm1, rm2, rm3]).size === 3, 'three distinct roadmap instances');
  assert.ok(/^tool:roadmap:[A-Za-z0-9_-]{1,64}$/.test(rm1), `roadmap id shape ${rm1}`);
  step('Three roadmap tabs created via real AddTab with distinct tool:roadmap:<nonce> ids.');
  // Independent DOM: per-instance panels, no duplicate ids across instances.
  const rmDom = await page.evaluate((ids) => {
    const panels = ids.map((id) => document.getElementById(`dock-view-${id}`)?.querySelector('[data-instance-id]')?.dataset.instanceId || null);
    const allIds = [...document.querySelectorAll('[id]')].map((n) => n.id);
    return { panels, dupes: allIds.filter((id, i) => allIds.indexOf(id) !== i).slice(0, 5), count: allIds.length };
  }, [rm1, rm2, rm3]);
  assert.deepEqual(rmDom.panels, [rm1, rm2, rm3]);
  assert.deepEqual(rmDom.dupes, []);
  step('Roadmap instances own independent DOM (data-instance-id per tab, zero duplicate ids).');
  // Simultaneous-updates case: one roadmap per group via real Move. rm1..rm3
  // are IN ADDITION to the default primary Roadmap: moving rm2/rm3 out can
  // leave rm1 inactive behind the conversation, so activate each instance
  // through the real UI, prove three distinct groups, then poll visible.
  await moveTab(page, rm2, 'right');
  await moveTab(page, rm3, 'bottom');
  async function groupOf(id) {
    return page.evaluate(
      (tabId) => document.querySelector(`button[data-dock-tab="${CSS.escape(tabId)}"]`)?.closest('[data-dock-group]')?.dataset.dockGroup || null,
      id,
    );
  }
  for (const id of [rm1, rm2, rm3]) await activateToolTab(page, id, `${id}-place`);
  const rmGroups = [await groupOf(rm1), await groupOf(rm2), await groupOf(rm3)];
  assert.ok(rmGroups.every(Boolean) && new Set(rmGroups).size === 3, `roadmaps in three distinct groups (${rmGroups.join(',')})`);
  for (const id of [rm1, rm2, rm3]) {
    try {
      await expect.poll(() => frameVisible(page, id), { timeout: 10000 }).toBe(true);
    } catch {
      const diag = await page.evaluate((tabId) => {
        let groups = null;
        try {
          const layout = JSON.parse(localStorage.getItem('prime-studio.docking.layout') || 'null');
          const walk = (node) =>
            node && typeof node === 'object'
              ? Array.isArray(node.groups)
                ? node.groups.map((g) => ({ id: g.id, tabs: g.panels || g.tabs, active: g.active }))
                : null
              : null;
          groups = walk(layout) || walk(layout?.root) || String(layout).slice(0, 300);
        } catch (e) {
          groups = `unreadable:${String(e?.message || e).slice(0, 80)}`;
        }
        const tab = document.querySelector(`button[data-dock-tab="${CSS.escape(tabId)}"]`);
        const frame = document.getElementById(`dock-view-${tabId}`);
        const rect = frame?.getBoundingClientRect?.();
        return {
          groups,
          group: tab?.closest('[data-dock-group]')?.dataset.dockGroup || null,
          ariaSelected: tab?.getAttribute('aria-selected'),
          frameHidden: frame ? frame.hidden : 'no-frame',
          rects: rect ? [Math.round(rect.width), Math.round(rect.height)] : null,
        };
      }, id);
      assert.fail(`${id} frame never visible: ${JSON.stringify(diag).slice(0, 700)}`);
    }
  }
  step('Three roadmaps sit in three groups via real Move (simultaneous updates).');
  // Lock rm1 while sess-a is focused (owner A), then focus B: rm1 keeps plan-PA.
  await focusSession(page, 'sess-a');
  await page.locator(LOCK(rm1)).click();
  await expectLocked(page, rm1, 'rm1');
  await focusSession(page, 'sess-b');
  const rm1Text = await readToolFrame(page, rm1, 'plan-PA-atelier', 'rm1-locked');
  assert.ok(!rm1Text.includes('plan-PB-vtrott'), 'locked rm1 shows no project-B plan');
  step('Locked roadmap keeps owner-A filter while focus moves to B.');
  // Unlocked rm2 follows B (activated first: hidden views never render).
  const rm2Text = await readToolFrame(page, rm2, 'plan-PB-vtrott', 'rm2-follow');
  step('Unlocked roadmap follows focus to B.');
  // Remaining-only filter in rm2 does not leak into rm1/rm3.
  await activateToolTab(page, rm2, 'rm2-filter');
  const rm2Filter = page.locator(`[id="dock-view-${esc(rm2)}"] [data-rm-focus]`).first();
  assert.ok(await rm2Filter.count(), 'rm2 remaining-filter control present (required)');
  {
    const before = await rm2Filter.getAttribute('aria-pressed');
    await rm2Filter.click();
    await expect.poll(() => rm2Filter.getAttribute('aria-pressed'), { timeout: 10000 }).not.toBe(before);
    const after = await rm2Filter.getAttribute('aria-pressed');
    assert.ok(before !== after, 'rm2 filter toggles');
    const rm1Pressed = await page.locator(`[id="dock-view-${esc(rm1)}"] [data-rm-focus]`).first().getAttribute('aria-pressed').catch(() => 'absent');
    assert.ok(rm1Pressed !== after || rm1Pressed === 'absent', 'rm1 filter state independent');
    step('Per-roadmap remaining filter is independent (no cross-instance leak).');
  }
  // Real edit in rm1: first step checkbox -> exactly one POST owning cwdA.
  const postsBefore = roadmapPosts().length;
  await activateToolTab(page, rm1, 'rm1-edit');
  // Plans render collapsed: expand plan-PA-atelier through the real toggle first.
  const rm1Toggle = page.locator(`[id="dock-view-${esc(rm1)}"] .rm-plan-toggle[aria-label="plan-PA-atelier"]`);
  assert.ok(await rm1Toggle.count(), 'rm1 plan toggle present (required)');
  if ((await rm1Toggle.getAttribute('aria-expanded')) !== 'true') {
    await rm1Toggle.click();
    await expect.poll(() => rm1Toggle.getAttribute('aria-expanded'), { timeout: 10000 }).toBe('true');
  }
  const rm1Box = page.locator(`[id="dock-view-${esc(rm1)}"] input[type="checkbox"]`).first();
  assert.ok(await rm1Box.count(), 'rm1 step checkbox present (required)');
  {
    await rm1Box.click();
    await page.waitForTimeout(1500);
    const fresh = roadmapPosts().slice(postsBefore);
    assert.equal(fresh.length, 1, `one roadmap POST, got ${fresh.length}`);
    assert.ok(JSON.stringify(fresh[0].body || {}).includes(cwdA.slice(-6)) || JSON.stringify(fresh).includes('plan-PA'), 'POST owns project A');
    step('Locked roadmap edit POSTs once against its owning project (no duplicate writes).');
  }
  await shot(page, 'ui-roadmaps.png');

  // ------------------------------------------------ Phase 3: two each session/agents/files/preferences.
  markPhase('units');
  const tabs = {};
  for (const kind of ['session', 'agents', 'files', 'preferences']) {
    await ensurePrimaryMounted(page, kind);
    tabs[kind] = [await addToolClone(page, kind), await addToolClone(page, kind)];
    assert.ok(tabs[kind][0] !== tabs[kind][1], `two distinct ${kind} clones`);
  }
  await logMounted(page, 'units-created');
  step('Two tabs each for session/agents/files/preferences via real AddTab.');
  // Lock first of each to A (sess-a focused), move second-kind tabs for visibility.
  await focusSession(page, 'sess-a');
  for (const kind of ['session', 'agents', 'files', 'preferences']) {
    await page.locator(LOCK(tabs[kind][0])).click();
    await expectLocked(page, tabs[kind][0], `${kind}-0-first-lock`);
  }
  await moveTab(page, tabs.files[0], 'right');
  step('First of each kind locked to A; a Move-menu relocation works on tool tabs.');
  await focusSession(page, 'sess-b');
  // Locked tabs keep A: session unit shows sess-a marker, files GETs stay A-owned.
  const sessText = await readToolFrame(page, tabs.session[0], { any: ['ID sess-a', 'Alpha Atelier'] }, 'session-locked');
  assert.ok(!sessText.includes('ID sess-b') && !sessText.includes('Beta Vtrott'), 'locked session shows no B content');
  step('Locked session tab keeps owner-A context while B is focused.');
  const inspIds = inspectorSessionIds();
  assert.ok(inspIds.includes('sess-a'), `inspector fetched owner sess-a (${inspIds.join(',')})`);
  assert.ok(!inspIds.some((id) => id !== 'sess-a' && id !== 'sess-b'), `no off-owner inspector fetch (${inspIds.join(',')})`);
  step('Inspector GETs carry only owning session ids (sess-a/sess-b, never a third party).');
  // Unlock follows B.
  await page.locator(LOCK(tabs.session[0])).click();
  await expect.poll(() => lockState(page, tabs.session[0]).then((s) => s?.pressed), { timeout: 10000 }).toBe('false');
  await page.waitForTimeout(1200);
  const sessFollow = await readToolFrame(page, tabs.session[0], { any: ['ID sess-b', 'Beta Vtrott'] }, 'session-follow');
  step('Unlock returns the tab to live focus (B).');
  // Re-lock session-0 to A for the reload/close/missing phases below.
  await focusSession(page, 'sess-a');
  await page.locator(LOCK(tabs.session[0])).click();
  await expectLocked(page, tabs.session[0], 'session-0-relock');
  await focusSession(page, 'sess-b');
  await shot(page, 'ui-locked.png');

  // ------------------------------------------------ Phase 4: prefs sharing vs separation.
  markPhase('preferences');
  const [prefsA, prefsB] = tabs.preferences;
  // prefsA is STILL locked to A from the phase-3 per-kind locks (verified
  // there): clicking again would UNLOCK it. Assert the standing lock instead.
  await expectLocked(page, prefsA, 'prefsA-standing');
  // Separate selected tabs per instance (real category clicks; activated first).
  await activateToolTab(page, prefsA, 'prefsA-tab');
  await page.locator(`[id="dock-view-${esc(prefsA)}"] [data-settings-tab="remote"]`).click();
  await activateToolTab(page, prefsB, 'prefsB-tab');
  await page.locator(`[id="dock-view-${esc(prefsB)}"] [data-settings-tab="appearance"]`).click();
  await expect.poll(() => page.evaluate(([a, b]) => {
    const sel = (id) => document.getElementById(`dock-view-${id}`)?.querySelector('[data-settings-tab][aria-selected="true"]')?.dataset.settingsTab || null;
    return JSON.stringify([sel(a), sel(b)]);
  }, [prefsA, prefsB]), { timeout: 10000 }).toBe(JSON.stringify(['remote', 'appearance']));
  const selTabs = await page.evaluate(([a, b]) => {
    const sel = (id) => document.getElementById(`dock-view-${id}`)?.querySelector('[data-settings-tab][aria-selected="true"]')?.dataset.settingsTab || null;
    return [sel(a), sel(b)];
  }, [prefsA, prefsB]);
  assert.deepEqual(selTabs, ['remote', 'appearance']);
  step('Two Preferences tabs hold separate selected categories.');
  // Radio IDs + ARIA unique across clones; no duplicate ids anywhere.
  const idScan = await page.evaluate(() => {
    const all = [...document.querySelectorAll('[id]')].map((n) => n.id);
    const dupes = [...new Set(all.filter((id, i) => all.indexOf(id) !== i))];
    const radios = [...document.querySelectorAll('input[type="radio"][name]')].map((n) => n.name);
    const fors = [...document.querySelectorAll('label[for]')].map((n) => n.getAttribute('for'));
    const dangling = fors.filter((f) => !document.getElementById(f));
    return { dupes: dupes.slice(0, 8), radioNames: [...new Set(radios)], danglingFor: dangling.slice(0, 8) };
  });
  assert.deepEqual(idScan.dupes, [], `duplicate ids: ${idScan.dupes.join(',')}`);
  assert.deepEqual(idScan.danglingFor, [], `dangling for=: ${idScan.danglingFor.join(',')}`);
  assert.ok(idScan.radioNames.length > 1 || idScan.radioNames.length === 0, `radio groups unique per clone (${idScan.radioNames.join(',')})`);
  step('Radio IDs/ARIA unique across Preferences clones; zero duplicate ids, zero dangling for=.');
  // Shared global choice: flip theme in clone A, primary form reflects it.
  await activateToolTab(page, prefsA, 'prefsA-theme');
  await page.locator(`[id="dock-view-${esc(prefsA)}"] [data-settings-tab="appearance"]`).click();
  const themeBtn = page.locator(`[id="dock-view-${esc(prefsA)}"] [data-theme-choice="light"]`);
  assert.ok(await themeBtn.count(), 'clone theme choices present (required)');
  {
    await themeBtn.click();
    await page.waitForTimeout(600);
    const theme = await page.evaluate(() => document.documentElement.dataset.theme || null);
    assert.equal(theme, 'light');
    step('Global theme choice made in a clone applies studio-wide (shared prefs).');
    await page.locator(`[id="dock-view-${esc(prefsA)}"] [data-theme-choice="dark"]`).click();
    await page.waitForTimeout(400);
  }
  // Manager return only to the opener: MCP from clone A, Escape, focus lands in A.
  await activateToolTab(page, prefsA, 'prefsA-manager');
  // The MCP opener lives in the Tools category: select it through the real UI first.
  await page.locator(`[id="dock-view-${esc(prefsA)}"] [data-settings-tab="tools"]`).click();
  const mcpOpener = page.locator(`[id="dock-view-${esc(prefsA)}"] [id$="--open-mcp-settings"]`).first();
  assert.ok(await mcpOpener.count(), 'clone MCP opener present (required)');
  {
    await mcpOpener.click();
    await expect.poll(() => page.evaluate(() => document.querySelectorAll('dialog:modal').length), { timeout: 10000 }).toBe(1);
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => document.querySelectorAll('dialog:modal').length), { timeout: 10000 }).toBe(0);
    const focusInA = await page.evaluate(([a]) => {
      const frame = document.getElementById(`dock-view-${a}`);
      return !!frame && !!frame.contains(document.activeElement);
    }, [prefsA]);
    assert.ok(focusInA, 'manager close returns focus into the opening clone only');
    step('Nested manager opened from a clone returns to that opener (never a sibling).');
  }
  // Footer popup must not retarget the locked tab.
  const toolsBefore = await toolStorage(page);
  const lockEntryBefore = (toolsBefore?.entries || []).find((e) => e.id === prefsA);
  await page.locator('#open-settings').click();
  await expect(page.locator('#settings-dialog')).toBeVisible({ timeout: 10000 });
  const popupModal = await page.evaluate(() => {
    const dialog = document.getElementById('settings-dialog');
    return dialog?.matches(':modal') || false;
  });
  assert.ok(popupModal, 'footer opens a real modal popup');
  await page.keyboard.press('Escape');
  const toolsAfter = await toolStorage(page);
  assert.deepEqual(
    (toolsAfter?.entries || []).find((e) => e.id === prefsA),
    lockEntryBefore,
    'footer popup leaves the locked tab binding untouched',
  );
  step('Footer Preferences popup never retargets a locked tab.');
  await shot(page, 'ui-prefs.png');

  // ------------------------------------------------ Phase 5: reload restores pins; close/rebind never fallback.
  markPhase('reload');
  const draftsBefore = await page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('prime-studio.drafts') || '{}');
    } catch {
      return {};
    }
  });
  await logMounted(page, 'pre-reload');
  await page.reload();
  await expect(page.locator('#connection-label')).toContainText('connect', { timeout: 20000 });
  await page.waitForTimeout(1800);
  await logMounted(page, 'post-reload');
  const toolsReload = await toolStorage(page);
  for (const id of [rm1, tabs.session[0], tabs.files[0], prefsA]) {
    const entry = (toolsReload?.entries || []).find((e) => e.id === id);
    assert.ok(entry?.locked, `${id} still locked after reload`);
  }
  const draftsAfter = await page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('prime-studio.drafts') || '{}');
    } catch {
      return {};
    }
  });
  assert.equal(draftsAfter['session:sess-a'], draftsBefore['session:sess-a'] || 'BROUILLON-A-outils');
  assert.equal(draftsAfter['session:sess-b'], draftsBefore['session:sess-b'] || 'BROUILLON-B-outils');
  step('Reload restores every pin; A/B drafts survive.');
  const rm1After = await readToolFrame(page, rm1, 'plan-PA-atelier', 'rm1-reload');
  step('Locked content still owner-bound after reload.');
  await shot(page, 'ui-after-reload.png');

  // Close the source conversation tab of sess-a: pin must survive on live data.
  markPhase('source-closed');
  const sessAView = await openSessionInNewTab(page, 'Atelier', 'Alpha Atelier', 'sess-a');
  {
    await page.locator(TAB(sessAView)).click();
    await page.waitForTimeout(600);
    const closeBtn = page.locator(`[data-dock-close="${esc(sessAView)}"]`);
    assert.ok(await closeBtn.count(), 'chrome close for the source tab present (required)');
    {
      await closeBtn.click();
      await page.waitForTimeout(1000);
      const rm1Kept = await readToolFrame(page, rm1, 'plan-PA-atelier', 'rm1-source-closed');
      const lockKept = await lockState(page, rm1);
      assert.equal(lockKept?.pressed, 'true');
      step('Closing the source conversation tab never changes the pin (live identifiers).');
    }
    // Reopen sess-a via the real sidebar: same session, new view — pin stays live.
    await page.locator(`.session-row[data-session-id="sess-a"]`).first().click();
    await page.waitForTimeout(1200);
    const rm1Rebound = await readToolFrame(page, rm1, 'plan-PA-atelier', 'rm1-rebound');
    step('Source rebind (same session, new view) keeps the pin live.');
  }

  // Missing target: delete sess-b history on disk (real backend), reload.
  // First-of-kind tabs are all pinned to A, so lock the SECOND files tab to
  // B here (real UI) — it is the tab the missing-target assertions own.
  markPhase('missing-target');
  await focusSession(page, 'sess-b');
  await page.locator(LOCK(tabs.files[1])).click();
  await expectLocked(page, tabs.files[1], 'files1-B');
  await copyFile(join(sessionDir, 'sess-b.jsonl'), join(sessionDir, 'sess-b.jsonl.bak'));
  await rm(join(sessionDir, 'sess-b.jsonl'), { force: true });
  await page.reload();
  await expect(page.locator('#connection-label')).toContainText('connect', { timeout: 20000 });
  await page.waitForTimeout(1800);
  await activateToolTab(page, tabs.files[1], 'files2-missing');
  await expect.poll(() => frameText(page, tabs.files[1]).then((text) => text || ''), { timeout: 15000 }).not.toBe('');
  const files2Text = await frameText(page, tabs.files[1]);
  assert.ok(!files2Text.includes('Beta Vtrott') && !files2Text.includes('Alpha Atelier'), 'missing target never falls back to another session');
  const files2Lock = await lockState(page, tabs.files[1]);
  assert.equal(files2Lock?.pressed, 'true', 'missing pin stays locked, never silently rebound');
  const toolsMissing = await toolStorage(page);
  assert.equal((toolsMissing?.entries || []).find((e) => e.id === tabs.files[1])?.target?.sessionId, 'sess-b');
  step('Missing target shows unavailable, keeps its pin, never substitutes a session.');
  await copyFile(join(sessionDir, 'sess-b.jsonl.bak'), join(sessionDir, 'sess-b.jsonl'));
  await rm(join(sessionDir, 'sess-b.jsonl.bak'), { force: true });
  await shot(page, 'ui-missing-target.png');

  // ------------------------------------------------ Phase 6: blank-conversation pin promotes only its own session.
  // EXPLICIT requirement: a failing promotion FAILs this script (exit 1).
  // Pure node tests are additional proof, never an excuse. Only a fixture
  // that cannot perform the live send reports a blocked case (exit 2).
  markPhase('blank-promotion');
  async function blockedCase(name, detail) {
    await shot(page, 'ui-blocked-blank.png');
    await writeProof('blocked', { blockedCases: [`${name}: ${detail}`] });
    console.log(`blocked - ${name}: ${detail}`);
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await app.close().catch(() => {});
    await rm(temp, { recursive: true, force: true }).catch(() => {});
    process.exit(2);
  }
  async function failedCase(name, detail) {
    await shot(page, 'ui-failed-blank.png');
    await writeProof('fail', { failedCases: [`${name}: ${detail}`] });
    console.log(`fail - ${name}: ${detail}`);
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await app.close().catch(() => {});
    await rm(temp, { recursive: true, force: true }).catch(() => {});
    process.exit(1);
  }
  {
    await page.reload();
    await expect(page.locator('#connection-label')).toContainText('connect', { timeout: 20000 });
    await page.waitForTimeout(1500);
    const before = new Set(await convTabIds(page));
    const grp = await page.evaluate(() => [...document.querySelectorAll('[data-dock-group]')][0]?.dataset.dockGroup || null);
    await page.locator(`[data-dock-group="${grp}"] .dock-bar > .dock-chrome-button:not([data-dock-close])`).first().click();
    await expect(page.locator('#docking-context-menu')).toBeVisible({ timeout: 10000 });
    await page.locator('#docking-context-menu [aria-controls="docking-add-menu"]').first().click();
    await expect(page.locator('#docking-add-menu')).toBeVisible({ timeout: 10000 });
    await page.locator('#docking-add-menu [data-dock-add="new-conversation"]').click();
    await expect(page.locator('#conversation-picker')).toBeVisible({ timeout: 10000 });
    // Two-step picker: project rows first, the is-new row lives at the
    // session step. Either entry point is accepted, then is-new is required.
    let isNew = page.locator('#conversation-picker .conv-pick-row.is-new');
    if (!(await isNew.count())) {
      await page.locator('#conversation-picker .conv-pick-row').first().click();
      await page.waitForTimeout(800);
      isNew = page.locator('#conversation-picker .conv-pick-row.is-new');
    }
    if (!(await isNew.count())) await blockedCase('blank-promotion', 'no new-conversation row at session step');
    await isNew.first().click();
    await page.waitForTimeout(1500);
    const blank = (await convTabIds(page)).find((t) => !before.has(t));
    if (!blank) await blockedCase('blank-promotion', 'fixture cannot create a blank conversation tab (picker flow unavailable)');
    // Reuse unlocked rm3: 16 tool tabs are already mounted (5 primaries +
    // 3 roadmaps + 8 unit clones), so minting a 17th would hit the panel cap.
    // Locking an existing unlocked clone to the blank view tests the same
    // own-session promotion requirement.
    const rmBlank = rm3;
    await page.locator(LOCK(rmBlank)).click();
    await expectLocked(page, rmBlank, 'rmBlank');
    const toolsPre = await toolStorage(page);
    const targetPre = (toolsPre?.entries || []).find((e) => e.id === rmBlank)?.target || null;
    if (!targetPre || targetPre.sessionId) await blockedCase('blank-promotion', 'fixture blank pin carries no view/nonce target to promote');
    // Send capability probe (read-only): a fixture that cannot send reports
    // blocked INSTEAD of failing the product requirement.
    await page.locator(TAB(blank)).click();
    await expect.poll(() => page.locator(`[id="dock-view-${esc(blank)}"] [data-cvw="composer"], [id="dock-view-${esc(blank)}"] #composer`).count(), { timeout: 10000 }).toBeGreaterThan(0);
    const composer = page.locator(`[id="dock-view-${esc(blank)}"] [data-cvw="composer"], [id="dock-view-${esc(blank)}"] #composer`).first();
    const sendBtn = page.locator(`[id="dock-view-${esc(blank)}"] [data-cvw="send"], [id="dock-view-${esc(blank)}"] #send-button`).first();
    if (!(await composer.count()) || !(await sendBtn.count()))
      await blockedCase('blank-promotion', 'fixture cannot SSE-send (no composer/send in blank pane)');
    // Real send in the blank tab only; every assertion below is a hard FAIL.
    try {
      await composer.fill('Bonjour outil : lier cette session vierge');
      const runsBefore = requests.filter((r) => r.method === 'POST' && r.path === '/api/runs').length;
      await sendBtn.click();
      await expect.poll(() => toolStorage(page).then((st) => (st?.entries || []).find((e) => e.id === rmBlank)?.target?.sessionId || null), { timeout: 20000 }).not.toBe(null);
      const toolsPost = await toolStorage(page);
      const promoted = (toolsPost?.entries || []).find((e) => e.id === rmBlank)?.target || {};
      assert.ok(String(promoted.sessionId || '').startsWith('tt-new-'), `blank pin promoted to its own session (${promoted.sessionId})`);
      for (const id of [rm1, tabs.session[0]]) {
        const kept = (toolsPost?.entries || []).find((e) => e.id === id)?.target?.sessionId;
        const was = (toolsPre?.entries || []).find((e) => e.id === id)?.target?.sessionId;
        assert.equal(kept, was, `${id} untouched by the blank promotion`);
      }
      assert.equal(requests.filter((r) => r.method === 'POST' && r.path === '/api/runs').length, runsBefore + 1, 'exactly one run POST for the blank send');
      step('Blank-conversation pin promotes only its own session; sibling pins untouched.');
    } catch (e) {
      await failedCase('blank-promotion', String(e?.message || e).slice(0, 400));
    }
  }

  // ------------------------------------------------ Phase 7: layout + gates.
  markPhase('layout-gates');
  await page.locator('#open-docking').click();
  await expect(page.locator('#docking-settings')).toBeVisible({ timeout: 10000 });
  assert.ok(await page.locator('#docking-toggle').count(), 'toggle kept');
  assert.ok(await page.locator('#docking-reset').count(), 'Reset kept');
  assert.ok(await page.locator('#docking-preset-name').count(), 'presets kept');
  for (const gone of ['#docking-panel', '#docking-target', '#docking-zone', '#docking-move', '#docking-new-conversation']) {
    assert.equal(await page.locator(gone).count(), 0, `${gone} removed (simplified layout)`);
  }
  step('Agencement simplified: no opener/move form, Reset + presets kept.');
  await page.locator('#docking-close-settings').click();
  // Explicit opt-out respected: toggle OFF, reload, dock stays off.
  await page.locator('#open-docking').click();
  await expect(page.locator('#docking-settings')).toBeVisible({ timeout: 10000 });
  await page.locator('#docking-toggle').uncheck();
  await page.locator('#docking-close-settings').click();
  await page.reload();
  await expect(page.locator('#connection-label')).toContainText('connect', { timeout: 20000 });
  await page.waitForTimeout(1200);
  assert.equal(await page.locator('#dock-workspace').count(), 0, 'explicit enabled:false respected after reload');
  step('Explicit dock opt-out persists across reload.');
  // Mobile gate: 390px profile never docks.
  const mobileContext = await browser.newContext({ locale: 'fr-FR', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  await seedSelection(mobileContext, { cwd: cwdA, sessionId: 'sess-a', projectOverview: false });
  const mobile = await mobileContext.newPage();
  mobile.setDefaultTimeout(15000);
  await mobile.goto(url);
  await expect(mobile.locator('#connection-label')).toContainText('connect', { timeout: 20000 });
  await mobile.waitForTimeout(1200);
  assert.equal(await mobile.locator('#dock-workspace').count(), 0, 'mobile gate: no dock workspace');
  step('Mobile gate holds (no dock workspace at 390px).');
  await mobile.close();
  await mobileContext.close();
  await shot(page, 'ui-final.png');

  // ------------------------------------------------ Final tallies.
  const runPosts = requests.filter((r) => r.method === 'POST' && r.path === '/api/runs').length;
  assert.ok(runPosts <= 1, `at most one model run POST total, got ${runPosts}`);
  assert.deepEqual(errors, [], `zero page errors, got ${JSON.stringify(errors.slice(0, 2))}`);
  step(`Network fence holds: ${runPosts} run POST(s), roadmap POSTs owned, inspector owners clean.`);
  const endHashes = hashSurface();
  assert.deepEqual(endHashes, runMeta.sourceStart, 'source tree untouched mid-run');
  step('Source fence holds (no tree movement mid-run).');
  await writeProof('pass');
} catch (error) {
  try {
    await page?.screenshot({ path: join(OUT_ROOT, 'ui-failure.png') }).catch(() => {});
  } catch {}
  if (!proofWritten) {
    try {
      await writeProof('error', { harnessError: String(error?.message || error).slice(0, 800) });
    } catch {}
  }
  throw error;
} finally {
  await browser.close().catch(() => {});
  await app.close().catch(() => {});
  await rm(temp, { recursive: true, force: true }).catch(() => {});
}
