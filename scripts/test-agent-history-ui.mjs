// Sub-agent history viewer: tool calls between two messages fold into one
// "Agent activity" block, and the viewer opens at the latest message.
// Isolated fixture transcripts and an inert runtime; never reads user sessions.
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createApp } from '../server.mjs';
import { launchStudioBrowser } from './fixtures/browser.mjs';

const out = process.argv[2] || 'test-results';
const temp = await mkdtemp(join(tmpdir(), 'prime-agent-history-'));
const cwd = join(temp, 'Atelier'),
  agentHome = join(temp, 'agent'),
  sessionDir = join(agentHome, 'sessions');
await mkdir(cwd);
await mkdir(sessionDir, { recursive: true });
await mkdir(out, { recursive: true });
const rootId = 'history-root',
  childId = 'history-child';
const rootFile = join(sessionDir, 'root.jsonl');
const childFile = join(agentHome, 'session-artifacts', rootId, 'worker', 'child.jsonl');
const at = (n) => new Date(Date.UTC(2026, 9, 22, 9, 0, n)).toISOString();
let seq = 0;
const entry = (message) => ({ type: 'message', id: `m${++seq}`, parentId: seq > 1 ? `m${seq - 1}` : null, timestamp: at(seq), message });
const assistant = (content) => entry({ role: 'assistant', model: 'claude-opus-4-5', provider: 'anthropic', content });
const call = (id, code) => assistant([{ type: 'toolCall', id, name: 'ipython', arguments: { code } }]);
const result = (id, text, isError = false) =>
  entry({ role: 'toolResult', toolCallId: id, toolName: 'ipython', content: [{ type: 'text', text }], isError });
const rows = [{ type: 'session', id: 'child-session', cwd, timestamp: at(0), version: 3 }];
rows.push(entry({ role: 'user', content: 'Corriger le gel du menu Préférences et clarifier l’installation.' }));
for (let i = 1; i <= 6; i++) rows.push(call(`a${i}`, `print(step_${i})`), result(`a${i}`, `résultat ${i}`));
rows.push(assistant([{ type: 'text', text: 'Bug reproduit : la fenêtre modale reste invisible.' }]));
rows.push(
  assistant([
    { type: 'thinking', thinking: 'Il faut passer par le hook de la page.' },
    { type: 'toolCall', id: 'b1', name: 'ipython', arguments: { code: 'edit()' } },
  ]),
  result('b1', 'ok'),
);
for (let i = 2; i <= 9; i++) rows.push(call(`b${i}`, `check(${i})`), result(`b${i}`, i === 5 ? 'Traceback' : 'ok', i === 5));
for (let r = 1; r <= 5; r++) {
  rows.push(assistant([{ type: 'text', text: `Point d’étape ${r} : vérifications en cours sur le lanceur et les Préférences.` }]));
  for (let i = 1; i <= 3; i++) rows.push(call(`c${r}${i}`, `run(${i})`), result(`c${r}${i}`, 'ok'));
}
rows.push(assistant([{ type: 'text', text: 'Correctif appliqué et vérifié.\n\nDernier message du sous-agent.' }]));
for (const [file, lines] of [
  [
    rootFile,
    [
      { type: 'session', id: rootId, cwd, timestamp: at(0), version: 3 },
      { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'Lancer le travail' } },
    ],
  ],
  [childFile, rows],
]) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, lines.map(JSON.stringify).join('\n') + '\n');
}
const app = createApp({
  initialCwd: cwd,
  agentHome,
  sessionDir,
  dataDir: join(temp, 'data'),
  readInspectorEdges: async () => [{ parent: rootFile, child: childFile, childId, name: 'Correctif tray' }],
  inspectorClient: {
    async getInspector() {
      return {
        state: {},
        children: [{ id: childId, parentId: rootId, sessionName: 'Correctif tray', status: 'done', model: 'anthropic/claude-opus-4-5' }],
      };
    },
    close() {},
  },
  runtime: {
    getStatus: async () => ({ available: true, version: '0.9.8' }),
    getModels: async () => ({ models: [], default: {} }),
    start: async () => {
      throw new Error('inert fixture');
    },
    close: async () => {},
  },
  openDirectory: async () => {},
});
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${app.server.address().port}`;
const browser = await launchStudioBrowser();
try {
  for (const theme of ['dark', 'light']) {
    const context = await browser.newContext({ locale: 'fr-FR', colorScheme: theme, viewport: { width: 1440, height: 900 } });
    // Classic layout: the Agents tab lives in the details panel.
    await context.addInitScript((value) => {
      localStorage.setItem('prime-studio-theme', value);
      localStorage.setItem('prime-studio.docking.layout', JSON.stringify({ enabled: false }));
    }, theme);
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url);
    await page.locator('#session-list .session-select').filter({ hasText: 'Lancer le travail' }).click();
    if (!(await page.locator('#details-panel').isVisible())) await page.locator('#toggle-details').click();
    await page.getByRole('tab', { name: 'Agents', exact: true }).click();
    await page.locator(`[data-agent-id="${childId}"]`).click();
    const viewer = page.locator('.inspector-viewer[open]');
    const body = viewer.locator('.inspector-view-body');
    await expect(body).toContainText('Dernier message du sous-agent.');
    // Messages stay visible; each run of tool calls is one block.
    await expect(body.locator('.inspector-message')).toHaveCount(8);
    const blocks = body.locator('.inspector-activity');
    await expect(blocks).toHaveCount(7);
    await expect(blocks.nth(0)).toContainText('6 appels d’outil');
    await expect(blocks.nth(1)).toContainText('9 appels d’outil');
    await expect(blocks.nth(1)).toContainText('1 réflexion');
    await expect(blocks.nth(1)).toContainText('1 erreur');
    // Opens at the end, like a chat.
    await page.waitForTimeout(150);
    const scroll = await body.evaluate((n) => ({ top: n.scrollTop, max: n.scrollHeight - n.clientHeight }));
    assert.ok(scroll.max > 0, 'fixture overflows the viewer');
    assert.ok(scroll.max - scroll.top <= 2, `viewer starts at the bottom (${scroll.top}/${scroll.max})`);
    await page.screenshot({ path: join(out, `agent-history-${theme}.png`) });
    // Lazy body: tool blocks appear when the group is opened.
    await blocks.nth(1).locator('summary').first().click();
    await expect(blocks.nth(1).locator('.tool-block')).toHaveCount(9);
    await expect(blocks.nth(1).locator('.thinking-block')).toHaveCount(1);
    await page.screenshot({ path: join(out, `agent-history-open-${theme}.png`) });
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('Agent history viewer passed: activity grouped between messages, counts, lazy blocks, opens at the latest message, dark/light.');
} finally {
  await browser.close();
  await app.close();
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
