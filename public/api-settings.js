import { t as tr, bindText, bindAttribute, translateKnown, onLanguageChange, getLanguage } from './i18n.js';

// Generic API preferences (Preferences > API).
// Local-only admin surface for the generic integration API. Token secrets
// stay in memory: shown once, copied on demand, never logged and never
// stored in web storage. Disabled by default; disabling keeps inactive
// credentials for later reactivation. Enabling never turns on networking.
// Remote views (readOnly) keep no token controls: the tab stays hidden.

const ADMIN_ROOT = '/api/public-api';
const TOKEN_ROUTE = '/api/public-api/tokens';
const PROJECT_ID_PATTERN = /^p_[0-9a-fA-F]{32}$/;
const OPTIONAL_SCOPES = ['runs:write', 'roadmaps:write', 'files:download', 'computer:write'];
const SCOPE_LABEL = {
  'computer:write': 'api.scope_computer_write',
  'runs:write': 'api.scope_runs_write',
  'roadmaps:write': 'api.scope_roadmaps_write',
  'files:download': 'api.scope_files_download',
};
const SCOPE_INPUT = {
  'computer:write': 'public-api-scope-computer-write',
  'runs:write': 'public-api-scope-runs-write',
  'roadmaps:write': 'public-api-scope-roadmaps-write',
  'files:download': 'public-api-scope-files-download',
};

function localeTag() {
  return getLanguage() === 'en' ? 'en-US' : 'fr-FR';
}

function formatDay(value) {
  const time = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(time)) return String(value || '');
  try {
    return new Date(time).toLocaleDateString(localeTag(), {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return String(value || '');
  }
}

function isConflict(error) {
  if (!error) return false;
  if (error.status === 409) return true;
  const hay = `${error.code || ''} ${error.message || ''}`.toLowerCase();
  return hay.includes('revision') || hay.includes('conflict');
}

export function createPublicApiSettings({
  api,
  getContext = () => ({}),
  copyText,
  toast,
  icon,
  getElement = null,
  domId = null,
  instanceId = '',
  isPrimary = true,
} = {}) {
  void instanceId;
  void isPrimary;
  const scoped = typeof getElement === 'function';
  const $ = (id) => (scoped ? getElement(id) : document.getElementById(id));
  const scopedId = (logical) => (typeof domId === 'function' ? domId(logical) : logical);
  // Tag dynamically created nodes with their logical id so owned lookups and
  // focus checks keep working on rewritten physical ids.
  const tag = (element, logical) => {
    try {
      element.setAttribute('data-panel-id', logical);
    } catch {}
    return element;
  };
  injectShell(icon, { $, scopedId, tag, scoped });
  const dialog = $('settings-dialog');
  const content = $('public-api-content');
  if (!dialog || !content)
    return {
      refresh: async () => {},
      root: null,
      dispose: () => {},
    };

  let revision;
  let enabled = false;
  let tokens = [];
  let projects = [];
  let machineId = '';
  let endpoints = [];
  let loaded = false;
  let loading = false;
  let busy = false;
  let generation = 0;
  let pendingSecret = null;

  const allowed = () => {
    try {
      const context = getContext();
      return !context.readOnly && !context.remote;
    } catch {
      return true;
    }
  };

  const node = (tag, className, message) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (message) bindText(element, () => tr(message));
    return element;
  };

  function showError(message) {
    const box = $('public-api-error');
    if (!box) return;
    box.hidden = !message;
    if (message) bindText(box, () => translateKnown(message));
  }

  function clearSecret() {
    pendingSecret = null;
    const box = $('public-api-secret');
    const out = $('public-api-credential');
    if (out) out.textContent = '';
    if (box) box.hidden = true;
  }

  function showSecret(secret) {
    pendingSecret = secret;
    const box = $('public-api-secret');
    const out = $('public-api-credential');
    if (!box || !out) return;
    out.textContent = secret;
    box.hidden = false;
    box.scrollIntoView({ block: 'nearest' });
    $('public-api-copy-secret')?.focus();
  }

  function scopeLabel(scope) {
    if (scope === 'read') return tr('api.scope_read');
    return tr(SCOPE_LABEL[scope] || 'api.scope_read');
  }

  function projectName(id) {
    if (id === '*') return tr('api.token_all_projects');
    const found = projects.find((entry) => entry && entry.id === id);
    return (found && (found.name || found.id)) || id;
  }

  function tokenProjectsLabel(token) {
    const ids = Array.isArray(token.projectIds) ? token.projectIds : [];
    if (ids.length === 1 && ids[0] === '*') return tr('api.token_all_projects');
    return ids.map(projectName).join(', ');
  }

  function tokenScopes(token) {
    const extra = Array.isArray(token.scopes) ? token.scopes.filter((s) => s !== 'read') : [];
    return ['read', ...extra];
  }

  function setControlsDisabled() {
    const off = busy || loading || !allowed() || !loaded;
    const formOff = off || !enabled;
    const enableInput = $('public-api-enabled');
    if (enableInput) enableInput.disabled = busy || loading || !allowed() || !loaded;
    for (const id of [
      'public-api-name',
      'public-api-expiry',
      'public-api-all-projects',
      'public-api-create',
      'public-api-refresh',
    ]) {
      const control = $(id);
      if (control) control.disabled = id === 'public-api-refresh' ? busy || loading || !allowed() : formOff;
    }
    for (const scope of OPTIONAL_SCOPES) {
      const control = $(SCOPE_INPUT[scope]);
      if (control) control.disabled = formOff;
    }
    for (const input of content.querySelectorAll(
      '#' + CSS.escape(scopedId('public-api-project-options')) + ' input',
    ))
      input.disabled = formOff;
    for (const button of content.querySelectorAll(
      '#' + CSS.escape(scopedId('public-api-token-list')) + ' button',
    ))
      button.disabled = off;
    content.setAttribute('aria-busy', String(loading));
  }

  function renderStatus() {
    const status = $('public-api-status');
    if (!status) return;
    bindText(status, () =>
      tr(!loaded ? 'settings.loading' : enabled ? 'settings.status_active' : 'settings.status_disabled'),
    );
    status.setAttribute('role', 'status');
  }

  function renderEnable() {
    const input = $('public-api-enabled');
    if (input) input.checked = enabled === true;
    renderStatus();
  }

  function renderEndpoints() {
    const list = $('public-api-endpoints');
    const empty = $('public-api-no-endpoint');
    const machine = $('public-api-machine-id');
    if (machine) machine.textContent = machineId || '—';
    if (!list) return;
    list.replaceChildren();
    const rows = Array.isArray(endpoints) ? endpoints.filter((e) => e && e.url) : [];
    if (empty) empty.hidden = rows.length > 0;
    for (const entry of rows) {
      const row = document.createElement('div');
      row.className = 'public-api-endpoint';
      const kind = document.createElement('span');
      kind.className = 'public-api-kind';
      kind.textContent = entry.kind || '—';
      const url = document.createElement('code');
      url.className = 'network-url';
      url.textContent = entry.url;
      const copy = node('button', 'secondary-button', 'settings.copy_link');
      copy.type = 'button';
      copy.onclick = () => void copyText(entry.url);
      row.append(kind, url, copy);
      list.append(row);
    }
  }

  function renderTokens() {
    const list = $('public-api-token-list');
    const empty = $('public-api-tokens-empty');
    if (!list) return;
    list.replaceChildren();
    const rows = Array.isArray(tokens) ? tokens : [];
    if (empty) empty.hidden = rows.length > 0;
    for (const token of rows) {
      const card = document.createElement('article');
      card.className = 'public-api-token';
      const head = document.createElement('div');
      head.className = 'public-api-token-head';
      const name = document.createElement('strong');
      name.textContent = token.name || token.id || '';
      const expiry = document.createElement('span');
      expiry.className = 'public-api-expiry';
      bindText(expiry, () =>
        token.expiresAt
          ? tr('api.expires_on', { date: formatDay(token.expiresAt) })
          : tr('api.expires_never'),
      );
      head.append(name, expiry);
      const created = document.createElement('p');
      created.className = 'settings-footnote';
      if (token.createdAt)
        bindText(created, () => tr('api.created_on', { date: formatDay(token.createdAt) }));
      const scopes = document.createElement('ul');
      scopes.className = 'public-api-scopes';
      for (const scope of tokenScopes(token)) {
        const item = document.createElement('li');
        bindText(item, () => scopeLabel(scope));
        scopes.append(item);
      }
      const scopeProjects = document.createElement('p');
      scopeProjects.className = 'settings-footnote public-api-projects-line';
      scopeProjects.textContent = tokenProjectsLabel(token);
      const revoke = node('button', 'secondary-button public-api-revoke', 'api.token_revoke');
      revoke.type = 'button';
      revoke.dataset.tokenId = token.id || '';
      revoke.onclick = () => void revokeToken(token.id);
      card.append(head);
      if (token.createdAt) card.append(created);
      card.append(scopes, scopeProjects, revoke);
      list.append(card);
    }
    setControlsDisabled();
  }

  function renderProjects() {
    const wrap = $('public-api-project-options');
    if (!wrap) return;
    const previous = new Set([...wrap.querySelectorAll('input:checked')].map((input) => input.value));
    const all = $('public-api-all-projects');
    const allChecked = all ? all.checked : false;
    wrap.replaceChildren();
    for (const project of projects) {
      if (!project || typeof project.id !== 'string') continue;
      const label = document.createElement('label');
      label.className = 'public-api-option';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = project.id;
      input.checked = previous.has(project.id);
      input.disabled = allChecked || !enabled || busy || loading;
      const text = document.createElement('span');
      text.textContent = project.name || project.id;
      label.append(input, text);
      if (project.cwd) label.title = project.cwd;
      wrap.append(label);
    }
  }

  function renderAll() {
    renderEnable();
    renderEndpoints();
    renderTokens();
    renderProjects();
    setControlsDisabled();
  }

  async function refresh() {
    if (!allowed()) {
      const note = $('public-api-remote-note');
      if (note) note.hidden = false;
      if (content) content.hidden = true;
      return;
    }
    const note = $('public-api-remote-note');
    if (note) note.hidden = true;
    if (content) content.hidden = false;
    if (loading) return;
    loading = true;
    const turn = generation;
    showError('');
    setControlsDisabled();
    try {
      const state = await api(ADMIN_ROOT);
      if (turn !== generation) return;
      revision = state.revision;
      enabled = state.enabled === true;
      tokens = Array.isArray(state.tokens) ? state.tokens : [];
      projects = Array.isArray(state.projects) ? state.projects : [];
      machineId = typeof state.machineId === 'string' ? state.machineId : '';
      endpoints = Array.isArray(state.endpoints) ? state.endpoints : [];
      loaded = true;
      clearSecret();
      renderAll();
      showError('');
    } catch (error) {
      if (turn !== generation) return;
      loaded = false;
      renderAll();
      showError(error && error.status === 404 ? tr('api.unavailable') : translateKnown(error.message));
    } finally {
      if (turn === generation) {
        loading = false;
        setControlsDisabled();
      }
    }
  }

  async function applyEnabled(next) {
    if (busy || loading || !allowed() || !loaded) {
      renderEnable();
      return;
    }
    busy = true;
    showError('');
    setControlsDisabled();
    const turn = generation;
    try {
      const state = await api(ADMIN_ROOT, { method: 'PATCH', body: { enabled: next, revision } });
      if (turn !== generation) return;
      revision = state.revision;
      enabled = state.enabled === true;
      tokens = Array.isArray(state.tokens) ? state.tokens : [];
      projects = Array.isArray(state.projects) ? state.projects : [];
      machineId = typeof state.machineId === 'string' ? state.machineId : machineId;
      endpoints = Array.isArray(state.endpoints) ? state.endpoints : endpoints;
      loaded = true;
      clearSecret();
      renderAll();
      toast(() => tr('api.saved'));
    } catch (error) {
      if (turn !== generation) return;
      if (isConflict(error)) {
        await refresh();
        showError(tr('api.conflict'));
      } else {
        renderEnable();
        showError(translateKnown(error.message));
      }
    } finally {
      if (turn === generation) {
        busy = false;
        setControlsDisabled();
      }
    }
  }

  function readForm() {
    const name = String($('public-api-name')?.value || '').trim();
    const scopes = ['read', ...OPTIONAL_SCOPES.filter((scope) => $(SCOPE_INPUT[scope])?.checked)];
    const allProjects = $('public-api-all-projects')?.checked === true;
    const projectIds = allProjects
      ? ['*']
      : [
          ...content.querySelectorAll(
            '#' + CSS.escape(scopedId('public-api-project-options')) + ' input:checked',
          ),
        ].map((input) => input.value);
    const rawExpiry = String($('public-api-expiry')?.value || '').trim();
    let expiresAt = null;
    if (rawExpiry) {
      const stamp = Date.parse(`${rawExpiry}T23:59:59.000Z`);
      if (!Number.isFinite(stamp)) return { error: tr('api.form_expiry_invalid') };
      expiresAt = new Date(stamp).toISOString();
      if (Date.parse(expiresAt) <= Date.now()) return { error: tr('api.form_expiry_invalid') };
    }
    if (!name || name.length > 60) return { error: tr('api.form_name_required') };
    if (!projectIds.length) return { error: tr('api.form_projects_required') };
    if (!(projectIds.length === 1 && projectIds[0] === '*')) {
      for (const id of projectIds)
        if (!PROJECT_ID_PATTERN.test(id)) return { error: tr('api.form_projects_required') };
    }
    return { name, scopes, projectIds, expiresAt };
  }

  async function createToken(event) {
    event.preventDefault();
    if (busy || loading || !allowed() || !loaded || !enabled) return;
    const parsed = readForm();
    const formError = $('public-api-form-error');
    if (parsed.error) {
      if (formError) {
        formError.hidden = false;
        bindText(formError, () => parsed.error);
        formError.focus?.();
      }
      return;
    }
    if (formError) formError.hidden = true;
    busy = true;
    showError('');
    setControlsDisabled();
    const turn = generation;
    try {
      const data = await api(TOKEN_ROUTE, {
        method: 'POST',
        body: {
          name: parsed.name,
          scopes: parsed.scopes,
          projectIds: parsed.projectIds,
          expiresAt: parsed.expiresAt,
          revision,
        },
      });
      if (turn !== generation) return;
      const state = data.state || data;
      revision = state.revision ?? revision;
      enabled = state.enabled === true ? true : enabled;
      tokens = Array.isArray(state.tokens) ? state.tokens : tokens;
      projects = Array.isArray(state.projects) ? state.projects : projects;
      machineId = typeof state.machineId === 'string' ? state.machineId : machineId;
      endpoints = Array.isArray(state.endpoints) ? state.endpoints : endpoints;
      loaded = true;
      renderAll();
      if (formError) formError.hidden = true;
      const form = $('public-api-create-form');
      form?.reset();
      const all = $('public-api-all-projects');
      if (all) all.checked = false;
      renderProjects();
      if (typeof data.credential === 'string' && data.credential) showSecret(data.credential);
      toast(() => tr('api.token_created'));
    } catch (error) {
      if (turn !== generation) return;
      if (isConflict(error)) {
        await refresh();
        showError(tr('api.conflict'));
      } else {
        showError(translateKnown(error.message));
      }
    } finally {
      if (turn === generation) {
        busy = false;
        setControlsDisabled();
      }
    }
  }

  async function revokeToken(id) {
    if (!id || busy || loading || !allowed() || !loaded) return;
    busy = true;
    showError('');
    setControlsDisabled();
    const turn = generation;
    try {
      const state = await api(`${TOKEN_ROUTE}/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        body: { revision },
      });
      if (turn !== generation) return;
      revision = state.revision ?? revision;
      tokens = Array.isArray(state.tokens) ? state.tokens : [];
      projects = Array.isArray(state.projects) ? state.projects : projects;
      machineId = typeof state.machineId === 'string' ? state.machineId : machineId;
      endpoints = Array.isArray(state.endpoints) ? state.endpoints : endpoints;
      clearSecret();
      renderAll();
      toast(() => tr('api.token_revoked'));
    } catch (error) {
      if (turn !== generation) return;
      if (isConflict(error)) {
        await refresh();
        showError(tr('api.conflict'));
      } else {
        showError(translateKnown(error.message));
      }
    } finally {
      if (turn === generation) {
        busy = false;
        setControlsDisabled();
      }
    }
  }

  function build() {
    content.replaceChildren();
    // Every created id goes through scopedId() + data-panel-id tagging so
    // clones stay unique while the primary keeps byte-identical ids.
    const id = (element, logical) => {
      element.id = scopedId(logical);
      return tag(element, logical);
    };
    const enableRow = document.createElement('div');
    enableRow.className = 'settings-row';
    const enableText = document.createElement('div');
    const enableLabel = node('label', '', 'api.enabled');
    enableLabel.htmlFor = scopedId('public-api-enabled');
    enableText.append(enableLabel, node('p', '', 'api.enabled_note'));
    const enableInput = document.createElement('input');
    id(enableInput, 'public-api-enabled');
    enableInput.className = 'switch';
    enableInput.type = 'checkbox';
    enableInput.setAttribute('role', 'switch');
    enableInput.onchange = () => void applyEnabled(enableInput.checked);
    enableRow.append(enableText, enableInput);
    const kept = node('p', 'settings-footnote', 'api.disabled_keeps_tokens');
    const networkNote = node('p', 'settings-footnote', 'api.network_note');
    const status = document.createElement('p');
    id(status, 'public-api-status');
    status.className = 'settings-footnote';
    status.setAttribute('role', 'status');
    const endpointCard = document.createElement('div');
    endpointCard.className = 'public-api-card';
    endpointCard.append(node('h4', 'public-api-heading', 'api.endpoints_title'));
    const machineRow = document.createElement('div');
    machineRow.className = 'public-api-machine';
    machineRow.append(node('span', '', 'api.machine'));
    const machineIdNode = document.createElement('code');
    id(machineIdNode, 'public-api-machine-id');
    machineIdNode.textContent = '—';
    machineRow.append(machineIdNode);
    const endpointList = document.createElement('div');
    id(endpointList, 'public-api-endpoints');
    const noEndpoint = node('p', 'settings-footnote', 'api.no_endpoint');
    id(noEndpoint, 'public-api-no-endpoint');
    endpointCard.append(machineRow, endpointList, noEndpoint);
    const warnings = document.createElement('div');
    warnings.className = 'public-api-warnings';
    warnings.setAttribute('role', 'note');
    warnings.append(node('p', '', 'api.warn_runs'), node('p', '', 'api.warn_files'));
    const tokensHeading = node('h4', 'public-api-heading', 'api.tokens_title');
    const tokenList = document.createElement('div');
    id(tokenList, 'public-api-token-list');
    const tokensEmpty = node('p', 'settings-footnote', 'api.tokens_empty');
    id(tokensEmpty, 'public-api-tokens-empty');
    const createHeading = node('h4', 'public-api-heading', 'api.create_title');
    const form = document.createElement('form');
    id(form, 'public-api-create-form');
    form.noValidate = true;
    form.onsubmit = (event) => void createToken(event);
    const nameWrap = document.createElement('div');
    nameWrap.className = 'public-api-field';
    const nameLabel = node('label', '', 'api.name_label');
    nameLabel.htmlFor = scopedId('public-api-name');
    const nameInput = document.createElement('input');
    id(nameInput, 'public-api-name');
    nameInput.type = 'text';
    nameInput.maxLength = 60;
    nameInput.autocomplete = 'off';
    bindAttribute(nameInput, 'placeholder', () => tr('api.name_placeholder'));
    nameWrap.append(nameLabel, nameInput);
    const scopeSet = document.createElement('fieldset');
    scopeSet.className = 'public-api-field';
    scopeSet.append(node('legend', '', 'api.scopes_label'));
    const readRow = document.createElement('label');
    readRow.className = 'public-api-option';
    const readInput = document.createElement('input');
    readInput.type = 'checkbox';
    readInput.checked = true;
    readInput.disabled = true;
    const readText = node('span', '', 'api.scope_read');
    readRow.append(readInput, readText);
    scopeSet.append(readRow);
    for (const scope of OPTIONAL_SCOPES) {
      const label = document.createElement('label');
      label.className = 'public-api-option';
      const input = document.createElement('input');
      input.type = 'checkbox';
      id(input, SCOPE_INPUT[scope]);
      const text = node('span', '', SCOPE_LABEL[scope]);
      label.append(input, text);
      scopeSet.append(label);
    }
    const projectSet = document.createElement('fieldset');
    projectSet.className = 'public-api-field';
    projectSet.append(node('legend', '', 'api.projects_label'));
    const allLabel = document.createElement('label');
    allLabel.className = 'public-api-option';
    const allInput = document.createElement('input');
    allInput.type = 'checkbox';
    id(allInput, 'public-api-all-projects');
    allInput.onchange = () => renderProjects();
    allLabel.append(allInput, node('span', '', 'api.token_all_projects'));
    const options = document.createElement('div');
    id(options, 'public-api-project-options');
    options.className = 'public-api-options';
    projectSet.append(allLabel, options);
    const expiryWrap = document.createElement('div');
    expiryWrap.className = 'public-api-field';
    const expiryLabel = node('label', '', 'api.expiry_label');
    expiryLabel.htmlFor = scopedId('public-api-expiry');
    const expiryInput = document.createElement('input');
    id(expiryInput, 'public-api-expiry');
    expiryInput.type = 'date';
    expiryWrap.append(expiryLabel, expiryInput, node('p', 'settings-footnote', 'api.expiry_hint'));
    const formError = document.createElement('p');
    id(formError, 'public-api-form-error');
    formError.className = 'form-error';
    formError.setAttribute('role', 'alert');
    formError.hidden = true;
    formError.tabIndex = -1;
    const createButton = node('button', 'primary-button', 'api.create');
    id(createButton, 'public-api-create');
    createButton.type = 'submit';
    form.append(nameWrap, scopeSet, projectSet, expiryWrap, formError, createButton);
    const secret = document.createElement('div');
    id(secret, 'public-api-secret');
    secret.className = 'public-api-secret';
    secret.hidden = true;
    secret.append(node('strong', '', 'api.secret_title'), node('p', '', 'api.secret_note'));
    const credential = document.createElement('code');
    id(credential, 'public-api-credential');
    credential.className = 'public-api-credential';
    const secretActions = document.createElement('div');
    secretActions.className = 'network-link-actions';
    const copyButton = node('button', 'secondary-button', 'api.copy_secret');
    id(copyButton, 'public-api-copy-secret');
    copyButton.type = 'button';
    copyButton.onclick = () => {
      if (pendingSecret) void copyText(pendingSecret);
    };
    const dismissButton = node('button', 'text-button', 'api.secret_saved');
    id(dismissButton, 'public-api-dismiss-secret');
    dismissButton.type = 'button';
    dismissButton.onclick = () => {
      clearSecret();
      $('public-api-name')?.focus();
    };
    secretActions.append(copyButton, dismissButton);
    secret.append(credential, secretActions);
    content.append(
      enableRow,
      kept,
      networkNote,
      status,
      endpointCard,
      warnings,
      tokensHeading,
      tokenList,
      tokensEmpty,
      createHeading,
      form,
      secret,
    );
  }

  // API tab + panel shell lives inside the OWNED dialog (never document).
  // Clones get scoped ids + data-panel-id; the primary keeps legacy ids.
  function injectShell(iconFn, shellScope) {
    const find = shellScope?.$ || $;
    const sid = shellScope?.scopedId || ((value) => value);
    const mark = shellScope?.tag || ((element) => element);
    const place = (element, logical) => {
      element.id = sid(logical);
      return mark(element, logical);
    };
    if (find('settings-tab-api')) return;
    const ownerDialog = find('settings-dialog');
    const nav = ownerDialog?.querySelector('.settings-nav');
    const panels = ownerDialog?.querySelector('.settings-panels');
    const remoteTab = find('settings-tab-remote');
    if (!nav || !panels) return;
    const tab = document.createElement('button');
    place(tab, 'settings-tab-api');
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', 'false');
    tab.setAttribute('aria-controls', sid('settings-panel-api'));
    tab.tabIndex = -1;
    tab.dataset.settingsTab = 'api';
    const glyph = document.createElement('span');
    glyph.setAttribute('aria-hidden', 'true');
    try {
      if (typeof iconFn === 'function') glyph.append(iconFn('code'));
      else glyph.dataset.icon = 'code';
    } catch {
      glyph.dataset.icon = 'code';
    }
    const label = document.createElement('span');
    label.dataset.i18n = 'api.title';
    label.textContent = 'API';
    tab.append(glyph, label);
    if (remoteTab && remoteTab.nextSibling) nav.insertBefore(tab, remoteTab.nextSibling);
    else nav.append(tab);
    const panel = document.createElement('section');
    place(panel, 'settings-panel-api');
    panel.className = 'settings-panel';
    panel.setAttribute('role', 'tabpanel');
    panel.tabIndex = 0;
    panel.setAttribute('aria-labelledby', sid('settings-tab-api'));
    panel.hidden = true;
    const heading = document.createElement('div');
    heading.className = 'settings-section-heading';
    const title = document.createElement('h3');
    title.dataset.i18n = 'api.title';
    title.textContent = 'API';
    const scope = document.createElement('p');
    scope.className = 'settings-scope';
    scope.dataset.i18n = 'api.scope';
    heading.append(title, scope);
    const wrap = document.createElement('div');
    place(wrap, 'public-api-settings');
    const toolbar = document.createElement('div');
    toolbar.className = 'settings-toolbar';
    const intro = document.createElement('p');
    intro.dataset.i18n = 'api.intro';
    const refreshButton = document.createElement('button');
    place(refreshButton, 'public-api-refresh');
    refreshButton.className = 'text-button';
    refreshButton.type = 'button';
    refreshButton.dataset.i18n = 'settings.refresh';
    refreshButton.textContent = 'Actualiser';
    const docsLink = document.createElement('a');
    place(docsLink, 'public-api-docs');
    docsLink.className = 'text-button';
    docsLink.href = '/api-docs';
    docsLink.target = '_blank';
    docsLink.rel = 'noopener noreferrer';
    docsLink.dataset.i18n = 'api_docs.open';
    toolbar.append(intro, docsLink, refreshButton);
    const errorBox = document.createElement('p');
    place(errorBox, 'public-api-error');
    errorBox.className = 'form-error';
    errorBox.setAttribute('role', 'alert');
    errorBox.hidden = true;
    const remoteNote = document.createElement('p');
    place(remoteNote, 'public-api-remote-note');
    remoteNote.className = 'settings-footnote';
    remoteNote.dataset.i18n = 'api.remote_note';
    remoteNote.hidden = true;
    const body = document.createElement('div');
    place(body, 'public-api-content');
    body.setAttribute('aria-busy', 'true');
    const loadingNote = document.createElement('p');
    loadingNote.className = 'settings-footnote';
    loadingNote.dataset.i18n = 'settings.loading';
    loadingNote.textContent = 'Chargement…';
    body.append(loadingNote);
    wrap.append(toolbar, errorBox, remoteNote, body);
    panel.append(heading, wrap);
    const syncPanel = find('settings-panel-sync');
    if (syncPanel) panels.insertBefore(panel, syncPanel);
    else panels.append(panel);
  }

  build();
  $('public-api-refresh').onclick = () => void refresh();
  // Token secrets stay in memory only: cleared when THIS dialog closes, when
  // the page hides, and on dispose. Never stored, never shared with siblings.
  const onOwnedClose = () => {
    generation++;
    clearSecret();
  };
  dialog.addEventListener('close', onOwnedClose);
  const onPageHide = () => clearSecret();
  window.addEventListener('pagehide', onPageHide);
  const offLanguage = onLanguageChange(() => {
    if (!dialog.open) return;
    renderStatus();
    renderEndpoints();
    renderTokens();
  });

  return {
    refresh,
    get root() {
      return dialog;
    },
    dispose: () => {
      generation++;
      clearSecret();
      try {
        dialog.removeEventListener('close', onOwnedClose);
      } catch {}
      try {
        window.removeEventListener('pagehide', onPageHide);
      } catch {}
      try {
        offLanguage?.();
      } catch {}
    },
  };
}
