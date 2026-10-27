import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getAllowOutsidePreview,
  normalizeAllowOutsidePreview,
  fetchFilePreviewSettings,
  createFilePreviewSettings,
  onAllowOutsidePreviewChange,
  __resetFilePreviewSettingsForTests,
} from '../public/file-preview-settings.js';
import { isLinkableFileStatus, createReferenceChecker } from '../public/file-links.js';
import { shouldAttemptExternalPreview } from '../public/inspector.js';

test('outside preview defaults to enabled when server omits the flag', () => {
  assert.equal(normalizeAllowOutsidePreview(undefined), true);
  assert.equal(normalizeAllowOutsidePreview(null), true);
  assert.equal(normalizeAllowOutsidePreview('yes'), true);
  assert.equal(normalizeAllowOutsidePreview(false), false);
  assert.equal(normalizeAllowOutsidePreview(true), true);
});

test('shared outside snapshot defaults to enabled', () => {
  __resetFilePreviewSettingsForTests();
  assert.equal(getAllowOutsidePreview(), true);
  __resetFilePreviewSettingsForTests();
});

test('fetch helper publishes the server value', async () => {
  __resetFilePreviewSettingsForTests();
  const seen = [];
  const off = onAllowOutsidePreviewChange((v) => seen.push(v));
  try {
    const value = await fetchFilePreviewSettings(async () => ({ allowOutsideProject: false }));
    assert.equal(value, false);
    assert.equal(getAllowOutsidePreview(), false);
    assert.deepEqual(seen, [false]);
  } finally {
    off();
    __resetFilePreviewSettingsForTests();
  }
});

test('outside links: enabled pref makes outside linkable, read-only never', () => {
  __resetFilePreviewSettingsForTests();
  assert.equal(getAllowOutsidePreview(), true);
  assert.equal(isLinkableFileStatus('outside', { readOnly: false }), true);
  assert.equal(isLinkableFileStatus('outside', { readOnly: true }), false);
  assert.equal(isLinkableFileStatus('file', {}), true);
  assert.equal(isLinkableFileStatus('unknown', {}), true);
  assert.equal(isLinkableFileStatus('missing', {}), false);
  assert.equal(isLinkableFileStatus('blocked', {}), false);
  __resetFilePreviewSettingsForTests();
});

test('outside links fall back to folder-reveal rule when fetch helper reports disabled', async () => {
  __resetFilePreviewSettingsForTests();
  await fetchFilePreviewSettings(async () => ({ allowOutsideProject: false }));
  try {
    assert.equal(
      isLinkableFileStatus('outside', { readOnly: false, nativeFileOpen: true, online: true }),
      true,
    );
    assert.equal(
      isLinkableFileStatus('outside', { readOnly: false, nativeFileOpen: false, online: true }),
      false,
    );
    assert.equal(
      isLinkableFileStatus('outside', { readOnly: true, nativeFileOpen: true, online: true }),
      false,
    );
  } finally {
    __resetFilePreviewSettingsForTests();
  }
});

test('reference checker exposes clear() to invalidate caches on toggle', async () => {
  let calls = 0;
  const checker = createReferenceChecker(
    async () => {
      calls++;
      return [{ reference: 'a.md', status: 'file' }];
    },
    { delay: 1 },
  );
  assert.equal(typeof checker.clear, 'function');
  assert.equal(await checker.check('C:/p', '', 'a.md'), 'file');
  assert.equal(calls, 1);
  checker.clear();
  assert.equal(await checker.check('C:/p', '', 'a.md'), 'file');
  assert.equal(calls, 2);
});

test('external preview attempted only for outside 403 when allowed and not read-only', () => {
  const outside = Object.assign(new Error('outside'), { status: 403 });
  assert.equal(shouldAttemptExternalPreview(outside, { readOnly: false, allowOutside: true }), true);
  assert.equal(shouldAttemptExternalPreview(outside, { readOnly: true, allowOutside: true }), false);
  assert.equal(shouldAttemptExternalPreview(outside, { readOnly: false, allowOutside: false }), false);
  assert.equal(
    shouldAttemptExternalPreview(Object.assign(new Error('x'), { status: 404 }), {
      readOnly: false,
      allowOutside: true,
    }),
    false,
  );
  assert.equal(
    shouldAttemptExternalPreview(Object.assign(new Error('x'), { status: 403, code: 'outside' }), {
      readOnly: false,
      allowOutside: true,
    }),
    true,
  );
});

test('settings save reverts the toggle on failure', async () => {
  __resetFilePreviewSettingsForTests();
  documentShim();
  await fetchFilePreviewSettings(async () => ({ allowOutsideProject: true }));
  const calls = [];
  const ui = createFilePreviewSettings({
    api: async () => {
      throw new Error('nope');
    },
    getContext: () => ({ readOnly: false }),
    onChanged: () => calls.push('changed'),
  });
  ui.start();
  const input = globalThis.document.getElementById('settings-allow-outside-preview');
  assert.equal(input.checked, true);
  const ok = await ui.save(false);
  assert.equal(ok, false);
  assert.equal(input.checked, true);
  assert.deepEqual(calls, []);
  ui.dispose();
  __resetFilePreviewSettingsForTests();
  delete globalThis.document;
});

test('settings save posts the new value on success', async () => {
  __resetFilePreviewSettingsForTests();
  documentShim(true);
  const ui = createFilePreviewSettings({
    api: async (path, opts) => {
      if (opts?.method === 'POST') {
        assert.equal(path, '/api/file-preview-settings');
        assert.deepEqual(opts.body, { allowOutsideProject: false });
        return { allowOutsideProject: false };
      }
      return { allowOutsideProject: true };
    },
    getContext: () => ({ readOnly: false }),
  });
  await ui.refresh();
  const ok = await ui.save(false);
  assert.equal(ok, true);
  assert.equal(getAllowOutsidePreview(), false);
  ui.dispose();
  __resetFilePreviewSettingsForTests();
  delete globalThis.document;
});

function documentShim(known = true) {
  const input = { checked: true, disabled: !known, onchange: null };
  const error = { hidden: true, textContent: '' };
  const note = {};
  globalThis.document = {
    getElementById: (id) => {
      if (id === 'settings-allow-outside-preview') return input;
      if (id === 'file-preview-error') return error;
      if (id === 'file-preview-note') return note;
      return null;
    },
  };
}
