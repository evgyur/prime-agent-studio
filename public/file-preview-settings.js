import { t as tr, bindText, translateKnown, onLanguageChange } from './i18n.js';

// Shared confirmed snapshot for the global "allow outside-project previews"
// preference (GET/POST /api/file-preview-settings, default true). A confirmed
// save or refresh publishes synchronously so file links and the inspector
// read the fresh value immediately, before any parent fan-out lands.
let sharedAllowOutside = true;
let sharedAllowOutsideKnown = false;
let sharedAllowOutsideRevision = -1;
const sharedAllowOutsideListeners = new Set();

function revisionNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function publishAllowOutside(value, revision) {
  if (typeof value !== 'boolean') return false;
  const rev = revisionNumber(revision);
  if (rev !== undefined) {
    if (rev < sharedAllowOutsideRevision) return false;
    if (rev > sharedAllowOutsideRevision) sharedAllowOutsideRevision = rev;
  }
  sharedAllowOutside = value;
  sharedAllowOutsideKnown = true;
  for (const fn of [...sharedAllowOutsideListeners]) {
    try {
      fn(value);
    } catch {}
  }
  return true;
}

export function getAllowOutsidePreview() {
  return sharedAllowOutside;
}

export function isFilePreviewSettingsKnown() {
  return sharedAllowOutsideKnown;
}

export function onAllowOutsidePreviewChange(fn) {
  if (typeof fn !== 'function') return () => {};
  sharedAllowOutsideListeners.add(fn);
  return () => {
    try {
      sharedAllowOutsideListeners.delete(fn);
    } catch {}
  };
}

export function __resetFilePreviewSettingsForTests() {
  sharedAllowOutside = true;
  sharedAllowOutsideKnown = false;
  sharedAllowOutsideRevision = -1;
  sharedAllowOutsideListeners.clear();
}

export async function fetchFilePreviewSettings(api) {
  const data = await api('/api/file-preview-settings');
  const value = normalizeAllowOutsidePreview(data?.allowOutsideProject);
  publishAllowOutside(value, revisionNumber(data?.revision));
  return value;
}

export function normalizeAllowOutsidePreview(value) {
  // Server default is true: missing/non-boolean reads as enabled.
  if (typeof value === 'boolean') return value;
  return true;
}

export function createFilePreviewSettings({
  api,
  getContext = () => ({}),
  getElement = null,
  onChanged = () => {},
} = {}) {
  const $ = (id) => (typeof getElement === 'function' ? getElement(id) : document.getElementById(id));
  let busy = false;
  let known = sharedAllowOutsideKnown;
  let allowed = sharedAllowOutside;
  let generation = 0;
  let started = false;
  let offLanguage = null;

  function readOnly() {
    try {
      return getContext()?.readOnly === true;
    } catch {
      return false;
    }
  }

  function locked() {
    return readOnly();
  }

  function showError(message) {
    const box = $('file-preview-error');
    if (!box) return;
    try {
      box.hidden = !message;
    } catch {}
    if (!message) {
      try {
        box.textContent = '';
      } catch {}
      return;
    }
    // Plain text assignment keeps unit shims (plain objects) working and
    // avoids a second live binding; language changes re-render the form.
    try {
      box.textContent = translateKnown(message);
    } catch {}
  }

  function render() {
    try {
      const input = $('settings-allow-outside-preview');
      if (input) {
        input.checked = allowed !== false;
        input.disabled = locked() || busy || !known;
      }
    } catch {}
    try {
      const note = $('file-preview-note');
      if (note && typeof note.setAttribute === 'function') {
        bindText(note, () => tr(locked() ? 'files.allow_outside_readonly' : 'files.allow_outside_note'));
      }
    } catch {}
  }

  function onShared(next) {
    if (busy) return;
    if (typeof next !== 'boolean') return;
    if (next === allowed) return;
    allowed = next;
    known = true;
    render();
  }

  async function refresh() {
    const turn = ++generation;
    busy = true;
    render();
    try {
      const data = await api('/api/file-preview-settings');
      if (turn !== generation) return;
      const rev = revisionNumber(data?.revision);
      if (rev !== undefined && rev < sharedAllowOutsideRevision) {
        allowed = sharedAllowOutside;
        known = true;
      } else {
        allowed = normalizeAllowOutsidePreview(data?.allowOutsideProject);
        known = true;
        publishAllowOutside(allowed, rev);
      }
      showError(false);
    } catch (error) {
      if (turn !== generation) return;
      // Missing endpoint or offline: keep the enabled default so explicit
      // outside clicks still attempt the external route. Mark unknown so the
      // toggle stays disabled until a read succeeds.
      if (!sharedAllowOutsideKnown) {
        allowed = true;
        known = false;
      } else {
        allowed = sharedAllowOutside;
        known = true;
      }
      showError(error?.message || 'files.allow_outside_error');
    } finally {
      if (turn === generation) busy = false;
      render();
    }
  }

  async function save(next) {
    const wanted = next === true;
    if (locked() || busy || !known) return false;
    if (wanted === allowed) {
      render();
      return true;
    }
    const previous = allowed;
    allowed = wanted;
    busy = true;
    render();
    try {
      const result = await api('/api/file-preview-settings', {
        method: 'POST',
        body: { allowOutsideProject: wanted },
      });
      const confirmed = normalizeAllowOutsidePreview(result?.allowOutsideProject);
      allowed = confirmed;
      known = true;
      showError(false);
      render();
      publishAllowOutside(confirmed, revisionNumber(result?.revision));
      try {
        await onChanged(confirmed);
      } catch {}
      return true;
    } catch (error) {
      allowed = previous;
      showError(error?.message || 'files.allow_outside_error');
      render();
      return false;
    } finally {
      busy = false;
      render();
    }
  }

  function start() {
    if (started) {
      render();
      return;
    }
    started = true;
    sharedAllowOutsideListeners.add(onShared);
    if (sharedAllowOutsideKnown) onShared(sharedAllowOutside);
    const input = $('settings-allow-outside-preview');
    if (input) {
      input.onchange = () => {
        void save(input.checked === true);
      };
    }
    try {
      offLanguage = onLanguageChange(() => render());
    } catch {}
    render();
  }

  return {
    start,
    refresh,
    save,
    render,
    get allowed() {
      return allowed;
    },
    get known() {
      return known;
    },
    dispose: () => {
      generation++;
      started = false;
      sharedAllowOutsideListeners.delete(onShared);
      try {
        offLanguage?.();
      } catch {}
      offLanguage = null;
    },
  };
}
