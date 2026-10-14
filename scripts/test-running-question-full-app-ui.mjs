import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { createApp } from '../server.mjs';

const root = await mkdtemp(join(tmpdir(), 'prime-running-question-ui-'));
const cwd = join(root, 'project'),
  sessionDir = join(root, 'sessions'),
  agentHome = join(root, 'agent');
await Promise.all([mkdir(cwd), mkdir(sessionDir), mkdir(agentHome)]);
const sessionId = 'question-fixture-session';
await writeFile(
  join(sessionDir, 'fixture.jsonl'),
  [
    { type: 'session', id: sessionId, cwd, timestamp: '2026-10-14T00:00:00.000Z' },
    {
      type: 'message',
      id: 'user-1',
      parentId: null,
      message: { role: 'user', content: 'Fixture question thread' },
    },
  ]
    .map((v) => JSON.stringify(v))
    .join('\n') + '\n',
);
const requests = [
  { id: 'q-1', method: 'select', title: 'Fixture question one', options: ['A', 'B'], status: 'pending' },
  { id: 'q-2', method: 'select', title: 'Fixture question two', options: ['A', 'B'], status: 'pending' },
];
let finish,
  control,
  answers = 0;
const runtime = {
  getStatus: async () => ({ available: true, version: 'fixture' }),
  getModels: async () => ({
    models: [{ id: 'test/model', provider: 'test', thinkingLevels: ['medium'] }],
    default: { model: 'test/model', thinking: 'medium' },
  }),
  async start(input) {
    const done = new Promise((resolve) => {
      finish = resolve;
    });
    input.onEvent({ kind: 'session', sessionId, cwd });
    for (const request of requests) input.onEvent({ kind: 'interaction', request: { ...request } });
    control = {
      done,
      cancel: async () => finish({ status: 'stopped', code: 0 }),
      respond: async (id, response) => {
        const request = requests.find((r) => r.id === id);
        assert.equal(request.status, 'pending');
        request.status = 'answered';
        request.answer = response.value;
        answers++;
        input.onEvent({ kind: 'interaction', request: { ...request } });
        return { id, status: 'answered' };
      },
    };
    return control;
  },
  close: async () => control?.cancel(),
};
const app = createApp({ sessionDir, agentHome, dataDir: join(root, 'studio'), initialCwd: cwd, runtime });
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
const url = 'http://127.0.0.1:' + app.server.address().port;
const response = await fetch(url + '/api/runs', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ cwd, sessionId, message: 'Fixture fake-runtime turn', allowQuestions: true }),
});
assert.equal(response.status, 201);
const run = await response.json();
const browser = await launchStudioBrowser();
const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.addInitScript(
  ({ cwd, sessionId, runId }) => {
    localStorage.setItem('prime-studio.language', 'en');
    localStorage.setItem(
      'prime-studio.selection',
      JSON.stringify({ cwd, sessionId, runId, projectOverview: false }),
    );
  },
  { cwd, sessionId, runId: run.id },
);
try {
  await page.goto(url);
  await page.waitForFunction(() =>
    document.getElementById('connection-label').textContent.includes('connected'),
  );
  const marker = page.locator('#active-runs .active-run-question');
  if (!(await page.locator('#details-panel').isVisible())) await page.locator('#toggle-details').click();
  await marker.waitFor({ state: 'visible' });
  assert.equal(await marker.innerText(), '❓');
  assert.equal(await marker.getAttribute('data-pending-questions'), '2');
  assert.equal(await marker.getAttribute('title'), 'Waiting for your answer (2 questions)');
  const narrow = await marker.evaluate((marker) => {
    const row = marker.parentElement;
    row.style.width = '120px';
    row.querySelector('.active-run-label').textContent = 'Fixture thread with a long descriptive title';
    const badge = marker.getBoundingClientRect(),
      bounds = row.getBoundingClientRect();
    row.style.width = '';
    return { width: badge.width, right: badge.right, rowRight: bounds.right };
  });
  assert.ok(
    narrow.width > 0 && narrow.right <= narrow.rowRight,
    'long titles never push the marker outside the row',
  );
  await page.evaluate(async () => {
    const { setLanguage } = await import('/public/i18n.js');
    setLanguage('fr');
  });
  assert.equal(await marker.getAttribute('aria-label'), 'En attente de votre réponse (2 questions)');
  await page.evaluate(async () => {
    const { setLanguage } = await import('/public/i18n.js');
    setLanguage('en');
  });
  for (const [id, remaining] of [
    ['q-1', '1'],
    ['q-2', null],
  ]) {
    const form = page.locator(`form[aria-labelledby="question-${id}"]`);
    await form.locator('input[value="A"]').check();
    await form.locator('button[type="submit"]').click();
    await page.waitForFunction(
      (expected) => {
        const marker = document.querySelector('#active-runs .active-run-question');
        return expected === null ? !marker : marker?.dataset.pendingQuestions === expected;
      },
      remaining,
      { timeout: 2000 },
    );
    if (remaining === '1') assert.equal(await marker.getAttribute('title'), 'Waiting for your answer');
  }
  assert.equal(answers, 2);
  assert.equal(await marker.count(), 0);
  assert.equal(
    await page.locator('#active-runs .active-run').count(),
    1,
    'thread stays in RUNNING after answering',
  );
  await page.reload();
  await page.waitForFunction(() =>
    document.getElementById('connection-label').textContent.includes('connected'),
  );
  assert.equal(await marker.count(), 0, 'replaying answered interactions never resurrects the marker');
  assert.deepEqual(errors, []);
  console.log(
    'Full Studio RUNNING marker: two real UI answers via HTTP+SSE remove the badge immediately, thread remains running.',
  );
} finally {
  await browser.close();
  await app.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
