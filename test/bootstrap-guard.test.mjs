import test from 'node:test';
import assert from 'node:assert/strict';
import { createBootstrapGuard } from '../public/bootstrap-sequence.js';

test('new bootstrap runs invalidate older results', () => {
  const guard = createBootstrapGuard();
  const first = guard.start();
  assert.equal(guard.isCurrent(first), true);
  const second = guard.start();
  assert.equal(guard.isCurrent(first), false, 'stale run must not apply results');
  assert.equal(guard.isCurrent(second), true);
});

test('only one retry timer is scheduled at a time', async () => {
  const guard = createBootstrapGuard();
  const id = guard.start();
  let fires = 0;
  assert.equal(
    guard.schedule(id, 5, () => {
      fires += 1;
    }),
    true,
  );
  assert.equal(guard.pending, true);
  assert.equal(
    guard.schedule(id, 5, () => {
      fires += 1;
    }),
    false,
    'no duplicate pollers',
  );
  await new Promise((done) => setTimeout(done, 30));
  assert.equal(fires, 1);
  assert.equal(guard.pending, false);
  assert.equal(
    guard.schedule(id, 5, () => {
      fires += 1;
    }),
    true,
    'retry allowed after settle',
  );
  await new Promise((done) => setTimeout(done, 30));
  assert.equal(fires, 2);
});

test('stale runs never schedule and supersede clears a pending retry', async () => {
  const guard = createBootstrapGuard();
  const old = guard.start();
  let fired = false;
  assert.equal(
    guard.schedule(old, 5, () => {
      fired = true;
    }),
    true,
  );
  guard.start();
  assert.equal(guard.pending, false, 'supersede must drop the scheduled retry');
  assert.equal(
    guard.schedule(old, 5, () => {
      fired = true;
    }),
    false,
    'stale run must not retry',
  );
  await new Promise((done) => setTimeout(done, 30));
  assert.equal(fired, false, 'stale retry must never fire');
});
