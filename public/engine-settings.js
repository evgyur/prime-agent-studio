import { t as tr, bindText, translateKnown, onLanguageChange } from './i18n.js';

// Legacy settings card ("Anciens réglages détectés" / "Legacy settings
// detected"). Advanced models and quota/budget management were removed:
// Studio no longer edits or reads these values. Values already saved keep
// acting in the native engine, which reads settings.json itself. This card
// only appears when leftover values exist and offers a single Reset that
// deletes them all (settings.json keys plus the Studio quota fallback and
// budget data files). Nothing is changed without the explicit click.
const LEGACY_ITEMS = [
  'auxiliaryModel',
  'imageModel',
  'providerBackupModel',
  'subagentDefaultModel',
  'defaultServiceTier',
  'autonomous',
  'quotaFallback',
  'budgets',
];

export function createEngineSettings({
  api,
  getContext = () => ({}),
  getModels,
  openModelPicker,
  icon,
  onChanged = () => {},
  getElement = null,
  domId = null,
  instanceId = '',
  isPrimary = true,
} = {}) {
  void getModels;
  void openModelPicker;
  void icon;
  void instanceId;
  void isPrimary;
  const scopedId = (logical) => (typeof domId === 'function' ? domId(logical) : logical);
  const root =
    typeof getElement === 'function'
      ? getElement('engine-settings')
      : document.getElementById('engine-settings');
  if (!root) return { open: async () => {}, update: () => {}, root: null, dispose: () => {} };
  let data = null;
  let busy = false;
  let generation = 0;
  let needsLoad = true;

  root.innerHTML = `
    <div class="model-defaults-heading">
      <div>
        <h3 id="engine-settings-heading" data-i18n="engine.legacy_title">Anciens réglages détectés</h3>
      </div>
      <button id="${scopedId('reset-legacy-settings')}" class="primary-button" type="button" data-i18n="engine.legacy_reset">Réinitialiser</button>
    </div>
    <p class="model-defaults-note" data-i18n="engine.legacy_note"></p>
    <ul class="engine-legacy-list"></ul>
    <p class="engine-status subagent-status" role="status"></p>
    <p class="engine-error form-error" role="alert" hidden></p>`;

  const $ = (selector) => root.querySelector(selector);
  const resetButton = $(`#${CSS.escape(scopedId('reset-legacy-settings'))}`);
  const list = $('.engine-legacy-list');

  function translateStatic() {
    for (const element of root.querySelectorAll('[data-i18n]')) {
      const key = element.dataset.i18n;
      if (!key) continue;
      bindText(element, () => tr(key));
    }
  }
  translateStatic();

  function error(message = '') {
    const box = $('.engine-error');
    bindText(box, () => (message ? translateKnown(message) : ''));
    box.hidden = !message;
  }

  function status(messageKey) {
    bindText($('.engine-status'), () => (messageKey ? tr(messageKey) : ''));
  }

  function readOnly() {
    // Reset is a local write action: consultation stays locked, same gating
    // as the former engine-settings write route, so read-only remote clients
    // never see the button.
    const context = getContext();
    return !!context.readOnly;
  }

  function render() {
    const items = Array.isArray(data?.items) ? data.items.filter((key) => LEGACY_ITEMS.includes(key)) : [];
    root.hidden = !data || items.length === 0;
    if (root.hidden) return;
    list.replaceChildren();
    for (const key of items) {
      const entry = document.createElement('li');
      entry.dataset.i18n = `engine.legacy_${key}`;
      list.append(entry);
    }
    for (const entry of list.querySelectorAll('[data-i18n]')) bindText(entry, () => tr(entry.dataset.i18n));
    resetButton.hidden = readOnly() || busy;
    resetButton.disabled = busy || !data;
    if (readOnly()) status('engine.disabled_remote');
    else status('');
  }

  async function load() {
    const turn = ++generation;
    busy = true;
    needsLoad = false;
    error();
    status('engine.legacy_loading');
    resetButton.hidden = true;
    try {
      const state = await api('/api/engine-settings');
      if (turn !== generation) return;
      data = state;
      busy = false;
      error();
      if (!state?.hasLegacy) status('');
      render();
    } catch (e) {
      if (turn !== generation) return;
      data = null;
      busy = false;
      root.hidden = false;
      list.replaceChildren();
      resetButton.hidden = true;
      status('engine.unavailable_engine');
      error(
        e.status === 404
          ? tr('ui.rechargez_le_studio_apres_sa_mise_a_jour_pour_acceder_a_ces_regla')
          : translateKnown(e.message),
      );
    }
  }

  async function reset() {
    if (busy || !data || readOnly()) return;
    const turn = ++generation;
    busy = true;
    resetButton.disabled = true;
    error();
    status('common.saving');
    try {
      const state = await api('/api/engine-settings', { method: 'POST', body: { revision: data.revision } });
      if (turn !== generation) return;
      data = state;
      busy = false;
      error();
      status('engine.legacy_reset_done');
      render();
      try {
        await onChanged();
      } catch {}
    } catch (e) {
      if (turn !== generation) return;
      busy = false;
      status('engine.unsaved_engine');
      error(translateKnown(e.message));
      render();
      if (e.status === 409) {
        // Advise CAS retry: reload before the next deliberate reset.
        needsLoad = true;
      }
    }
  }

  resetButton.onclick = () => void reset();

  // The model-config dialog is owned by app.js: closing abandons nothing
  // (reset is a single deliberate click), every opening reloads fresh state
  // so the card disappears right after a reset from another tab.
  const modelConfigDialog = document.getElementById('model-config-dialog');
  let modelConfigObserver = null;
  if (modelConfigDialog) {
    modelConfigObserver = new MutationObserver(() => {
      if (modelConfigDialog.open) {
        if (needsLoad && !busy) void load();
      } else {
        needsLoad = true;
      }
    });
    modelConfigObserver.observe(modelConfigDialog, { attributes: true, attributeFilter: ['open'] });
    if (modelConfigDialog.open && needsLoad) void load();
  }

  const offLanguage = onLanguageChange(() => {
    translateStatic();
    if (data && !root.hidden) render();
  });

  return {
    open: load,
    root,
    dispose: () => {
      generation++;
      needsLoad = true;
      try {
        modelConfigObserver?.disconnect();
      } catch {}
      modelConfigObserver = null;
      try {
        offLanguage?.();
      } catch {}
    },
    update: () => {
      render();
    },
  };
}
