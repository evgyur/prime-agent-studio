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

  // Built with createElement (no innerHTML): owned ids stay unique per
  // Preferences instance and the dual-instance stub can observe them.
  const el = (tag, className, i18n) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (i18n) node.dataset.i18n = i18n;
    return node;
  };
  root.replaceChildren();
  const headingWrap = el('div', 'model-defaults-heading');
  const headingText = el('div');
  const heading = el('h3', null, 'engine.legacy_title');
  // The dialog labels this card by heading id; clones skip the id so the
  // document never carries duplicates.
  if (isPrimary) heading.id = 'engine-settings-heading';
  heading.textContent = tr('engine.legacy_title');
  headingText.append(heading);
  const resetButton = document.createElement('button');
  resetButton.type = 'button';
  resetButton.className = 'primary-button';
  resetButton.id = scopedId('reset-legacy-settings');
  resetButton.dataset.i18n = 'engine.legacy_reset';
  resetButton.textContent = tr('engine.legacy_reset');
  headingWrap.append(headingText, resetButton);
  const note = el('p', 'model-defaults-note', 'engine.legacy_note');
  const list = el('ul', 'engine-legacy-list');
  const statusLine = el('p', 'engine-status subagent-status');
  statusLine.setAttribute('role', 'status');
  const errorBox = el('p', 'engine-error form-error');
  errorBox.setAttribute('role', 'alert');
  errorBox.hidden = true;
  root.append(headingWrap, note, list, statusLine, errorBox);

  function translateStatic() {
    for (const element of root.querySelectorAll('[data-i18n]')) {
      const key = element.dataset.i18n;
      if (!key) continue;
      bindText(element, () => tr(key));
    }
  }
  translateStatic();

  function error(message = '') {
    bindText(errorBox, () => (message ? translateKnown(message) : ''));
    errorBox.hidden = !message;
  }

  function status(messageKey) {
    bindText(statusLine, () => (messageKey ? tr(messageKey) : ''));
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
