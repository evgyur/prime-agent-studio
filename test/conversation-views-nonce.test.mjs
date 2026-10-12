import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRotateNonceOnBind } from '../public/conversation-views.js';

// Pin identity: an explicit new->session/run rebind rotates the nonce so the
// original unsent conv:<nonce> slot stays intact. Automatic send/SSE promotion
// mutates the view in place and bypasses bindFocused.

test('explicit new->session rotates (unrelated sidebar selection never hijacks a pin)', () => {
  assert.equal(
    shouldRotateNonceOnBind({ kind: 'new', sessionId: null, viewRunId: null }, { kind: 'session', sessionId: 'S1' }),
    true,
  );
});

test('explicit new->run rotates', () => {
  assert.equal(
    shouldRotateNonceOnBind({ kind: 'new', sessionId: null, viewRunId: null }, { kind: 'run', viewRunId: 'R1' }),
    true,
  );
});

test('rebinding the already-adopted run keeps the nonce (pin adopts the session)', () => {
  assert.equal(
    shouldRotateNonceOnBind({ kind: 'new', sessionId: null, viewRunId: 'R1' }, { kind: 'run', viewRunId: 'R1' }),
    false,
  );
});

test('adopted run rebound to a different session rotates', () => {
  assert.equal(
    shouldRotateNonceOnBind({ kind: 'new', sessionId: null, viewRunId: 'R1' }, { kind: 'session', sessionId: 'S9', viewRunId: null }),
    true,
  );
});

test('session views never rotate (session drafts unaffected)', () => {
  assert.equal(
    shouldRotateNonceOnBind({ kind: 'session', sessionId: 'S1', viewRunId: null }, { kind: 'session', sessionId: 'S2' }),
    false,
  );
  assert.equal(
    shouldRotateNonceOnBind({ kind: 'session', sessionId: 'S1', viewRunId: null }, { kind: 'run', viewRunId: 'R2' }),
    false,
  );
});

test('new->new never rotates here (existing keepNonce branch owns it)', () => {
  assert.equal(
    shouldRotateNonceOnBind({ kind: 'new', sessionId: null, viewRunId: null }, { kind: 'new' }),
    false,
  );
});

test('null-safe on both sides', () => {
  assert.equal(shouldRotateNonceOnBind(null, { kind: 'session', sessionId: 'S1' }), false);
  assert.equal(shouldRotateNonceOnBind({ kind: 'new', sessionId: null }, null), false);
  assert.equal(shouldRotateNonceOnBind({ kind: 'new', sessionId: null }, {}), false);
});
