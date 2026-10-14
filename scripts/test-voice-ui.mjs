// Browser-level voice flow with a synthetic microphone and transcription service.
// No audio, provider credentials, or user sessions leave this local fixture.
import { expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

const root = await mkdtemp(join(tmpdir(), 'prime-voice-ui-'));
const project = join(root, 'project');
await Promise.all(
  [project, join(root, 'sessions'), join(root, 'data'), join(root, 'agent')].map((path) => mkdir(path)),
);
const starts = [];
const queued = [];
let failStart = false;
const runtime = {
  getStatus: async () => ({ available: true, version: 'fixture' }),
  getModels: async () => ({
    models: [{ id: 'fixture/sol', name: 'Sol', provider: 'fixture' }],
    default: { model: 'fixture/sol', thinking: 'medium' },
  }),
  async start(input) {
    if (failStart) {
      failStart = false;
      throw new Error('fixture send rejected');
    }
    starts.push(input);
    const sessionId = input.sessionId || `voice-session-${starts.length}`;
    if (!input.sessionId)
      await writeFile(
        join(root, 'sessions', `voice-${starts.length}.jsonl`),
        JSON.stringify({
          type: 'session',
          id: sessionId,
          cwd: project,
          version: 3,
          timestamp: new Date().toISOString(),
        }) + '\n',
      );
    input.onEvent({ kind: 'session', sessionId, cwd: input.cwd });
    return { sessionId, done: new Promise(() => {}), cancel: async () => {} };
  },
  close: async () => {},
};
const app = createApp({
  runtime,
  liveClient: {
    getSnapshot: async () => ({ available: true, steering: [], followUps: [] }),
    send: async (_id, _cwd, input) => {
      queued.push(input);
      return { accepted: true, snapshot: { available: true, steering: [], followUps: [] } };
    },
  },
  sessionDir: join(root, 'sessions'),
  dataDir: join(root, 'data'),
  agentHome: join(root, 'agent'),
  initialCwd: project,
});
await app.store.project({ cwd: project, pinned: true }, true);
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${app.server.address().port}`;
let browser;
const recovery = new Set();
try {
  browser = await launchStudioBrowser({ headless: true });
  for (const width of [1280, 390]) {
    const initialStarts = starts.length;
    const initialQueued = queued.length;
    const page = await browser.newPage({ viewport: { width, height: 900 }, locale: 'en-US' });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let transcript = 'spoken prompt';
    let delayed = null;
    let failTranscribe = false;
    let transcriptionCalls = 0;
    let enabled = true;
    let autoSend = true;
    await page.route('**/api/voice', (route) =>
      route.fulfill({
        json: {
          enabled,
          provider: 'groq',
          reason: null,
          maxAudioBytes: 10485760,
          maxDurationMs: 300000,
          timeoutMs: 90000,
          autoSend,
        },
      }),
    );
    await page.route('**/api/voice/transcribe', async (route) => {
      transcriptionCalls++;
      if (delayed)
        await new Promise((resolve) => {
          delayed.resolve = resolve;
        });
      if (failTranscribe)
        return route.fulfill({ status: 503, json: { error: 'fixture unavailable', code: 'unavailable' } });
      await route.fulfill({ json: { text: transcript } });
    });
    await page.addInitScript(() => {
      window.__voice = { mode: 'allow', tracksStopped: 0, release: null, size: 4, recorderError: null };
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: () => {
            if (window.__voice.mode === 'deny')
              return Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
            if (window.__voice.mode === 'pending')
              return new Promise((resolve) => {
                window.__voice.release = resolve;
              });
            return Promise.resolve({
              getTracks: () => [
                {
                  stop: () => {
                    window.__voice.tracksStopped++;
                  },
                },
              ],
            });
          },
        },
      });
      window.__voice.mediaDevices = navigator.mediaDevices;
      window.MediaRecorder = class extends EventTarget {
        static isTypeSupported(type) {
          return type.startsWith('audio/webm');
        }
        constructor(_stream, options) {
          super();
          this.mimeType = options.mimeType;
          this.state = 'inactive';
        }
        start() {
          this.state = 'recording';
          if (window.__voice.recorderError === 'before') queueMicrotask(() => this.onerror?.());
        }
        stop() {
          if (this.state === 'inactive') return;
          this.state = 'inactive';
          queueMicrotask(() => {
            if (window.__voice.recorderError === 'during') this.onerror?.();
            this.ondataavailable?.({
              data: new Blob([new Uint8Array(window.__voice.size)], { type: this.mimeType }),
            });
            this.dispatchEvent(new Event('stop'));
          });
        }
      };
      window.__voice.Recorder = window.MediaRecorder;
    });
    await page.goto(url);
    await expect(page.locator('#connection-label')).toContainText(/connect/i, { timeout: 15000 });
    try {
      await expect(page.locator('.voice-open:visible').first()).toBeVisible();
    } catch (error) {
      console.error(
        'Voice bootstrap diagnostics',
        errors,
        await page.locator('#connection-label').textContent(),
        await page.locator('#toasts').textContent(),
      );
      throw error;
    }
    if (width === 390) {
      await page.locator('#toggle-sidebar').click();
    }
    await page.locator('#new-session').click();
    const form = page.locator('.composer-form:visible').first();
    const input = form.locator('textarea');
    await expect(input).toBeVisible();
    const button = form.locator('.voice-open');
    await expect(button).toBeEnabled();
    if (width === 390) {
      expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(44);
      await page.setViewportSize({ width: 320, height: 900 });
      const voiceBounds = await button.boundingBox();
      const formBounds = await form.boundingBox();
      expect(voiceBounds.x).toBeGreaterThanOrEqual(formBounds.x);
      expect(voiceBounds.x + voiceBounds.width).toBeLessThanOrEqual(formBounds.x + formBounds.width + 1);
      await page.setViewportSize({ width, height: 900 });
    }

    await input.fill('draft');
    await button.click();
    await expect(page.locator('.voice-status')).toContainText('Recording');
    const firstRunResponse = page.waitForResponse(
      (response) => response.url().endsWith('/api/runs') && response.request().method() === 'POST',
    );
    await page.locator('.voice-send').evaluate((element) => {
      element.click();
      element.click();
    });
    await firstRunResponse;
    try {
      await expect.poll(() => starts.length).toBe(initialStarts + 1);
    } catch (error) {
      console.error('Voice send diagnostics', {
        status: await page.locator('.voice-status').textContent(),
        preview: await page.locator('.voice-preview').textContent(),
        input: await input.inputValue(),
        errors,
        toast: await page.locator('#toasts').textContent(),
      });
      throw error;
    }
    expect(starts.at(-1).message).toBe('draft\n\nspoken prompt');
    expect(transcriptionCalls).toBe(1);
    expect(await page.evaluate(() => window.__voice.tracksStopped)).toBeGreaterThan(0);
    await expect(input).toHaveValue('');
    await expect(form.locator('.stop-button')).toBeVisible();

    await input.fill('during run');
    await expect(form.locator('.send-button')).toBeEnabled();
    await button.click();
    await page.locator('.voice-send').click();
    try {
      await expect.poll(() => queued.length).toBe(initialQueued + 1);
    } catch (error) {
      console.error('Active-run diagnostics', {
        status: await page.locator('.voice-status').textContent(),
        draft: await input.inputValue(),
        toasts: await page.locator('#toasts').textContent(),
        starts: starts.length,
        queued: queued.length,
        errors,
      });
      throw error;
    }
    expect(queued.at(-1).message).toBe('during run\n\nspoken prompt');
    expect(starts.length).toBe(initialStarts + 1);

    // A changed draft after recording starts must never be auto-submitted.
    if (width === 390) await page.locator('#toggle-sidebar').click();
    await page.locator('#new-session').click();
    await input.fill('failed draft');
    failStart = true;
    await button.click();
    await page.locator('.voice-send').click();
    await expect(page.locator('#toasts')).toContainText('fixture send rejected');
    await expect(input).toHaveValue('failed draft\n\nspoken prompt');
    if (width === 390) await page.locator('#toggle-sidebar').click();
    await page.locator('#new-session').click();
    await input.fill('before');
    await button.click();
    await input.evaluate((element) => {
      element.value = 'after';
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const prior = starts.length;
    await page.locator('.voice-send').click();
    await expect(page.locator('.voice-insert')).toBeVisible();
    expect(starts.length).toBe(prior);
    await page.locator('.voice-insert').click();
    await expect(input).toHaveValue('after\n\nspoken prompt');
    expect(starts.length).toBe(prior);

    // A temporary failure keeps the recording: Retry resends it without the microphone.
    failTranscribe = true;
    await button.click();
    await page.locator('.voice-send').click();
    await expect(page.locator('.voice-status')).toContainText('Your recording is kept');
    await expect(page.locator('.voice-send')).toHaveText('Retry');
    await expect(page.locator('.voice-send')).toBeEnabled();
    await expect(input).toHaveValue('after\n\nspoken prompt');
    const failedCalls = transcriptionCalls;
    const tracksBeforeRetry = await page.evaluate(() => window.__voice.tracksStopped);
    await page.locator('.voice-send').click();
    await expect.poll(() => transcriptionCalls).toBe(failedCalls + 1);
    await expect(page.locator('.voice-send')).toHaveText('Retry');
    expect(await page.evaluate(() => window.__voice.tracksStopped)).toBe(tracksBeforeRetry);
    expect(starts.length).toBe(prior);
    await page.locator('.voice-cancel').click();
    await expect(page.locator('.voice-send')).toHaveText('Send');
    failTranscribe = false;

    transcript = 'x'.repeat(32001);
    await button.click();
    await page.locator('.voice-send').click();
    await expect(page.locator('.voice-status')).toContainText('32,000-character');
    expect(starts.length).toBe(prior);
    await page.locator('.voice-cancel').click();
    transcript = 'spoken prompt';

    delayed = {};
    await button.click();
    await page.locator('.voice-send').click();
    await expect.poll(() => Boolean(delayed.resolve)).toBe(true);
    await page.evaluate(() => document.getElementById('new-session').click());
    delayed.resolve();
    delayed = null;
    // Never auto-sent. A still-open origin offers insertion; an origin rebound
    // to another conversation offers a copy instead of inserting elsewhere.
    await expect(page.locator('.voice-insert')).toBeVisible();
    if ((await page.locator('.voice-insert').textContent()) === 'Copy text') {
      recovery.add(`${width}:copy`);
      await expect(page.locator('.voice-status')).toContainText('no longer available');
      await page.locator('.voice-insert').click();
      await expect(page.locator('.voice-status')).toContainText(/Text (copied|selected)/);
      await page.locator('.voice-cancel').click();
    } else {
      recovery.add(`${width}:insert`);
      await page.locator('.voice-insert').click();
      await expect(page.locator('.voice-dialog')).toBeHidden();
    }
    expect(starts.length).toBe(prior);

    await page.evaluate(() => {
      window.__voice.mode = 'deny';
    });
    await button.click();
    await expect(page.locator('.voice-status')).toContainText('denied');
    await expect(page.locator('.voice-send')).toBeDisabled();
    await page.locator('.voice-cancel').click();

    await page.evaluate(() => {
      window.__voice.mode = 'pending';
    });
    await button.click();
    await expect(page.locator('.voice-status')).toContainText('Waiting');
    await page.locator('.voice-cancel').click();
    await page.evaluate(() =>
      window.__voice.release({
        getTracks: () => [
          {
            stop: () => {
              window.__voice.tracksStopped++;
            },
          },
        ],
      }),
    );
    await expect.poll(() => page.evaluate(() => window.__voice.tracksStopped)).toBeGreaterThan(1);

    await page.evaluate(() => {
      window.__voice.mode = 'allow';
      window.__voice.recorderError = 'before';
    });
    await button.click();
    await expect(page.locator('.voice-status')).toContainText('Could not record');
    await expect(page.locator('.voice-send')).toBeDisabled();
    await page.locator('.voice-cancel').click();

    const callsBeforeError = transcriptionCalls;
    await page.evaluate(() => {
      window.__voice.recorderError = 'during';
    });
    await button.click();
    await page.locator('.voice-send').click();
    await expect(page.locator('.voice-status')).toContainText('Could not record');
    expect(transcriptionCalls).toBe(callsBeforeError);
    await page.locator('.voice-cancel').click();

    await page.evaluate(() => {
      window.__voice.recorderError = null;
      window.MediaRecorder = undefined;
    });
    await button.click();
    await expect(page.locator('.voice-status')).toContainText('not supported');
    await page.locator('.voice-cancel').click();
    await page.evaluate(() => {
      window.MediaRecorder = window.__voice.Recorder;
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
    });
    await button.click();
    await expect(page.locator('.voice-status')).toContainText('not supported');
    await page.locator('.voice-cancel').click();
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: window.__voice.mediaDevices,
      });
    });

    await page.evaluate(() => {
      window.__voice.mode = 'allow';
      window.__voice.size = 10485761;
    });
    await button.click();
    await page.locator('.voice-send').click();
    await expect(page.locator('.voice-status')).toContainText('10 MiB');
    await page.locator('.voice-cancel').click();
    expect(starts.length).toBe(prior);
    await page.evaluate(() => {
      window.__voice.size = 4;
    });

    if (width === 1280) {
      await input.fill('attachment context');
      await button.click();
      await form
        .locator('input[type="file"]')
        .last()
        .setInputFiles({
          name: 'context.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('fixture'),
        });
      await expect(form.locator('.image-draft')).toHaveCount(1);
      await page.locator('.voice-send').click();
      await expect(page.locator('.voice-insert')).toBeVisible();
      expect(starts.length).toBe(prior);
      await page.locator('.voice-cancel').click();

      await page.evaluate(() => document.getElementById('new-session').click());
      await input.fill('/model');
      await expect(page.locator('.command-suggestion').first()).toBeVisible();
      await input.press('Tab');
      await expect(form.locator('.composer-command').first()).toBeVisible();
      await input.fill('command context');
      await button.click();
      await form
        .locator('.composer-command')
        .first()
        .evaluate((node) => node.querySelector('button').click());
      await page.locator('.voice-send').click();
      await expect(page.locator('.voice-insert')).toBeVisible();
      expect(starts.length).toBe(prior);
      await page.locator('.voice-cancel').click();

      await button.click();
      await form.locator('[data-cvw="thinking"]').evaluate((node) => {
        node.value = 'high';
        node.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.locator('.voice-send').click();
      await expect(page.locator('.voice-insert')).toBeVisible();
      expect(starts.length).toBe(prior);
      await page.locator('.voice-cancel').click();

      await input.fill('run context');
      await button.click();
      await form.evaluate((node) => node.requestSubmit());
      await expect.poll(() => starts.length).toBe(prior + 1);
      await expect(page.locator('.voice-dialog')).toBeHidden();
      expect(starts.length).toBe(prior + 1);
    }

    if (width === 1280) {
      // A secondary conversation focused on desktop, then a narrow layout: the
      // visible host microphone must open for its own conversation.
      await page.evaluate(() => document.getElementById('new-session').click());
      await page.setViewportSize({ width: 390, height: 900 });
      await expect(page.locator('#composer')).toBeVisible();
      await page.locator('#composer').fill('host draft');
      await page.locator('#composer-form .voice-open').click();
      await expect(page.locator('.voice-status')).toContainText('Recording');
      await page.locator('.voice-cancel').click();
      await expect(page.locator('#composer')).toHaveValue('host draft');
      await page.setViewportSize({ width, height: 900 });
    }

    // Draft mode: the transcript joins the draft, unsent, even after a draft change.
    autoSend = false;
    await page.reload();
    await expect(page.locator('#connection-label')).toContainText(/connect/i, { timeout: 15000 });
    const draftForm = page.locator('.composer-form:visible').first();
    const draftInput = draftForm.locator('textarea');
    await draftInput.fill('to complete');
    const beforeDraft = starts.length;
    const queuedBeforeDraft = queued.length;
    await draftForm.locator('.voice-open').click();
    await expect(page.locator('.voice-send')).toHaveText('Transcribe');
    await page.locator('.voice-send').click();
    await expect(page.locator('.voice-dialog')).toBeHidden();
    await expect(draftInput).toHaveValue('to complete\n\nspoken prompt');
    await expect(draftInput).toBeFocused();
    expect(starts.length).toBe(beforeDraft);
    expect(queued.length).toBe(queuedBeforeDraft);
    autoSend = true;

    // Disabled provider omits the capture control on a fresh load.
    enabled = false;
    await page.reload();
    await expect(page.locator('.voice-open:visible')).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.close();
  }
  const readonly = await browser.newPage({ locale: 'en-US' });
  await readonly.route('**/api/voice', (route) =>
    route.fulfill({
      json: {
        enabled: true,
        provider: 'whisper',
        maxAudioBytes: 10485760,
        maxDurationMs: 300000,
        timeoutMs: 90000,
      },
    }),
  );
  await readonly.route('**/api/bootstrap', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.preferences.readOnly = true;
    await route.fulfill({ response, json: data });
  });
  await readonly.goto(url);
  await expect(readonly.locator('html')).toHaveAttribute('data-read-only', 'true');
  await expect(readonly.locator('.voice-open:visible')).toHaveCount(0);
  await readonly.close();
  console.log('Voice UI recovery paths:', [...recovery].join(', '));
  console.log(
    'Voice UI: desktop/mobile send and active-run queue; stale draft/view/model/command/attachment guards; retry after failure, copy after rebinding, desktop to mobile host mic, draft mode without sending, recorder errors, limits, denied/late mic, disabled/read-only passed',
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => app.server.close(resolve));
  await app.close?.();
  await rm(root, { recursive: true, force: true });
}
