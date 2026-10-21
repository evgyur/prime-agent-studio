import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentRuntime } from '../lib/agent.mjs';

test('configured budgets refuse a custom CLI without native safe-point support', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-budget-custom-cli-'));
  const runtime = createAgentRuntime({ agentHome: dir, sessionDir: join(dir, 'sessions'),
    cliPath: fileURLToPath(new URL('./fixtures/quota-cli.mjs', import.meta.url)),
  });
  t.after(async () => { await runtime.close(); await rm(dir, { recursive: true, force: true }); });
  await assert.rejects(runtime.start({ cwd: dir, message: 'Do not run without enforcement',
    allowQuestions: false, budget: { tokens: 100, estimatedCost: null },
  }), /budgets require the native/i);
});
