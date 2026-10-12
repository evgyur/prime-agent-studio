import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WINDOW_DEFAULTS,
  buildBlocks,
  computeWindow,
  tailWindow,
  shouldAutoLoad,
} from '../public/conversation-window.js';

const isEmpty = (m) =>
  m.role === 'assistant' &&
  m.stopReason === 'stop' &&
  !m.text?.trim() &&
  !m.thinking?.trim() &&
  !m.tools?.length &&
  !m.attachments?.length &&
  !m.error;
const techTypes = new Set(['agent_message', 'harness_digest']);
const isTechnical = (m) =>
  m.role === 'system' && !m.error && !m.isError && (m.agentMessage || techTypes.has(m.customType));
const idOf = (m, i) => m.id || `history-${i}`;

test('buildBlocks preserves tool/technical grouping and skips empty assistants', () => {
  const messages = [
    { id: 'u1', role: 'user', text: 'hi' },
    { id: 'a1', role: 'assistant', text: 'hello' },
    { id: 't1', role: 'system', customType: 'agent_message', text: 'event' },
    { id: 'a2', role: 'assistant', thinking: 'reason', tools: [{ id: 'c1', name: 'ipython' }] },
    { id: 'u2', role: 'user', text: 'next' },
    { id: 'empty', role: 'assistant', stopReason: 'stop', text: ' ' },
    { id: 'a3', role: 'assistant', text: 'done' },
  ];
  const { filtered, blocks } = buildBlocks(messages, { isEmpty, isTechnical, idOf });
  assert.equal(filtered.length, 6, 'empty skipped');
  // u1 single, [a1,t1,a2] one turn, u2 single, a3 turn
  assert.equal(blocks.length, 4);
  assert.equal(blocks[0].kind, 'single');
  assert.equal(blocks[0].key, 'u1');
  assert.equal(blocks[1].kind, 'turn');
  assert.equal(blocks[1].key, 'a1');
  assert.deepEqual(blocks[1].ids, ['a1', 't1', 'a2']);
  assert.equal(blocks[2].key, 'u2');
  assert.equal(blocks[3].key, 'a3');
});

test('buildBlocks keeps stable keys across prepends (anchor by message id)', () => {
  const tail = Array.from({ length: 80 }, (_, i) => ({
    id: `m${100 + i}`,
    role: i % 2 ? 'assistant' : 'user',
    text: `t${i}`,
  }));
  const full = [
    ...Array.from({ length: 80 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 ? 'assistant' : 'user',
      text: `old${i}`,
    })),
    ...tail,
  ];
  const a = buildBlocks(tail, { isEmpty, isTechnical, idOf });
  const b = buildBlocks(full, { isEmpty, isTechnical, idOf });
  // Tail keys must all still exist in full (no stored truncation, stable IDs).
  const keysB = new Set(b.blocks.map((x) => x.key));
  for (const block of a.blocks) assert.ok(keysB.has(block.key), `tail block ${block.key} retained`);
  // Full is strictly larger (prepended history accessible).
  assert.ok(b.blocks.length > a.blocks.length);
});

test('computeWindow is bounded and spacers sum to total', () => {
  const blocks = Array.from({ length: 1000 }, (_, i) => ({
    key: `b${i}`,
    kind: 'single',
    start: i,
    end: i + 1,
    ids: [`b${i}`],
  }));
  const heights = new Map();
  const win = computeWindow(blocks, {
    scrollTop: 50000,
    viewportHeight: 800,
    heights,
    avgHeight: 0,
    estimateHeight: WINDOW_DEFAULTS.estimateHeight,
    overscanPx: WINDOW_DEFAULTS.overscanPx,
    maxMounted: WINDOW_DEFAULTS.maxMounted,
    pinnedKeys: new Set(),
  });
  assert.ok(win.end - win.start <= WINDOW_DEFAULTS.maxMounted, `bounded ${win.end - win.start}`);
  assert.ok(win.end - win.start >= 5, 'non-empty window');
  assert.equal(
    Math.round(win.topHeight + win.bottomHeight + (win.end - win.start) * WINDOW_DEFAULTS.estimateHeight),
    Math.round(win.total),
  );
});

test('computeWindow respects maxMounted cap under huge overscan', () => {
  const blocks = Array.from({ length: 200 }, (_, i) => ({
    key: `k${i}`,
    kind: 'single',
    start: i,
    end: i + 1,
    ids: [`k${i}`],
  }));
  const heights = new Map(blocks.map((b) => [b.key, 10]));
  const win = computeWindow(blocks, {
    scrollTop: 1000,
    viewportHeight: 800,
    heights,
    avgHeight: 10,
    estimateHeight: 140,
    overscanPx: 10000, // huge overscan would mount everything without the cap
    maxMounted: 40,
    pinnedKeys: new Set(),
  });
  assert.ok(win.end - win.start <= 40, 'hard cap holds');
});

test('computeWindow keeps near-viewport pinned focus blocks', () => {
  const blocks = Array.from({ length: 200 }, (_, i) => ({
    key: `k${i}`,
    kind: 'single',
    start: i,
    end: i + 1,
    ids: [`k${i}`],
  }));
  const heights = new Map(blocks.map((b) => [b.key, 50]));
  // Viewport 2500..3300 => blocks ~50..65 visible; overscan keeps ~46..69.
  const win = computeWindow(blocks, {
    scrollTop: 2500,
    viewportHeight: 800,
    heights,
    avgHeight: 50,
    estimateHeight: 140,
    overscanPx: 200,
    maxMounted: 40,
    pinnedKeys: new Set(['k48']),
  });
  assert.ok(win.end - win.start <= 40, 'bounded');
  assert.ok(win.start <= 48 && 48 < win.end, 'near-viewport pinned block kept');
});

test('tailWindow mounts the tail for bottom follow', () => {
  const blocks = Array.from({ length: 100 }, (_, i) => ({
    key: `x${i}`,
    kind: 'single',
    start: i,
    end: i + 1,
    ids: [`x${i}`],
  }));
  const t = tailWindow(blocks, 20);
  assert.deepEqual(t, { start: 80, end: 100 });
});

test('shouldAutoLoad only on intentional upward scroll near top', () => {
  const base = { hasOlder: true, loadingOlder: false, inFlight: false, topThreshold: 600 };
  assert.equal(
    shouldAutoLoad({ ...base, scrollTop: 100, prevScrollTop: 300 }),
    true,
    'upward near top loads',
  );
  assert.equal(
    shouldAutoLoad({ ...base, scrollTop: 100, prevScrollTop: 50 }),
    false,
    'downward near top does not load',
  );
  assert.equal(
    shouldAutoLoad({ ...base, scrollTop: 700, prevScrollTop: 900 }),
    false,
    'far from top does not load',
  );
  assert.equal(
    shouldAutoLoad({ ...base, scrollTop: 0, prevScrollTop: null }),
    false,
    'initial display never eagerly loads',
  );
  assert.equal(
    shouldAutoLoad({ ...base, scrollTop: 0, prevScrollTop: 0 }),
    false,
    'no movement does not load',
  );
  assert.equal(shouldAutoLoad({ ...base, hasOlder: false, scrollTop: 10, prevScrollTop: 100 }), false);
  assert.equal(shouldAutoLoad({ ...base, loadingOlder: true, scrollTop: 10, prevScrollTop: 100 }), false);
  assert.equal(shouldAutoLoad({ ...base, inFlight: true, scrollTop: 10, prevScrollTop: 100 }), false);
});

test('WINDOW_DEFAULTS are bounded and documented', () => {
  assert.equal(typeof WINDOW_DEFAULTS.overscanPx, 'number');
  assert.equal(typeof WINDOW_DEFAULTS.maxMounted, 'number');
  assert.ok(WINDOW_DEFAULTS.maxMounted <= 100, 'bounded viewport/overscan DOM');
  assert.ok(WINDOW_DEFAULTS.overscanPx >= 500);
});
