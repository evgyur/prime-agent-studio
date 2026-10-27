import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { preferencesFixture } from './preview-preferences.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const f = await preferencesFixture();
let browser;
try {
  const cwd = join(f.temp, 'Projet de démonstration');
  const outside = join(f.temp, 'outside-notes.md');
  await writeFile(outside, '# Outside preview\nEXTERNAL_PREVIEW_VERIFIED\n');
  const timestamp = new Date().toISOString();
  await writeFile(
    join(f.temp, 'sessions', 'outside-preview.jsonl'),
    [
      { type: 'session', id: 'outside-preview', version: 3, cwd, timestamp },
      { type: 'message', id: 'user', timestamp, message: { role: 'user', content: 'Outside preview test' } },
      {
        type: 'message',
        id: 'assistant',
        parentId: 'user',
        timestamp,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `[Outside notes](<${outside.replaceAll('\\', '/')}>)` }],
          stopReason: 'stop',
        },
      },
    ]
      .map(JSON.stringify)
      .join('\n') + '\n',
  );
  browser = await launchStudioBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(f.url);
  await page.locator('#session-list').getByText('Outside preview test', { exact: true }).click();
  await page.locator('.message.assistant a.document-link').filter({ hasText: 'Outside notes' }).click();
  await expect(page.locator('.inspector-outside-badge')).toBeVisible();
  await expect(page.locator('.inspector-viewer[open] .inspector-view-body')).toContainText(
    'EXTERNAL_PREVIEW_VERIFIED',
  );
  await expect(page.locator('.inspector-outside-path')).toContainText('outside-notes.md');
  await mkdir('.local/study/external-preview-shots', { recursive: true });
  await page.screenshot({ path: '.local/study/external-preview-shots/preview.png' });
  await page.keyboard.press('Escape');
  await page.locator('#open-settings').click();
  const toggle = page.locator('#settings-allow-outside-preview');
  await expect(toggle).toBeEnabled();
  await expect(toggle).toBeChecked();
  await toggle.evaluate((input) => input.closest('.settings-row').scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: '.local/study/external-preview-shots/preferences.png' });
  await toggle.uncheck();
  await expect(toggle).toBeEnabled();
  assert.equal((await (await fetch(f.url + '/api/file-preview-settings')).json()).allowOutsideProject, false);
  const blocked = await fetch(
    f.url + '/api/file-previews/external?' + new URLSearchParams({ cwd, reference: outside }),
  );
  assert.equal(blocked.status, 403);
  await toggle.check();
  await expect(toggle).toBeEnabled();
  await page.reload();
  await page.locator('#open-settings').click();
  await expect(page.locator('#settings-allow-outside-preview')).toBeChecked();
  assert.deepEqual(errors, []);
  console.log('External preview real-browser integration passed; no page errors.');
} finally {
  await browser?.close();
  await f.close();
}
