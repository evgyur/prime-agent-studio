import test from 'node:test';
import assert from 'node:assert/strict';
import { agentEnvironment } from '../lib/agent.mjs';

test('foreign Studio preloads cannot shadow current Python bridge', () => {
  const env = agentEnvironment({ env: { NODE_OPTIONS: '--require="C:/foreign/studio/runtime/windows-hidden.cjs" --require="C:/tools/user.cjs" --max-old-space-size=2048' } });
  assert.equal(env.NODE_OPTIONS.includes('foreign'), false);
  assert.ok(env.NODE_OPTIONS.includes('--require="C:/tools/user.cjs"'));
  assert.ok(env.NODE_OPTIONS.includes('--max-old-space-size=2048'));
});
