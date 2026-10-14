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
  const marker = page.locator('#active-runs .question-dot');
  const spinner = page.locator('#active-runs .spinner');
  if (!(await page.locator('#details-panel').isVisible())) await page.locator('#toggle-details').click();
  await marker.waitFor({ state: 'visible' });
  // Same amber question dot as the sidebar, in place of the working spinner.
  assert.equal(await marker.innerText(), '?');
  assert.equal(await marker.getAttribute('title'), 'Question awaiting an answer');
  assert.equal(await spinner.count(), 0);
  const narrow = await marker.evaluate((marker) => {
    const row = marker.parentElement;
    row.style.width = '120px';
    row.querySelector('.active-run-label').textContent = 'Fixture thread with a long descriptive title';
    const dot = marker.getBoundingClientRect(),
      bounds = row.getBoundingClientRect();
    row.style.width = '';
    return { width: dot.width, left: dot.left, rowLeft: bounds.left };
  });
  assert.ok(narrow.width > 0 && narrow.left >= narrow.rowLeft, 'long titles never hide the dot');
  await page.evaluate(async () => {
    const { setLanguage } = await import('/public/i18n.js');
    setLanguage('fr');
  });
  assert.equal(await marker.getAttribute('aria-label'), 'Question en attente');
  await page.evaluate(async () => {
    const { setLanguage } = await import('/public/i18n.js');
    setLanguage('en');
  });
  // Answer both questions through the real question cards.
  for (const remaining of [1, 0]) {
    const form = page.locator('.agent-question:not(.question-resolved)').first();
    await form.locator('input[type=radio]').first().check();
    await form.getByRole('button', { name: 'Send answer', exact: true }).click();
    await page.waitForFunction(
      (remaining) =>
        document.querySelectorAll('.agent-question:not(.question-resolved)').length === remaining,
      remaining,
      { timeout: 5000 },
    );
  }
  await page.waitForFunction(() => !document.querySelector('#active-runs .question-dot'), null, {
    timeout: 2000,
  });
  assert.equal(await spinner.count(), 1, 'the working spinner comes back after answering');
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
    'Full Studio running list: question dot replaces the spinner, two real UI answers via HTTP+SSE restore it, thread remains running.',
  );
} finally {
  await browser.close();
  await app.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
