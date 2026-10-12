// Isolated docking desktop slice test (Unity-style dock, V4 geometry slice).
//
// SCOPE: this file ONLY. No other Studio source is edited by this test.
// STATUS: geometry V4 + tool instances + Agencement simplification contract
//   (see DOCK selectors below). The modular workspace defaults ON when no
//   choice was saved; panel opening and keyboard moves live in the tab
//   context menu (Add Tab only, no Move submenu), not in the settings dialog.
//   Integration (app-owned roots) is NOT ready: run
//   `node --check scripts/test-docking-ui.mjs` only until the parent
//   integrates the UI, then run this file for real.
// NEVER: production server, real provider account, real model, package.json
//   edit, build, commit or publish. Seeding uses the real createApp fixture
//   API plus normal UI input. Captures are genuine screenshots only: this test
//   never forces hidden/classes/DOM state for visuals (reading refs through
//   page.evaluate for identity comparison is allowed and is NOT UI forcing).

import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createApp } from '../server.mjs';
import { createLanGateway, hashAccessCode } from '../lib/lan.mjs';
import { createDefaultLayout, validateLayout } from '../public/docking-layout.js';
import { validatePresets, createPresetLayout } from '../public/docking-presets.js';

// ---------------------------------------------------------------------------
// Upcoming controller contract (implementation required; gaps are reported
// explicitly instead of failing with an obscure timeout).
// ---------------------------------------------------------------------------
const DOCK = {
  openButton: '#open-docking',
  dialog: '#docking-settings',
  toggle: '#docking-toggle',
  closeSettings: '#docking-close-settings',
  reset: '#docking-reset',
  workspace: '#dock-workspace',
  dropPreview: '.dock-drop-preview',
  menu: '#docking-context-menu',
  addMenu: '#docking-add-menu',
  moveMenu: '#docking-move-menu',
};
const STORAGE_KEY = 'prime-studio.docking.layout';
const layoutDefault = createDefaultLayout();
// Default-mounted V4 set: legacy primary conversation plus the four tool
// primaries docked by default (preferences mounts on demand via Add Tab).
const PANEL_IDS = ['conversation', 'roadmap', 'session', 'agents', 'files'];
const ZONES = ['center', 'left', 'right', 'top', 'bottom'];

const OUT_ROOT = resolve('.local/docking-4.3/captures');
const PROOF_PATH = join(OUT_ROOT, 'docking-ui-proof.json');
const SHOTS = {
  desktopDefault: 'docking-desktop-default.png',
  desktopRearranged: 'docking-desktop-rearranged.png',
  narrowConversation: 'docking-narrow-conversation.png',
  english: 'docking-en.png',
  mobileOff: 'docking-mobile-off.png',
  narrow260: 'docking-narrow-260-1081.png',
};

// ---------------------------------------------------------------------------
// Isolated fixture: real createApp routes/storage, synthetic sessions and
// roadmap, stub runtime (records starts/cancels, controllable live stream).
// ---------------------------------------------------------------------------
const temp = await mkdtemp(join(tmpdir(), 'prime-docking-ui-'));
const cwd = join(temp, 'Atelier');
const otherCwd = join(temp, 'Vtrott');
const sessionDir = join(temp, 'sessions');
const dataDir = join(temp, 'data');
await mkdir(cwd, { recursive: true });
await mkdir(otherCwd, { recursive: true });
await mkdir(sessionDir, { recursive: true });

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
  paragraphs.forEach((text, index) => {
    link(entry(`${id}-a${index}`, null, 'assistant', text));
    link(entry(`${id}-u${index + 1}`, null, 'user', `Suite ${index + 1} : que faut-il vérifier ensuite ?`));
  });
  link(
    entry(
      `${id}-final`,
      null,
      'assistant',
      'Synthèse disponible. Le panneau reste stable pendant le réarrangement.',
    ),
  );
  // Normalize parent chain (entry() already sets parentId via link()).
  const normalized = records.map((record) =>
    record.type === 'message' && record.parentId === undefined ? { ...record, parentId } : record,
  );
  await writeFile(file, normalized.map(JSON.stringify).join('\n') + '\n');
}
const longParagraphs = Array.from(
  { length: 14 },
  (_, i) =>
    `Paragraphe de remplissage ${i + 1} : la conversation doit défiler sur plusieurs écrans pour ` +
    'tester le détachement du défilement pendant les déplacements structurels. '.repeat(6),
);
await seedSession(
  join(sessionDir, 'docking-demo.jsonl'),
  'docking-demo',
  cwd,
  'Calibrer la sortie audio du Studio',
  longParagraphs,
);
await seedSession(
  join(sessionDir, 'docking-second.jsonl'),
  'docking-second',
  cwd,
  'Préparer la distribution Windows',
  longParagraphs.slice(0, 4),
);
await seedSession(
  join(sessionDir, 'docking-other.jsonl'),
  'docking-other',
  otherCwd,
  'Planifier la migration du volant',
  longParagraphs.slice(0, 4),
);

const starts = [];
let cancellations = 0;
const activeControls = [];
const runtime = {
  getStatus: async () => ({ available: true, version: 'fixture' }),
  getModels: async () => ({
    models: [{ id: 'fixture/docking', name: 'Docking fixture model', provider: 'fixture', reasoning: true }],
    default: { model: 'fixture/docking', thinking: 'medium' },
  }),
  async start(input) {
    const record = { message: input.message, sessionId: input.sessionId || 'docking-demo', cwd: input.cwd };
    starts.push(record);
    let resolveDone;
    const done = new Promise((resolveCompletion) => {
      resolveDone = resolveCompletion;
    });
    const control = {
      record,
      done,
      async finish(status = 'completed') {
        const result = {
          kind: 'done',
          sessionId: record.sessionId,
          status,
          code: status === 'completed' ? 0 : 130,
        };
        input.onEvent(result);
        resolveDone(result);
        return result;
      },
      cancel() {
        cancellations++;
        return control.finish('stopped');
      },
    };
    activeControls.push(control);
    setTimeout(() => input.onEvent({ kind: 'session', sessionId: record.sessionId, cwd: input.cwd }), 20);
    setTimeout(
      () =>
        input.onEvent({
          kind: 'message',
          message: { role: 'assistant', text: 'Flux simulé actif pendant le réarrangement.', tools: [] },
        }),
      60,
    );
    return control;
  },
  async close() {
    await Promise.all(activeControls.map((control) => control.finish('stopped')));
  },
};

const app = createApp({
  runtime,
  agentHome: join(temp, 'agent'),
  sessionDir,
  dataDir,
  initialCwd: cwd,
});
await app.store.project({ cwd });
await app.store.project({ cwd: otherCwd });
await mkdir(join(temp, 'agent'), { recursive: true });
// Seed roadmap through the real fixture API (mirrors scripts/test-roadmap-ui.mjs).
let roadmapDoc = await app.roadmap.read(cwd);
roadmapDoc = await app.roadmap.mutate(cwd, { action: 'init', expectedRevision: roadmapDoc.revision });
roadmapDoc = await app.roadmap.mutate(cwd, {
  action: 'vision',
  expectedRevision: roadmapDoc.revision,
  text: 'Rendre le dock du Studio fiable, mesurable et simple à utiliser.',
});
roadmapDoc = await app.roadmap.mutate(cwd, {
  action: 'milestone.create',
  expectedRevision: roadmapDoc.revision,
  title: 'Un bureau réarrangeable',
  status: 'active',
});
const milestoneId = roadmapDoc.overview.milestones[0].id;
await app.roadmap.mutate(cwd, {
  action: 'plan.create',
  expectedRevision: roadmapDoc.revision,
  title: 'Fiabiliser le déplacement des panneaux',
  milestone: milestoneId,
  steps: [{ text: 'Déplacer sans perdre le brouillon' }, { text: 'Conserver le flux actif' }],
});
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${app.server.address().port}`;

// ---------------------------------------------------------------------------
// Browser + helpers.
// ---------------------------------------------------------------------------
const browser = await launchStudioBrowser({ channel: 'chrome' });
const errors = [];
const checks = [];
const measurements = {};
const usedShots = {};
let proofWritten = false;

async function freshShot(name) {
  // Never overwrite earlier captures: first run keeps the deterministic name,
  // later collisions get a -2/-3 suffix recorded in the proof file.
  const { access } = await import('node:fs/promises');
  const direct = join(OUT_ROOT, name);
  try {
    await access(direct);
  } catch {
    usedShots[name] = name;
    return direct;
  }
  const dot = name.lastIndexOf('.');
  for (let n = 2; n < 50; n++) {
    const alt = `${name.slice(0, dot)}-${n}${name.slice(dot)}`;
    try {
      await access(join(OUT_ROOT, alt));
    } catch {
      usedShots[name] = alt;
      return join(OUT_ROOT, alt);
    }
  }
  throw new Error(`No free capture name for ${name}`);
}
function step(text) {
  checks.push(text);
  console.log(`ok - ${text}`);
}
async function seedSelection(context, selection, { docked = true } = {}) {
  await context.addInitScript(
    ({ sel, dockedMode, layout }) => {
      if (!localStorage.getItem('prime-studio.selection'))
        localStorage.setItem('prime-studio.selection', JSON.stringify(sel));
      // Deterministic dock preference without touching the DOM: an explicit
      // opt-out (enabled:false) keeps the classic baseline undocked, while a
      // missing envelope exercises the default-ON path for fresh profiles.
      if (!dockedMode && !localStorage.getItem('prime-studio.docking.layout'))
        localStorage.setItem('prime-studio.docking.layout', JSON.stringify(layout));
    },
    { sel: selection, dockedMode: docked, layout: { ...layoutDefault, enabled: false } },
  );
}
async function contractGaps(page) {
  // Probe without long waits: missing nodes mean the UI slice is not there yet.
  const probes = [
    ['openButton', DOCK.openButton],
    ['dialog', DOCK.dialog],
    ['toggle', DOCK.toggle],
    ['closeSettings', DOCK.closeSettings],
    ['reset', DOCK.reset],
    // NOTE: #dock-workspace is created lazily when the workspace activates
    // (default ON, no saved choice), so it is asserted after load, not in
    // this pre-activation probe. The tab context menu (#docking-context-menu
    // with #docking-add-menu / #docking-move-menu) is created with the
    // controller and appears on tab right-click once docked.
  ];
  const missing = [];
  for (const [name, selector] of probes) {
    const count = await page
      .locator(selector)
      .count()
      .catch(() => 0);
    if (count === 0) missing.push(`${name} (${selector})`);
  }
  return missing;
}
async function snapshotRefs(page) {
  return page.evaluate(() => {
    window.__dockingTestRefs = {
      conversation: document.querySelector('.conversation-column'),
      scroll: document.querySelector('#conversation-scroll'),
      composer: document.querySelector('#composer'),
      roadmap: document.querySelector('#roadmap-panel'),
      inspector: document.querySelector('#details-panel'),
      sidebar: document.querySelector('#sidebar'),
    };
    const value = (sel) => document.querySelector(sel)?.value ?? null;
    return {
      draft: value('#composer'),
      scrollTop: document.querySelector('#conversation-scroll')?.scrollTop ?? null,
    };
  });
}
async function expectRefsStable(page, before, label) {
  const same = await page.evaluate(() => {
    const refs = window.__dockingTestRefs;
    if (!refs) return null;
    const current = {
      conversation: document.querySelector('.conversation-column'),
      scroll: document.querySelector('#conversation-scroll'),
      composer: document.querySelector('#composer'),
      roadmap: document.querySelector('#roadmap-panel'),
      inspector: document.querySelector('#details-panel'),
      sidebar: document.querySelector('#sidebar'),
    };
    return Object.fromEntries(Object.entries(refs).map(([key, node]) => [key, current[key] === node]));
  });
  assert.ok(same, `${label}: __dockingTestRefs missing (page reloaded without re-snapshot?)`);
  for (const [key, identical] of Object.entries(same))
    assert.equal(identical, true, `${label}: DOM node changed for <${key}> (must move, not recreate)`);
  const draft = await page.locator('#composer').inputValue();
  assert.equal(draft, before.draft, `${label}: composer draft lost across structural move`);
}
async function layoutSignature(page) {
  return page.evaluate(() => {
    const groups = [...document.querySelectorAll('.dock-group[data-dock-group]')].map((group) => ({
      id: group.dataset.dockGroup,
      tabs: [...group.querySelectorAll('button[data-dock-tab]')].map((tab) => tab.dataset.dockTab),
      active: group.querySelector('button[data-dock-tab][aria-selected="true"]')?.dataset.dockTab ?? null,
      width: Math.round(group.getBoundingClientRect().width),
    }));
    const splits = [...document.querySelectorAll('.dock-splitter[data-dock-split]')].map(
      (split) => split.dataset.dockSplit,
    );
    const workspace = document.querySelector('#dock-workspace');
    const box = workspace?.getBoundingClientRect();
    return {
      groups,
      splits,
      workspaceActive: Boolean(workspace) && box.width > 0 && getComputedStyle(workspace).display !== 'none',
    };
  });
}
function findGroup(signature, id) {
  const group = signature.groups.find((entry) => entry.id === id);
  assert.ok(group, `Dock group ${id} must exist (got ${JSON.stringify(signature.groups)})`);
  return group;
}
async function expectDefaultLayout(page, label) {
  const signature = await layoutSignature(page);
  assert.equal(signature.workspaceActive, true, `${label}: #dock-workspace must be active on desktop`);
  assert.deepEqual(
    findGroup(signature, 'conversation-group').tabs,
    ['conversation'],
    `${label}: default conversation group`,
  );
  assert.deepEqual(
    findGroup(signature, 'tools-group').tabs,
    ['roadmap', 'session', 'agents', 'files'],
    `${label}: default tools group`,
  );
  assert.equal(
    findGroup(signature, 'tools-group').active,
    'roadmap',
    `${label}: tools group defaults to roadmap`,
  );
  const conv = findGroup(signature, 'conversation-group').width;
  const tools = findGroup(signature, 'tools-group').width;
  const ratio = conv / (conv + tools);
  assert.ok(Math.abs(ratio - 0.68) <= 0.06, `${label}: root row ratio ~0.68, got ${ratio.toFixed(3)}`);
  return signature;
}
async function storageEnvelope(page) {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    try {
      return { raw, parsed: JSON.parse(raw) };
    } catch {
      return { raw, parsed: null, malformed: true };
    }
  }, STORAGE_KEY);
}
async function measureNodes(page, label) {
  const data = await page.evaluate(() => {
    const rectOf = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const box = el.getBoundingClientRect();
      return { width: Math.round(box.width), height: Math.round(box.height) };
    };
    const labelOverflow = [...document.querySelectorAll('#dock-workspace button[data-dock-tab]')].map(
      (el) => ({
        tab: el.dataset.dockTab,
        text: (el.textContent || '').trim().slice(0, 40),
        overflow: el.scrollWidth > el.clientWidth + 1,
      }),
    );
    return {
      conversation: rectOf('.conversation-column'),
      roadmap: rectOf('#roadmap-panel'),
      inspector: rectOf('#dock-view-session'),
      workspace: rectOf('#dock-workspace'),
      labelOverflow,
      docOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
  measurements[label] = data;
  assert.equal(data.docOverflow, false, `${label}: document must not overflow horizontally`);
  for (const item of data.labelOverflow)
    assert.equal(item.overflow, false, `${label}: dock tab label overflows: ${item.tab} (${item.text})`);
  return data;
}
async function scrollState(page) {
  return page.evaluate(() => {
    const scroller = document.querySelector('#conversation-scroll');
    return {
      top: scroller.scrollTop,
      client: scroller.clientHeight,
      height: scroller.scrollHeight,
    };
  });
}
async function manuallyDetachScroller(page) {
  // Real user gesture only: hover the transcript, wheel up, wait for the
  // compositor to commit it, and require the product's own detach indicator
  // (the scroll-bottom button unhides only when off bottom). Never sets DOM
  // state directly.
  await page.locator('#conversation-scroll').hover();
  await page.mouse.wheel(0, -600);
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const scroller = document.querySelector('#conversation-scroll');
          return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
        }),
      { timeout: 10000 },
    )
    .toBeGreaterThan(20);
  await expect(page.locator('#scroll-bottom')).toBeVisible({ timeout: 10000 });
}
async function expectScrollDetached(page, label) {
  const state = await scrollState(page);
  measurements[`${label}-scroll`] = state;
  assert.ok(
    state.top < state.height - state.client - 20,
    `${label}: conversation scroller must stay manually detached (top=${state.top}, max=${state.height - state.client})`,
  );
  return state;
}
async function writeProof(extra = {}) {
  const payload = {
    status: 'pass',
    checks,
    errors,
    modelCalls: starts.length,
    cancellations,
    measurements,
    shots: usedShots,
    storageKey: STORAGE_KEY,
    ...extra,
  };
  await mkdir(OUT_ROOT, { recursive: true });
  await writeFile(PROOF_PATH, JSON.stringify(payload, null, 2));
  proofWritten = true;
  console.log(JSON.stringify({ checks: checks.length, errors, modelCalls: starts.length }, null, 2));
}

let page;
try {
  await mkdir(OUT_ROOT, { recursive: true });
  const context = await browser.newContext({
    locale: 'fr-FR',
    viewport: { width: 1600, height: 1000 },
    reducedMotion: 'reduce',
  });
  // Explicit opt-out seed: the classic baseline (Phase 0) runs undocked,
  // and Phase 1 opts in through the real toggle. Fresh profiles with no
  // seeded envelope exercise default-ON instead (Phase 12).
  await seedSelection(context, { cwd, sessionId: 'docking-demo', projectOverview: false }, { docked: false });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));

  // ------------------------------------------------ Phase 0: classic baseline.
  await page.goto(url);
  await expect(page.locator('#connection-label')).toContainText('connecté');
  await page.locator('#session-list .session-select').filter({ hasText: 'Calibrer la sortie' }).click();
  await expect(page.locator('#messages')).toContainText('Synthèse disponible');
  // Committed classic behavior hides #details-panel under the
  // body.roadmap-open overlay, so the inspector baseline runs BEFORE the
  // roadmap overlay opens. Nothing is forced in the DOM.
  if (!(await page.locator('#details-panel').isVisible())) await page.locator('#toggle-details').click();
  await page.locator('#inspector-tab-session').click();
  await expect(page.locator('#detail-project-name')).not.toBeEmpty();
  step('Classic baseline loads: conversation session and inspector render from fixture data.');

  // Mocked active stream started through the real UI (stub runtime, no model).
  await page.locator('#composer').fill('Vérifier la stabilité du dock pendant un flux actif');
  await page.locator('#send-button').click();
  await expect(page.locator('#stop-button')).toBeVisible();
  assert.equal(starts.length, 1, 'Exactly one stub run must start through the real send button');
  step(
    'Active mocked stream starts through the real composer; stub runtime records one start, zero cancels.',
  );

  // Classic roadmap overlay opens on top, then closes again through the
  // normal UI (close button), restoring the classic inspector before opt-in.
  await page.locator('#open-roadmap').click();
  await expect(page.locator('#roadmap-panel')).toContainText('Fiabiliser le déplacement');
  step('Classic roadmap overlay opens with fixture content.');
  await page.locator('#roadmap-panel .rm-close').click();
  await expect
    .poll(() => page.evaluate(() => document.body.classList.contains('roadmap-open')), { timeout: 10000 })
    .toBe(false);
  await expect(page.locator('#details-panel')).toBeVisible();
  step('Closing the roadmap overlay through the normal UI restores the classic inspector.');

  // Draft typed while the stream runs (composer stays enabled; only the send
  // button is gated) + manually detached scroll (real wheel input, never
  // forced state). Snapshot AFTER both, so every structural move below must
  // preserve the identical nodes, the draft value and the detached scroller.
  await page.locator('#composer').fill('Brouillon à conserver pendant le réarrangement');
  await manuallyDetachScroller(page);
  const refState = await snapshotRefs(page);
  assert.equal(refState.draft, 'Brouillon à conserver pendant le réarrangement');
  await expectScrollDetached(page, 'baseline');
  step('Composer draft typed and conversation scroller manually detached with a real wheel event.');

  // ------------------------------------------------ Contract preflight.
  const gaps = await contractGaps(page);
  if (gaps.length > 0) {
    await writeProof({ status: 'blocked', contractGaps: gaps });
    throw new Error(
      'Docking UI contract not implemented yet. Missing selectors: ' +
        gaps.join(', ') +
        '. Needed: #open-docking (opens native #docking-settings dialog), #docking-toggle checkbox ' +
        '(workspace on/off, default ON with no saved choice), #docking-close-settings, #docking-reset, ' +
        'tab context menu #docking-context-menu with #docking-add-menu (buttons[data-dock-add]) for ' +
        'keyboard-accessible Add Tab (no Move submenu: relocation is drag-only), ' +
        '#dock-workspace (active only >1080px) with .dock-group[data-dock-group] + ' +
        'buttons[data-dock-tab] (role=tab, draggable) + [data-dock-close] per group, ' +
        '.dock-splitter[data-dock-split] (role=separator, tabindex=0), .dock-drop-preview during ' +
        'internal drag, storage prime-studio.docking.layout {version:4,root,enabled:true} (V1-V3 migrated).',
    );
  }
  step(
    'Docking controller contract present: settings dialog, workspace toggle, workspace chrome and storage key.',
  );

  // ------------------------------------------------ Phase 1: opt-in + default.
  // The fixture seeds an explicit opt-out (enabled:false) so the classic
  // baseline above runs undocked; opting in here goes through the real
  // toggle. A fresh profile with no saved choice defaults ON (Phase 12).
  await page.locator('#open-docking').click();
  await expect(page.locator(DOCK.dialog)).toBeVisible();
  await page.locator(DOCK.toggle).check();
  await expect(page.locator(DOCK.workspace)).toBeVisible();
  const wideActive = await page.evaluate(() => window.matchMedia('(min-width: 1081px)').matches);
  assert.equal(wideActive, true, '1600px viewport must match the desktop docking gate');
  await expectRefsStable(page, refState, 'opt-in');
  await expectScrollDetached(page, 'opt-in');
  await expectDefaultLayout(page, 'default');
  // Persist through the normal UI (Reset commits), then pin the envelope.
  await page.locator(DOCK.reset).click();
  const envelope = await storageEnvelope(page);
  assert.ok(envelope?.parsed, 'Docking layout envelope must be stored');
  // Geometry V4: V1/V2/V3 docs are accepted and normalized to frozen V4 on
  // output, so the saved envelope is version 4. Exact pin, not a weakening.
  assert.equal(envelope.parsed.version, 4, 'Envelope version must be 4');
  assert.equal(envelope.parsed.enabled, true, 'Envelope must record enabled:true');
  assert.ok(envelope.parsed.root, 'Envelope must carry the layout root');
  await measureNodes(page, 'desktop-default');
  await page.screenshot({ path: await freshShot(SHOTS.desktopDefault), animations: 'disabled' });
  await page.locator(DOCK.closeSettings).click();
  await expect(page.locator(DOCK.dialog)).not.toBeVisible();
  step(
    'Opt-in enables desktop dock with default groups, 0.68 row ratio, roadmap active, persisted envelope.',
  );

  // ------------------------------------------------ Phase 2: real mouse drags.
  async function manualDrag(fromBox, toBox, observePreview) {
    await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
    await page.mouse.down();
    const steps = 10;
    let previewSeen = false;
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(
        fromBox.x + ((toBox.x - fromBox.x) * i) / steps,
        fromBox.y + ((toBox.y - fromBox.y) * i) / steps,
        { steps: 2 },
      );
      if (observePreview && i === Math.floor(steps / 2)) {
        previewSeen = await page
          .locator(DOCK.dropPreview)
          .isVisible()
          .catch(() => false);
      }
    }
    // Chromium native HTML5 DnD: repeat the final move onto the new target so
    // dragover hit-testing engages before mouse.up fires drop.
    await page.mouse.move(toBox.x, toBox.y);
    await page.mouse.move(toBox.x, toBox.y);
    if (observePreview && !previewSeen)
      previewSeen = await page
        .locator(DOCK.dropPreview)
        .isVisible()
        .catch(() => false);
    await page.mouse.up();
    return previewSeen;
  }
  // 2a. Center drop: session tool tab -> conversation group center.
  // The tab strip scrolls when tabs overflow: bring the source tab into view
  // through the normal UI first so the grab point lands on the tab itself.
  await page.locator('button[data-dock-tab="session"]').scrollIntoViewIfNeeded();
  const sessionTabBox = await page.locator('button[data-dock-tab="session"]').boundingBox();
  const convGroupBox = await page.locator('.dock-group[data-dock-group="conversation-group"]').boundingBox();
  const previewCenter = await manualDrag(
    {
      x: sessionTabBox.x,
      y: sessionTabBox.y,
      width: sessionTabBox.width,
      height: sessionTabBox.height,
    },
    {
      x: convGroupBox.x + convGroupBox.width / 2,
      y: convGroupBox.y + convGroupBox.height / 2,
      width: 4,
      height: 4,
    },
    true,
  );
  assert.equal(previewCenter, true, '.dock-drop-preview must show during internal center drag');
  let signature = await layoutSignature(page);
  assert.deepEqual(
    findGroup(signature, 'conversation-group').tabs,
    ['conversation', 'session'],
    'Center drop adds the session tool tab to the conversation group',
  );
  await expectRefsStable(page, refState, 'center-drop');
  step(
    'Real mouse center drag moves the session tool tab into the conversation group with a visible drop preview.',
  );

  // 2b. Edge split: roadmap tab -> right edge of conversation group.
  await page.locator('button[data-dock-tab="roadmap"]').scrollIntoViewIfNeeded();
  const roadmapTabBox = await page.locator('button[data-dock-tab="roadmap"]').boundingBox();
  const convBox2 = await page.locator('.dock-group[data-dock-group="conversation-group"]').boundingBox();
  const previewEdge = await manualDrag(
    { x: roadmapTabBox.x, y: roadmapTabBox.y, width: roadmapTabBox.width, height: roadmapTabBox.height },
    { x: convBox2.x + convBox2.width - 8, y: convBox2.y + convBox2.height / 2, width: 4, height: 4 },
    true,
  );
  assert.equal(previewEdge, true, '.dock-drop-preview must show during edge split drag');
  signature = await layoutSignature(page);
  const roadmapGroup = signature.groups.find((group) => group.tabs.includes('roadmap'));
  assert.ok(roadmapGroup && roadmapGroup.id !== 'tools-group', 'Edge drop splits roadmap into its own group');
  assert.ok(signature.splits.length >= 1, 'A splitter must exist after an edge split');
  await expectRefsStable(page, refState, 'edge-split');
  step('Real mouse edge drag splits the roadmap tab into a new group with a splitter.');

  // 2c. Tab ordering with a real mouse drag inside one group. The drop lands
  // on the trailing edge of the last tab: an unambiguous "move to end" under
  // remove-source-before-insertion (a center drop is not a directed gesture).
  const orderBefore = (await layoutSignature(page)).groups.find((group) =>
    group.tabs.includes('session'),
  )?.tabs;
  assert.ok(orderBefore && orderBefore.length >= 2, 'Need two tabs in one group to test ordering');
  // Post-split groups are narrow and tab strips scroll: bring both drag ends
  // into view through the normal UI before measuring, so the drop point lands
  // inside the target group's bar.
  await page.locator(`button[data-dock-tab="${orderBefore[0]}"]`).scrollIntoViewIfNeeded();
  await page
    .locator(`button[data-dock-tab="${orderBefore[orderBefore.length - 1]}"]`)
    .scrollIntoViewIfNeeded();
  const reorderFrom = await page.locator(`button[data-dock-tab="${orderBefore[0]}"]`).boundingBox();
  const reorderLast = await page
    .locator(`button[data-dock-tab="${orderBefore[orderBefore.length - 1]}"]`)
    .boundingBox();
  await manualDrag(
    { x: reorderFrom.x, y: reorderFrom.y, width: reorderFrom.width, height: reorderFrom.height },
    { x: reorderLast.x + reorderLast.width - 4, y: reorderLast.y + reorderLast.height / 2 },
    false,
  );
  const orderAfter = (await layoutSignature(page)).groups.find((group) =>
    group.tabs.includes('session'),
  )?.tabs;
  assert.deepEqual([...orderAfter].sort(), [...orderBefore].sort(), 'Same tabs must remain after reorder');
  assert.notDeepEqual(orderAfter, orderBefore, 'Real tab drag must change tab order');
  await expectRefsStable(page, refState, 'tab-reorder');
  step('Real mouse tab drag reorders tabs inside a group.');

  // 2d. Escape cancels an in-flight drag.
  const sigBeforeEscape = await layoutSignature(page);
  const escTab = await page.locator('button[data-dock-tab="conversation"]').boundingBox();
  const toolsBox = await page
    .locator('.dock-group[data-dock-group="tools-group"]')
    .boundingBox()
    .catch(() => null);
  const escapeTarget = toolsBox ?? (await page.locator('.dock-group[data-dock-group]').first().boundingBox());
  await page.mouse.move(escTab.x + escTab.width / 2, escTab.y + escTab.height / 2);
  await page.mouse.down();
  await page.mouse.move(escapeTarget.x + escapeTarget.width / 2, escapeTarget.y + 40, { steps: 6 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.equal(
    await page
      .locator(DOCK.dropPreview)
      .isVisible()
      .catch(() => false),
    false,
    'Drop preview must hide after Escape cancels the drag',
  );
  const sigAfterEscape = await layoutSignature(page);
  assert.deepEqual(
    sigAfterEscape.groups.map((group) => [group.id, group.tabs]),
    sigBeforeEscape.groups.map((group) => [group.id, group.tabs]),
    'Escape must cancel the drag without changing group membership',
  );
  await expectRefsStable(page, refState, 'escape-drag');
  step('Escape cancels an in-flight tab drag: preview hides, layout unchanged.');

  // Stream must survive every structural move untouched.
  await expectScrollDetached(page, 'post-drag');
  assert.equal(starts.length, 1, 'No structural move may restart the mocked run');
  assert.equal(cancellations, 0, 'No structural move may cancel the mocked run');
  await expect(page.locator('#stop-button')).toBeVisible();
  step('Mocked active stream continues through all drags: one start, zero cancels, stop control still live.');

  // ------------------------------------------------ Phase 3: keyboard.
  const tabs = page.locator('button[data-dock-tab]');
  await tabs.first().focus();
  const focusedBefore = await page.evaluate(() => document.activeElement?.dataset?.dockTab ?? null);
  await page.keyboard.press('ArrowRight');
  const focusedAfter = await page.evaluate(() => document.activeElement?.dataset?.dockTab ?? null);
  assert.ok(focusedBefore, 'A dock tab must be focusable');
  assert.ok(
    focusedAfter && focusedAfter !== focusedBefore,
    `ArrowRight must move tab focus (${focusedBefore} -> ${focusedAfter})`,
  );
  await page.keyboard.press('ArrowLeft');
  const focusedBack = await page.evaluate(() => document.activeElement?.dataset?.dockTab ?? null);
  assert.equal(focusedBack, focusedBefore, 'ArrowLeft must return tab focus');
  step('Keyboard tab navigation moves focus between dock tabs with arrow keys.');
  // Arrow-key tab travel auto-activates the focused tab, which can leave the
  // conversation panel hidden. Re-activate it through the normal UI so the
  // scroller stays measurable for the structural checks below.
  await page.locator('button[data-dock-tab="conversation"]').click();
  await expect(page.locator('.dock-group[data-dock-group="conversation-group"]')).toBeVisible();
  // Orientation-aware: row splits (aria-orientation=vertical) take
  // ArrowLeft/ArrowRight, column splits take ArrowUp/ArrowDown.
  const rowSplitter = page.locator('.dock-splitter[data-dock-split][aria-orientation="vertical"]');
  const hasRowSplit = ((await rowSplitter.count()) ?? 0) > 0;
  const splitter = hasRowSplit
    ? rowSplitter.first()
    : page.locator('.dock-splitter[data-dock-split]').first();
  const nudgeKey = hasRowSplit ? 'ArrowRight' : 'ArrowDown';
  await splitter.focus();
  assert.equal(await splitter.getAttribute('role'), 'separator', 'Splitter must expose role=separator');
  const splitterId = await splitter.getAttribute('data-dock-split');
  assert.equal(
    await page.evaluate((id) => document.activeElement?.dataset?.dockSplit === id, splitterId),
    true,
    'Splitter must actually hold keyboard focus before nudging',
  );
  const widthsBefore = (await layoutSignature(page)).groups.map((group) => group.width);
  await page.keyboard.press(nudgeKey);
  await page.keyboard.press(nudgeKey);
  // The dock chrome can pin geometry briefly (entrance fill); poll for the
  // settled resize like any async UI state instead of a single snapshot.
  await expect
    .poll(() => layoutSignature(page).then((signature) => signature.groups.map((group) => group.width)), {
      timeout: 10000,
    })
    .not.toEqual(widthsBefore);
  const widthsAfter = (await layoutSignature(page)).groups.map((group) => group.width);
  assert.notDeepEqual(widthsAfter, widthsBefore, 'Separator arrow keys must nudge the split');
  await expectRefsStable(page, refState, 'keyboard-nudge');
  await expectScrollDetached(page, 'keyboard-nudge');
  step('Keyboard separator nudge resizes adjacent groups; DOM refs and draft survive.');

  // ------------------------------------------------ Phase 4: context menu (no Move) + drag relocation.
  // The settings dialog holds no move controls; the tab context menu offers
  // Add Tab only (the Move submenu was removed as user-authorized). All
  // relocation goes through real pointer drags (manualDrag, Phase 2).
  signature = await layoutSignature(page);
  // The edge split dissolved the default tools-group, so the drag move
  // targets a group that actually exists: the one not holding session.
  const menuTarget = signature.groups.find((group) => !group.tabs.includes('session'));
  assert.ok(menuTarget, 'A second live group must exist as the drag-move target');
  // Keyboard-only path first: focus the tab, open with Shift+F10, Escape
  // restores focus to the tab.
  await page.locator('button[data-dock-tab="session"]').focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.locator(DOCK.menu)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator(DOCK.menu)).not.toBeVisible();
  assert.equal(
    await page.evaluate(() => document.activeElement?.dataset?.dockTab ?? null),
    'session',
    'Escape must return focus to the invoking tab',
  );
  step('Keyboard-only tab menu opens with Shift+F10 and closes with Escape.');
  // Move submenu must be absent: right-click shows the tab menu with Add Tab
  // only, no Move entry, no move popup, no [data-dock-move] items anywhere.
  await page.locator('button[data-dock-tab="session"]').click({ button: 'right' });
  await expect(page.locator(DOCK.menu)).toBeVisible();
  assert.equal(
    await page.locator(`${DOCK.menu} [aria-controls="docking-move-menu"]`).count(),
    0,
    'No Move submenu entry may exist in the tab context menu',
  );
  assert.equal(await page.locator(DOCK.moveMenu).count(), 0, '#docking-move-menu must be absent from the DOM');
  assert.equal(await page.locator('[data-dock-move]').count(), 0, 'No [data-dock-move] items may exist');
  await page.keyboard.press('Escape');
  await expect(page.locator(DOCK.menu)).not.toBeVisible();
  step('Move submenu absent: tab menu offers Add Tab only, no move controls.');
  // Real drag relocation: session tab -> center of the target group.
  await page.locator('button[data-dock-tab="session"]').scrollIntoViewIfNeeded();
  const dragFrom = await page.locator('button[data-dock-tab="session"]').boundingBox();
  const dragTargetBar = await page.locator(`[data-dock-group="${menuTarget.id}"] .dock-tabs`).boundingBox();
  const dragPreview = await manualDrag(
    { x: dragFrom.x, y: dragFrom.y, width: dragFrom.width, height: dragFrom.height },
    {
      x: dragTargetBar.x + dragTargetBar.width / 2,
      y: dragTargetBar.y + dragTargetBar.height / 2,
      width: 4,
      height: 4,
    },
    true,
  );
  assert.equal(dragPreview, true, '.dock-drop-preview must show during the relocation drag');
  await expect
    .poll(() => layoutSignature(page).then((sig) => findGroup(sig, menuTarget.id).tabs.includes('session')), {
      timeout: 10000,
    })
    .toBe(true);
  signature = await layoutSignature(page);
  assert.ok(
    findGroup(signature, menuTarget.id).tabs.includes('session'),
    `Drag move relocates session into ${menuTarget.id}`,
  );
  await expectRefsStable(page, refState, 'menu-move');
  step('Drag relocation moves the session tab into the target group with a visible drop preview.');

  // ------------------------------------------------ Phase 5: splitter pointer resize + Escape.
  const splitRow = page.locator('.dock-splitter[data-dock-split][aria-orientation="vertical"]');
  const splitIsRow = ((await splitRow.count()) ?? 0) > 0;
  const split = splitIsRow ? splitRow.first() : page.locator('.dock-splitter[data-dock-split]').first();
  await expect(split).toHaveAttribute('tabindex', '0');
  // Drag along the split's main axis: x for row splits, y for column splits.
  const axis = (box, delta) =>
    splitIsRow
      ? { x: box.x + delta, y: box.y + box.height / 2 }
      : { x: box.x + box.width / 2, y: box.y + delta };
  const splitBox = await split.boundingBox();
  const sigBeforeResize = await layoutSignature(page);
  await page.mouse.move(splitBox.x + splitBox.width / 2, splitBox.y + splitBox.height / 2);
  await page.mouse.down();
  const resizeTarget = axis(splitBox, 120);
  await page.mouse.move(resizeTarget.x, resizeTarget.y, { steps: 8 });
  await page.mouse.move(resizeTarget.x, resizeTarget.y);
  await page.mouse.up();
  const sigAfterResize = await layoutSignature(page);
  assert.notDeepEqual(
    sigAfterResize.groups.map((group) => group.width),
    sigBeforeResize.groups.map((group) => group.width),
    'Pointer splitter drag must resize adjacent groups',
  );
  const widthsMid = sigAfterResize.groups.map((group) => group.width);
  const splitBox2 = await split.boundingBox();
  await page.mouse.move(splitBox2.x + splitBox2.width / 2, splitBox2.y + splitBox2.height / 2);
  await page.mouse.down();
  // Extreme move (+200px, into min-clamp territory): Escape must still cancel
  // back to the pre-drag geometry. Settle-polling absorbs the brief stuck
  // headless-Chromium transition fill (see proof notes).
  const cancelTarget = axis(splitBox2, 200);
  await page.mouse.move(cancelTarget.x, cancelTarget.y, { steps: 6 });
  await page.mouse.move(cancelTarget.x, cancelTarget.y);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect
    .poll(() => layoutSignature(page).then((signature) => signature.groups.map((group) => group.width)), {
      timeout: 10000,
    })
    .toEqual(widthsMid);
  const widthsEscaped = (await layoutSignature(page)).groups.map((group) => group.width);
  assert.deepEqual(widthsEscaped, widthsMid, 'Escape must cancel an in-flight splitter resize');
  await expectRefsStable(page, refState, 'splitter-resize');
  step('Splitter pointer drag resizes groups; Escape cancels an in-flight resize.');

  // ------------------------------------------------ Phase 6: close + reopen (same node).
  await page.locator('[data-dock-close="session"]').first().click();
  signature = await layoutSignature(page);
  assert.ok(
    !signature.groups.some((group) => group.tabs.includes('session')),
    'Closing the session tool tab must remove it from every group',
  );
  // Reopen goes through the real Add Tab submenu: with zero session-kind
  // tabs open, the session entry reopens the closed primary.
  const anyTab = page.locator('button[data-dock-tab]').first();
  await anyTab.click({ button: 'right' });
  await expect(page.locator(DOCK.menu)).toBeVisible();
  await page.locator(`${DOCK.menu} .dock-menu-submenu`).first().hover();
  await expect(page.locator(DOCK.addMenu)).toBeVisible();
  await page.locator(`${DOCK.addMenu} button[data-dock-add="session"]`).click();
  signature = await layoutSignature(page);
  assert.ok(
    signature.groups.some((group) => group.tabs.includes('session')),
    'Add Tab must restore the session tool tab',
  );
  // Reopen shows (activates) the session tab, backgrounding the conversation.
  // Re-activate the conversation through the normal UI for the checks below.
  await page.locator('button[data-dock-tab="conversation"]').click();
  await expect(page.locator('.dock-group[data-dock-group="conversation-group"]')).toBeVisible();
  await expectRefsStable(page, refState, 'close-reopen');
  await expectScrollDetached(page, 'close-reopen');
  step('Per-group close hides the active tab; reopen restores the identical DOM node.');

  // ------------------------------------------------ Phase 6b: tool instances + named presets.
  // Controller checks: a valid 8-tool replacement preset must load over a
  // current 16-tool layout (old geometry never gates future geometry), and
  // parked instances must be reused (same ids, locks preserved) instead of
  // minted again — including across a reload via parent parked metadata.
  const toolTabsOf = async () =>
    (await layoutSignature(page)).groups
      .flatMap((group) => group.tabs)
      .filter((tab) => tab.startsWith('tool:'));
  // Build to the 16-tool cap through the real Add Tab menu: 11 roadmap extras
  // join the five primaries.
  for (let n = 0; n < 11; n++) {
    await page.locator('button[data-dock-tab]').first().click({ button: 'right' });
    await expect(page.locator(DOCK.menu)).toBeVisible();
    await page.locator(`${DOCK.menu} .dock-menu-submenu`).first().hover();
    await expect(page.locator(DOCK.addMenu)).toBeVisible();
    await page.locator(`${DOCK.addMenu} button[data-dock-add="roadmap"]`).click();
  }
  // Preferences stays closed by default: reopen its primary through Add Tab.
  await page.locator('button[data-dock-tab]').first().click({ button: 'right' });
  await expect(page.locator(DOCK.menu)).toBeVisible();
  await page.locator(`${DOCK.menu} .dock-menu-submenu`).first().hover();
  await expect(page.locator(DOCK.addMenu)).toBeVisible();
  await page.locator(`${DOCK.addMenu} button[data-dock-add="preferences"]`).click();
  const sixteenIds = (await toolTabsOf()).sort();
  assert.equal(sixteenIds.length, 11, 'eleven roadmap instances join the five primaries');
  assert.ok(
    (await layoutSignature(page)).groups
      .flatMap((g) => g.tabs)
      .filter((id) => ['roadmap', 'session', 'agents', 'files', 'preferences'].includes(id) || id.startsWith('tool:')).length === 16,
    'sixteen tool tabs mounted in total',
  );
  step('Eleven roadmap tool instances mount through Add Tab (16-tool cap).');
  // Save the sixteen layout through the normal UI.
  await page.locator('#open-docking').click();
  await expect(page.locator(DOCK.dialog)).toBeVisible();
  await page.locator('#docking-preset-name').fill('sixteen');
  await page.locator('#docking-save-layout').click();
  assert.equal(
    await page.locator('#docking-preset-choice').inputValue(),
    'sixteen',
    'saved sixteen preset becomes the selected layout',
  );
  await page.locator(DOCK.closeSettings).click();
  await expect(page.locator(DOCK.dialog)).not.toBeVisible();
  // Seed a valid 8-tool replacement preset (different kinds: files/agents
  // extras the live layout never had) built with the real geometry modules,
  // merged into the stored presets doc like any persisted entry.
  const liveEight = validateLayout({
    version: 4,
    root: {
      kind: 'group',
      id: 'seed',
      panels: [
        'conversation',
        'roadmap',
        'session',
        'agents',
        'files',
        'tool:files:seed-f1',
        'tool:files:seed-f2',
        'tool:files:seed-f3',
        'tool:files:seed-f4',
        'tool:agents:seed-a1',
        'tool:agents:seed-a2',
        'tool:agents:seed-a3',
        'tool:agents:seed-a4',
      ],
      active: 'roadmap',
    },
  });
  assert.ok(liveEight, 'seed live eight-tool layout validates');
  const eightAnon = createPresetLayout(liveEight);
  assert.ok(eightAnon && !JSON.stringify(eightAnon).includes('seed-'), 'seed preset anonymized');
  await page.evaluate((eight) => {
    const key = 'prime-studio.docking.presets';
    const doc = JSON.parse(localStorage.getItem(key) || '{"version":1,"items":[]}');
    doc.items.push({ name: 'eight', layout: eight });
    localStorage.setItem(key, JSON.stringify(doc));
  }, eightAnon);
  // Reload: parked tool metadata must restore the identical sixteen ids.
  await page.reload();
  await expect(page.locator('#connection-label')).toContainText('connecté');
  await expect(page.locator(DOCK.workspace)).toBeVisible();
  assert.deepEqual(
    (await toolTabsOf()).sort(),
    sixteenIds,
    'reload restores the parked sixteen tool ids identically',
  );
  // Fresh refs: the reload rebuilt every DOM node, so later structural
  // checks compare against this post-reload snapshot (never pre-reload refs).
  const refStateTools = await snapshotRefs(page);
  step('Reload restores parked tool instances with identical ids (no lock loss).');
  // Load the 8-tool replacement over the current 16-tool layout: deficits of
  // never-seen kinds must be created, never rejected against old geometry.
  await page.locator('#open-docking').click();
  await expect(page.locator(DOCK.dialog)).toBeVisible();
  await page.locator('#docking-preset-choice').selectOption('eight');
  await page.locator('#docking-load-layout').click();
  await page.locator(DOCK.closeSettings).click();
  await expect(page.locator(DOCK.dialog)).not.toBeVisible();
  const eightIds = (await toolTabsOf()).sort();
  assert.equal(eightIds.length, 8, 'eight replacement tool tabs mount over sixteen current');
  assert.ok(
    eightIds.every((id) => id.startsWith('tool:files:') || id.startsWith('tool:agents:')),
    'replacement binds the seeded files/agents kinds',
  );
  assert.ok(eightIds.every((id) => !id.includes('seed-')), 'no seed nonce leaks into live ids');
  step('Valid 8-tool replacement preset loads over a 16-tool layout (deficits created).');
  // Round-trip back: the parked roadmap ids must be reused identically.
  await page.locator('#open-docking').click();
  await expect(page.locator(DOCK.dialog)).toBeVisible();
  await page.locator('#docking-preset-choice').selectOption('sixteen');
  await page.locator('#docking-load-layout').click();
  await page.locator(DOCK.closeSettings).click();
  await expect(page.locator(DOCK.dialog)).not.toBeVisible();
  assert.deepEqual(
    (await toolTabsOf()).sort(),
    sixteenIds,
    'loading sixteen reuses the parked roadmap ids (no duplicates minted)',
  );
  step('Preset round-trip reuses parked tool ids instead of minting new ones.');
  // Reset to the default layout so later phases run on known geometry.
  await page.locator('#open-docking').click();
  await page.locator(DOCK.reset).click();
  await page.locator(DOCK.closeSettings).click();
  await expectDefaultLayout(page, 'presets-reset');
  await expectRefsStable(page, refStateTools, 'presets-reset');

  await measureNodes(page, 'desktop-rearranged');
  await page.screenshot({ path: await freshShot(SHOTS.desktopRearranged), animations: 'disabled' });

  // Narrow conversation: shrink the conversation group, keep labels intact.
  const narrowSplit = page.locator('.dock-splitter[data-dock-split]').first();
  const narrowBox = await narrowSplit.boundingBox();
  await page.mouse.move(narrowBox.x + narrowBox.width / 2, narrowBox.y + narrowBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(narrowBox.x - 260, narrowBox.y + narrowBox.height / 2, { steps: 8 });
  await page.mouse.up();
  const narrowed = await measureNodes(page, 'narrow-conversation');
  assert.ok(
    narrowed.conversation.width < measurements['desktop-default'].conversation.width,
    'Conversation group must actually shrink for the narrow capture',
  );
  await page.screenshot({ path: await freshShot(SHOTS.narrowConversation), animations: 'disabled' });
  await expectRefsStable(page, refState, 'narrow');
  step('Narrow-conversation capture keeps tab labels readable with no overflow.');

  // ------------------------------------------------ Phase 7: reload persistence.
  const envelopeBefore = await storageEnvelope(page);
  signature = await layoutSignature(page);
  await page.reload();
  await expect(page.locator('#connection-label')).toContainText('connecté');
  await expect(page.locator(DOCK.workspace)).toBeVisible();
  const signatureReloaded = await layoutSignature(page);
  assert.deepEqual(
    signatureReloaded.groups.map((group) => [group.id, group.tabs, group.active]),
    signature.groups.map((group) => [group.id, group.tabs, group.active]),
    'Reload must restore group membership and the active tab from storage',
  );
  const refStateReloaded = await snapshotRefs(page);
  refStateReloaded.draft = await page
    .locator('#composer')
    .inputValue()
    .catch(() => null);
  step('Reload restores the persisted dock layout from the storage envelope.');

  // ------------------------------------------------ Phase 8: malformed store, no crash.
  await page.evaluate((key) => localStorage.setItem(key, 'not-json{{{'), STORAGE_KEY);
  await page.reload();
  await expect(page.locator('#connection-label')).toContainText('connecté');
  await expect(page.locator('.conversation-column')).toBeVisible();
  await page.locator('#open-docking').click();
  await expect(page.locator(DOCK.dialog)).toBeVisible();
  await page.locator(DOCK.toggle).check();
  await expectDefaultLayout(page, 'malformed-fallback');
  await page.locator(DOCK.closeSettings).click();
  const refStateClean = await snapshotRefs(page);
  step('Malformed storage falls back to the default layout with no crash and no page error.');

  // ------------------------------------------------ Phase 9: reset.
  // Any edge split rearranges (drag the roadmap tab to the left edge);
  // Reset must then restore the default layout.
  await page.locator('button[data-dock-tab="roadmap"]').scrollIntoViewIfNeeded();
  {
    const rmBox = await page.locator('button[data-dock-tab="roadmap"]').boundingBox();
    const rmGroupBox = await page.locator('button[data-dock-tab="roadmap"]').evaluate((tab) => {
      const box = tab.closest('[data-dock-group]')?.getBoundingClientRect();
      return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
    });
    await manualDrag(
      { x: rmBox.x, y: rmBox.y, width: rmBox.width, height: rmBox.height },
      { x: rmGroupBox.x + 6, y: rmGroupBox.y + rmGroupBox.height / 2, width: 4, height: 4 },
      true,
    );
    await page.waitForTimeout(800);
  }
  await page.locator('#open-docking').click();
  await page.locator(DOCK.reset).click();
  await page.locator(DOCK.closeSettings).click();
  await expectDefaultLayout(page, 'reset');
  await expectRefsStable(page, refStateClean, 'reset');
  step('Reset restores the default conversation/tools layout after rearrangement.');

  // ------------------------------------------------ Phase 10: project/context switches stay fresh.
  // Session/Agents/Files are separate dock tabs now: activate each through
  // the normal UI and check its live content follows context switches.
  await page.locator('button[data-dock-tab="agents"]').click();
  await expect(page.locator('#dock-view-agents')).toBeVisible();
  await page.locator('button[data-dock-tab="files"]').click();
  await expect(page.locator('#dock-view-files')).toBeVisible();
  await page.locator('button[data-dock-tab="session"]').click();
  await expect(page.locator('#dock-view-session')).toBeVisible();
  await page.locator('#session-list .session-select').filter({ hasText: 'Préparer la distribution' }).click();
  await expect(page.locator('#messages')).toContainText('Préparer la distribution');
  await page.locator('#session-list .session-select').filter({ hasText: 'Calibrer la sortie' }).click();
  await expect(page.locator('#messages')).toContainText('Synthèse disponible');
  // No overlay click while docked (classic .roadmap-open CSS would hide the
  // docked panels): the docked panel keeps its DOM content either way.
  await expect(page.locator('#roadmap-panel')).toContainText('Rendre le dock du Studio fiable');
  step('Roadmap and Session/Agents/Files tool tabs follow project/context switches.');

  // Read-only gateway spot check (quick; documents coverage otherwise).
  const salt = 'd'.repeat(32);
  const code = '12345678';
  const gateway = createLanGateway({
    host: '127.0.0.1',
    upstreamPort: app.server.address().port,
    config: { salt, codeHash: hashAccessCode(code, salt), readOnly: true },
  });
  await new Promise((done) => gateway.listen(0, '127.0.0.1', done));
  try {
    const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;
    assert.equal((await fetch(`${gatewayUrl}/api/project-files?cwd=${encodeURIComponent(cwd)}`)).status, 401);
    // Anonymous (no access grant) run creation is rejected with 401 before
    // any read-only permission check; either way the gateway admits nothing.
    assert.equal(
      (
        await fetch(`${gatewayUrl}/api/runs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
      401,
    );
    step('Read-only gateway rejects anonymous file listing and run creation (401).');
  } finally {
    gateway.closeAllConnections();
    await new Promise((done) => gateway.close(done));
  }

  // ------------------------------------------------ Phase 11: responsive gate + mobile modality.
  await page.setViewportSize({ width: 800, height: 900 });
  await expect(page.locator(DOCK.workspace)).not.toBeVisible();
  await expect(page.locator('.workspace-body > .conversation-column')).toBeVisible();
  assert.equal(
    await page.evaluate(() => window.matchMedia('(min-width: 1081px)').matches),
    false,
    '800px must leave the desktop docking gate',
  );
  step('At 800px the dock workspace gates off and classic nodes return.');

  const mobileContext = await browser.newContext({
    locale: 'fr-FR',
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: 'reduce',
  });
  await seedSelection(mobileContext, { cwd, sessionId: 'docking-demo', projectOverview: false });
  const mobile = await mobileContext.newPage();
  mobile.setDefaultTimeout(15000);
  mobile.on('pageerror', (error) => errors.push(error.message));
  await mobile.goto(url);
  await expect(mobile.locator('#connection-label')).toContainText('connecté');
  assert.equal(await mobile.locator(DOCK.workspace).count(), 0, 'No dock workspace may exist at 390px');
  await mobile
    .locator('#toggle-sidebar')
    .click()
    .catch(() => {});
  await mobile.locator('#session-list .session-select').filter({ hasText: 'Calibrer la sortie' }).click();
  if (!(await mobile.locator('#details-panel').isVisible())) await mobile.locator('#toggle-details').click();
  await expect(mobile.locator('#details-panel')).toBeVisible();
  await mobile
    .locator('#close-inspector')
    .focus()
    .catch(() => {});
  await mobile.keyboard.press('Escape');
  await expect(mobile.locator('#details-panel')).not.toBeVisible();
  await expect(mobile.locator('#toggle-details')).toBeFocused();
  assert.equal(
    await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
    false,
    'Mobile must not overflow horizontally',
  );
  await mobile.screenshot({ path: await freshShot(SHOTS.mobileOff), animations: 'disabled' });
  await mobileContext.close();
  step('At 390px docking stays off and the inspector mobile modality (open/Escape/focus) works.');

  // Back to desktop: the persisted layout restores.
  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect(page.locator(DOCK.workspace)).toBeVisible();
  signature = await layoutSignature(page);
  assert.ok(signature.groups.length >= 2, 'Desktop return must restore the docked groups');
  step('Returning to desktop restores the persisted dock layout.');

  // ------------------------------------------------ Phase 12: English capture.
  const enContext = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 1600, height: 1000 },
    reducedMotion: 'reduce',
  });
  await seedSelection(enContext, { cwd, sessionId: 'docking-demo', projectOverview: false });
  const english = await enContext.newPage();
  english.setDefaultTimeout(15000);
  english.on('pageerror', (error) => errors.push(error.message));
  await english.goto(url);
  await expect(english.locator('#connection-label'))
    .toContainText('connected', { timeout: 20000 })
    .catch(async () => {
      await expect(english.locator('#connection-label')).not.toBeEmpty();
    });
  await english.locator('#session-list .session-select').first().click();
  // Fresh profile, no saved choice: the workspace defaults ON on desktop.
  await expect(english.locator(DOCK.workspace)).toBeVisible();
  await english.locator(DOCK.openButton).click();
  await expect(english.locator(DOCK.dialog)).toBeVisible();
  assert.equal(
    await english.locator(DOCK.toggle).isChecked(),
    true,
    'Fresh profile must default the workspace toggle ON',
  );
  await english.locator(DOCK.closeSettings).click();
  await expect(english.locator(DOCK.dialog)).not.toBeVisible();
  await measureNodes(english, 'english');
  await english.screenshot({ path: await freshShot(SHOTS.english), animations: 'disabled' });
  await enContext.close();
  step('English locale capture renders with no overflow.');

  // ------------------------------------------------ Phase 13: narrow 260-320px
  // conversation pane at the 1081px desktop gate, three panels live at once
  // (inspector stacked below the roadmap). Independent end-phase: earlier
  // evidence is retained, nothing above is re-asserted loosely.
  await page.setViewportSize({ width: 1081, height: 900 });
  await expect(page.locator(DOCK.workspace)).toBeVisible();
  assert.equal(
    await page.evaluate(() => window.matchMedia('(min-width: 1081px)').matches),
    true,
    '1081px is the narrowest viewport keeping the desktop docking gate',
  );
  // Fresh detach for this phase: reloads reattach follow mode, so detach
  // again through the real gesture before this phase's structural moves.
  await manuallyDetachScroller(page);
  const toolsId = (await layoutSignature(page)).groups.find((group) => group.tabs.includes('roadmap'))?.id;
  assert.ok(toolsId, 'A live group holding the roadmap must exist');
  await page.locator('button[data-dock-tab="session"]').scrollIntoViewIfNeeded();
  {
    const sessBox = await page.locator('button[data-dock-tab="session"]').boundingBox();
    const toolsBox = await page.locator(`[data-dock-group="${toolsId}"]`).boundingBox();
    await manualDrag(
      { x: sessBox.x, y: sessBox.y, width: sessBox.width, height: sessBox.height },
      { x: toolsBox.x + toolsBox.width / 2, y: toolsBox.y + toolsBox.height - 6, width: 4, height: 4 },
      true,
    );
    await page.waitForTimeout(800);
  }
  const stackedBoxes = await page.evaluate(() => {
    const rect = (selector) => {
      const el = document.querySelector(selector);
      const box = el?.getBoundingClientRect();
      return el && box.width > 0 && box.height > 0
        ? { top: Math.round(box.top), height: Math.round(box.height) }
        : null;
    };
    return { roadmap: rect('#roadmap-panel'), session: rect('#dock-view-session') };
  });
  assert.ok(stackedBoxes.roadmap, 'Roadmap panel must stay visible in the stacked tools column');
  assert.ok(stackedBoxes.session, 'Session tool frame must stay visible in the stacked tools column');
  assert.ok(
    stackedBoxes.session.top >= stackedBoxes.roadmap.top + stackedBoxes.roadmap.height - 4,
    `Session must sit below the roadmap (roadmap=${JSON.stringify(stackedBoxes.roadmap)}, session=${JSON.stringify(stackedBoxes.session)})`,
  );
  // Shrink the conversation pane with real separator key presses until it
  // lands in the 260-320px band (CSS minimum pins the lower bound).
  const narrowRow = page.locator('.dock-splitter[data-dock-split][aria-orientation="vertical"]').first();
  await narrowRow.focus();
  const convWidthOf = () =>
    page.evaluate(() => {
      const group = [...document.querySelectorAll('.dock-group[data-dock-group]')].find((entry) =>
        [...entry.querySelectorAll('button[data-dock-tab]')].some(
          (tab) => tab.dataset.dockTab === 'conversation',
        ),
      );
      return Math.round(group?.getBoundingClientRect().width ?? -1);
    });
  let narrowWidth = await convWidthOf();
  for (let n = 0; n < 40 && narrowWidth > 320; n++) {
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => convWidthOf(), { timeout: 10000 }).not.toEqual(narrowWidth);
    narrowWidth = await convWidthOf();
  }
  assert.ok(
    narrowWidth >= 260 && narrowWidth <= 320,
    `Conversation pane must land in the 260-320px band, got ${narrowWidth}px`,
  );
  await expect(page.locator('#composer')).toBeVisible();
  await expect(page.locator('#composer')).toBeEnabled();
  await expect(page.locator('#roadmap-panel')).toBeVisible();
  await expect(page.locator('button[data-dock-tab="session"]')).toBeVisible();
  await page.locator('button[data-dock-tab="agents"]').click();
  await expect(page.locator('#dock-view-agents')).toBeVisible();
  await page.locator('button[data-dock-tab="session"]').click();
  await expectRefsStable(page, refState, 'narrow-260');
  await expectScrollDetached(page, 'narrow-260');
  step(
    `Narrow 260-320px conversation pane (${narrowWidth}px) keeps composer, roadmap and session controls reachable.`,
  );
  await measureNodes(page, 'narrow-260-1081');
  await page.screenshot({ path: await freshShot(SHOTS.narrow260), animations: 'disabled' });
  step('Three simultaneous panels (conversation, roadmap, session below roadmap) captured at 1081px.');

  // ------------------------------------------------ Phase 14: authenticated read-only remote.
  // Minimal remote context: PIN login through a read-only fixture gateway,
  // then dock opt-in plus a menu-only move using the normal UI. Layout moves
  // are client-only (localStorage); permissions stay unchanged: the composer
  // is disabled and roadmap mutation controls are disabled, with no POST
  // attempted anywhere. Self-contained fixture gateway; never the liveLab.
  const roSalt = 'e'.repeat(32);
  const roCode = '87654321';
  const roGateway = createLanGateway({
    host: '127.0.0.1',
    upstreamPort: app.server.address().port,
    config: { salt: roSalt, codeHash: hashAccessCode(roCode, roSalt), readOnly: true },
  });
  await new Promise((done) => roGateway.listen(0, '127.0.0.1', done));
  try {
    const roUrl = `http://127.0.0.1:${roGateway.address().port}`;
    const roContext = await browser.newContext({
      locale: 'fr-FR',
      viewport: { width: 1600, height: 1000 },
      reducedMotion: 'reduce',
    });
    await seedSelection(
      roContext,
      { cwd, sessionId: 'docking-demo', projectOverview: false },
      { docked: false },
    );
    const roPage = await roContext.newPage();
    roPage.setDefaultTimeout(15000);
    roPage.on('pageerror', (error) => errors.push(error.message));
    await roPage.goto(roUrl);
    await roPage.locator('#code, input[name="code"]').first().fill(roCode);
    const roSubmit = roPage.locator('button[type="submit"]');
    if ((await roSubmit.count()) > 0) await roSubmit.first().click();
    else await roPage.getByRole('button', { name: /ouvrir/i }).click();
    await expect(roPage.locator('#connection-label')).toContainText('connecté');
    await roPage.locator('#session-list .session-select').filter({ hasText: 'Calibrer la sortie' }).click();
    await expect(roPage.locator('#messages')).toContainText('Synthèse disponible');
    await expect(roPage.locator('#composer')).toBeDisabled();
    step('Read-only remote PIN login works; the composer is disabled without attempting any send.');
    await roPage.locator('#open-roadmap').click();
    await expect(roPage.locator('#roadmap-panel')).toContainText('Fiabiliser le déplacement');
    const roChecks = roPage.locator('#roadmap-panel input[type="checkbox"]');
    if ((await roChecks.count()) === 0) {
      await roPage
        .locator('#roadmap-panel')
        .getByRole('button', { name: 'Fiabiliser le déplacement des panneaux', exact: true })
        .click();
    }
    assert.ok((await roChecks.count()) >= 1, 'Seeded plan steps must render checkboxes');
    for (const box of await roChecks.all()) await expect(box).toBeDisabled();
    step('Read-only roadmap renders fixture content with all mutation checkboxes disabled.');
    await roPage.locator('#roadmap-panel .rm-close').click();
    await expect
      .poll(() => roPage.evaluate(() => document.body.classList.contains('roadmap-open')), { timeout: 10000 })
      .toBe(false);
    const roRefs = await snapshotRefs(roPage);
    await roPage.locator('#open-docking').click();
    await expect(roPage.locator(DOCK.dialog)).toBeVisible();
    await roPage.locator(DOCK.toggle).check();
    await expect(roPage.locator(DOCK.workspace)).toBeVisible();
    await roPage.locator(DOCK.reset).click();
    await roPage.locator(DOCK.closeSettings).click();
    await expect(roPage.locator(DOCK.dialog)).not.toBeVisible();
    await expectDefaultLayout(roPage, 'readonly-default');
    const roEnvelope = await storageEnvelope(roPage);
    assert.equal(roEnvelope?.parsed?.enabled, true, 'Read-only opt-in persists client-side');
    const roSigBefore = await layoutSignature(roPage);
    const roTarget = roSigBefore.groups.find((group) => !group.tabs.includes('session'));
    assert.ok(roTarget, 'A live group must exist as the read-only drag-move target');
    await roPage.locator('button[data-dock-tab="session"]').click({ button: 'right' });
    await expect(roPage.locator(DOCK.menu)).toBeVisible();
    assert.equal(
      await roPage.locator(`${DOCK.menu} [aria-controls="docking-move-menu"]`).count(),
      0,
      'No Move submenu entry may exist (read-only)',
    );
    assert.equal(await roPage.locator(DOCK.moveMenu).count(), 0, '#docking-move-menu must be absent (read-only)');
    await roPage.keyboard.press('Escape');
    await roPage.locator('button[data-dock-tab="session"]').scrollIntoViewIfNeeded();
    {
      const roFrom = await roPage.locator('button[data-dock-tab="session"]').boundingBox();
      const roBar = await roPage.locator(`[data-dock-group="${roTarget.id}"] .dock-tabs`).boundingBox();
      await roPage.mouse.move(roFrom.x + roFrom.width / 2, roFrom.y + roFrom.height / 2);
      await roPage.mouse.down();
      for (let i = 1; i <= 10; i++) {
        await roPage.mouse.move(
          roFrom.x + ((roBar.x + roBar.width / 2 - roFrom.x) * i) / 10,
          roFrom.y + ((roBar.y + roBar.height / 2 - roFrom.y) * i) / 10,
          { steps: 2 },
        );
      }
      await roPage.mouse.move(roBar.x + roBar.width / 2, roBar.y + roBar.height / 2);
      await roPage.mouse.up();
      await roPage.waitForTimeout(800);
    }
    const roSigAfter = await layoutSignature(roPage);
    assert.ok(
      findGroup(roSigAfter, roTarget.id).tabs.includes('session'),
      `Read-only drag move relocates session into ${roTarget.id}`,
    );
    await expectRefsStable(roPage, roRefs, 'readonly-move');
    await expect(roPage.locator('#composer')).toBeDisabled();
    step('Read-only dock opt-in and drag move keep the identical DOM nodes; composer stays disabled.');
    await roContext.close();
  } finally {
    roGateway.closeAllConnections();
    await new Promise((done) => roGateway.close(done));
  }

  // ------------------------------------------------ Finish: stream completes exactly once, nothing restarted.
  assert.equal(starts.length, 1, 'Only the single UI-sent run may exist');
  assert.equal(cancellations, 0, 'Structural moves must never cancel the run');
  await activeControls[0].finish('completed');
  await expect(page.locator('#stop-button')).toBeHidden({ timeout: 15000 });
  assert.deepEqual(errors, [], `No page errors expected, got ${JSON.stringify(errors)}`);
  step('Mocked stream completes after every docking check: one start, zero cancels, zero page errors.');
  await writeProof({});
} catch (error) {
  try {
    await page?.screenshot({ path: join(OUT_ROOT, 'docking-failure.png') }).catch(() => {});
  } catch {}
  if (!proofWritten) {
    try {
      await writeProof({ status: 'failed', failure: String(error?.message || error).slice(0, 2000) });
    } catch {}
  }
  throw error;
} finally {
  await browser.close();
  await app.close();
  assert.equal(dirname(temp), resolve(tmpdir()));
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
