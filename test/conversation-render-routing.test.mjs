import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';

// F1 owner-routing: production slices only. A background run's burst must keep
// exactly one coalesced global frame + one owner repaint, while unrelated
// focused/primary transcripts do zero render work. Chrome
// (renderDetails/updateComposer) still runs every frame.
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const views = await readFile(new URL('../public/conversation-views.js', import.meta.url), 'utf8');
const CHAR10 = String.fromCharCode(10);
function part(source, start, end) {
  const a = source.indexOf(start),
    b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `production function ${start}`);
  return source.slice(a, b);
}
const prog = [
  part(app, 'const isRunning', 'const activeRun'),
  part(app, 'function runningForSession(', 'function runForView('),
  part(app, 'function runForView(', 'function modelForView('),
  part(app, 'function scheduleMessages(', 'function renderMessages('),
  part(app, 'function renderMessages(', 'function renderHostPrimary('),
  part(app, 'function renderHostPrimary(', 'function closeSidebar('),
  part(app, 'function applyRunEvent(', 'function subscribe('),
  part(views, 'function scheduleBg(', 'function persist('),
  part(views, 'function notifyRunEvent(', 'function markDirty('),
].join(CHAR10);

function elements() {
  const store = {
    welcome: { hidden: false },
    'conversation-loading': { hidden: false },
    messages: { hidden: false },
    'conversation-scroll': { scrollTop: 0, scrollHeight: 0, clientHeight: 0 },
    'scroll-bottom': { hidden: false },
  };
  return store;
}
function build() {
  const frames = [];
  const counts = { primary: 0, focused: 0, ownerBg: 0, chrome: 0, questions: 0 };
  let lastFocusedMessages = null;
  const els = elements();
  const runBg = { id: 'R-bg', sessionId: 'S-bg', lastSeq: 0, initialized: true, base: [], messages: [] };
  const runF = { id: 'R-f', sessionId: 'S-f', lastSeq: 0, initialized: true, base: [], messages: [] };
  const primaryView = {
    id: 'conversation',
    sessionId: 'S-p',
    viewRunId: null,
    history: [{ id: 'p1', text: 'primary history' }],
    loading: false,
  };
  const bgView = { id: 'conv:bg', sessionId: 'S-bg', viewRunId: 'R-bg', history: [], loading: false };
  const focusedView = {
    id: 'conv:f',
    sessionId: 'S-f',
    viewRunId: 'R-f',
    history: [{ id: 'f1', text: 'focused history v1' }],
    loading: false,
  };
  const viewById = new Map([
    ['conversation', primaryView],
    ['conv:bg', bgView],
    ['conv:f', focusedView],
  ]);
  const context = createContext({
    PRIMARY_VIEW_ID: 'conversation',
    state: {
      runs: new Map([
        ['R-bg', runBg],
        ['R-f', runF],
      ]),
      projectOverview: false,
      loading: false,
    },
    renderScheduled: false,
    pendingRenderRuns: new Set(),
    bottomScrollFrame: 0,
    followConversation: false,
    dockedActive: true,
    visibleIds: ['conversation', 'conv:bg', 'conv:f'],
    focusedId: 'conv:f',
    views: new Map([['conv:bg', bgView]]),
    requestAnimationFrame(fn) {
      frames.push(fn);
    },
    cancelAnimationFrame() {},
    noteActivity() {},
    tr: (s) => s,
    translateKnown: (v) => v,
    ensureAssistant: (r) => {
      if (!r.currentMessage) r.currentMessage = { text: '' };
      return r.currentMessage;
    },
    upsertSession() {},
    renderNavigation() {},
    saveDraft() {},
    saveSelection() {},
    findTool: () => null,
    applyRuntimeStatus() {},
    toast() {},
    finishRun() {},
    refreshTitles() {},
    renderDetails() {
      counts.chrome++;
    },
    updateComposer() {
      counts.chrome++;
    },
    scrollBottom() {},
    atConversationBottom: () => true,
    $: (id) => els[id],
    questionsUI: {
      update() {
        counts.questions++;
      },
    },
    messageNodes: new Map(),
    historyRenderOptions: () => ({}),
    conversationRenderer: {
      render(root, messages) {
        if (root === els.messages) counts.primary++;
        else if (root && root.tag === 'focused') {
          counts.focused++;
          lastFocusedMessages = messages;
        }
      },
    },
    renderBg() {
      counts.ownerBg++;
    },
    dockingUI: { active: true, visiblePanels: () => ['conversation', 'conv:bg', 'conv:f'] },
    convViews: {
      composerLive: () => true,
      byId: (id) => viewById.get(id) || null,
      focused: () => focusedView,
      isFocused: (id) => id === 'conv:f',
      byRun: (id) => (id === 'R-bg' ? bgView : id === 'R-f' ? focusedView : null),
      bySession: () => null,
      renderViewNow(id) {
        if (id === 'conv:f') {
          counts.focused++;
          lastFocusedMessages = context.runForView(focusedView)
            ? [
                ...(context.runForView(focusedView).base || []),
                ...(context.runForView(focusedView).messages || []),
              ]
            : focusedView.history;
        }
      },
      notifyRunEvent: (...args) => context.notifyRunEvent(...args),
    },
  });
  runInContext(prog, context);
  const focusedRoot = { tag: 'focused' };
  return {
    context,
    frames,
    counts,
    runBg,
    runF,
    focusedView,
    primaryView,
    get lastFocusedMessages() {
      return lastFocusedMessages;
    },
  };
}
function drain(frames) {
  while (frames.length) frames.shift()();
}

test('background burst: one frame, owner repainted, focused/primary transcripts untouched, chrome kept', () => {
  const { context, frames, counts, runBg } = build();
  for (let seq = 1; seq <= 100; seq++) context.applyRunEvent(runBg, { seq, kind: 'text', delta: 'x' });
  assert.ok(frames.length <= 2, 'burst stays coalesced to owner frame + global frame');
  drain(frames);
  assert.equal(counts.ownerBg, 1, 'owner background pane repaints once');
  assert.equal(counts.focused, 0, 'unrelated focused transcript does zero render work');
  assert.equal(counts.primary, 0, 'unrelated primary transcript does zero render work');
  assert.equal(counts.chrome, 2, 'renderDetails + updateComposer still run');
  assert.equal(runBg.currentMessage.text, 'x'.repeat(100), 'no deltas lost');
});

test('focused burst repaints focused, skips unbound primary', () => {
  const { context, frames, counts, runF } = build();
  for (let seq = 1; seq <= 20; seq++) context.applyRunEvent(runF, { seq, kind: 'text', delta: 'y' });
  drain(frames);
  assert.equal(counts.focused, 1, 'owner focused pane repaints once');
  assert.equal(counts.primary, 0, 'unbound primary transcript skipped');
  assert.equal(runF.currentMessage.text, 'y'.repeat(20));
});

test('concurrent runs widen the frame: both owners paint, third pane skipped', () => {
  const { context, frames, counts, runBg, runF } = build();
  context.scheduleMessages(runBg);
  context.scheduleMessages(runF);
  assert.equal(frames.length, 1, 'concurrent deltas share one frame');
  drain(frames);
  assert.equal(counts.focused, 1, 'focused owner painted');
  assert.equal(counts.primary, 0, 'unrelated primary skipped');
});

test('unqualified frame (navigation/load path) still repaints all targets', () => {
  const { context, frames, counts } = build();
  context.scheduleMessages();
  drain(frames);
  assert.equal(counts.focused, 1, 'focused repaints on unqualified frame');
  assert.equal(counts.primary, 1, 'primary repaints on unqualified frame');
});

test('same-length replacement is not masked: next unqualified frame carries new content', () => {
  const { context, frames, counts, runBg, focusedView } = build();
  for (let seq = 1; seq <= 5; seq++) context.applyRunEvent(runBg, { seq, kind: 'text', delta: 'x' });
  drain(frames);
  assert.equal(counts.focused, 0);
  // Same-length edit on the focused history (identity routing never infers
  // staleness from lengths; the edit must surface on the next real render).
  focusedView.history = [{ id: 'f1', text: 'focused history v2' }];
  context.renderMessages(false, null);
  assert.equal(counts.focused, 1, 'unqualified frame repaints focused');
});
