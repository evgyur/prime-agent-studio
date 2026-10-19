import { t, getLanguage, onLanguageChange } from './i18n.js';

const node = (tag, cls = '', text = '') => {
  const el = document.createElement(tag);
  el.className = cls;
  el.textContent = text;
  return el;
};
const endpoint = (context) => `/api/projects/${encodeURIComponent(context.project.metricsId)}/context`;
export async function pinContextFile(api, context, pin) {
  if (!context?.project?.metricsId || context.unavailable || context.readOnly) throw new Error(t('context.unavailable'));
  const url = endpoint(context), query = new URLSearchParams({ sessionId: context.sessionId || '' });
  const data = await api(`${url}?${query}`);
  const pins = data.pins || [];
  if (!pins.some((item) => item.path === pin.path && item.startLine === pin.startLine && item.endLine === pin.endLine))
    await api(url, { method: 'PATCH', body: { pins: [...pins, pin] } });
}

// Only visible panels subscribe. SSE carries complete snapshots; no polling.
export function createContext({ api, getContext }) {
  const root = node('section', 'context-panel');
  root.hidden = true;
  let visible = false, key = '', generation = 0, stream = null, controller = null;
  let data = null, state = '', pending = false, results = null, queryValue = '', exclusionDraft = null;
  const contextKey = () => { const c = getContext(); return JSON.stringify([c?.project?.metricsId, c?.sessionId, c?.unavailable, c?.readOnly]); };
  const canEdit = () => !getContext()?.readOnly && !pending;
  function button(label, action, run, cls = 'secondary-button') {
    const el = node('button', cls, t(label));
    el.type = 'button'; el.dataset.action = action; el.onclick = run;
    return el;
  }
  function section(title) {
    const el = node('section', 'context-pane-section');
    el.append(node('h3', '', t(title))); root.append(el); return el;
  }
  function render() {
    const focused = root.contains(document.activeElement) ? document.activeElement.dataset.control || document.activeElement.dataset.action : null;
    const selection = document.activeElement?.selectionStart;
    root.replaceChildren();
    const head = node('div', 'context-heading');
    const titles = node('div'); titles.append(node('h2', '', t('docking.context')), node('p', 'context-note', getContext()?.project?.name || t('context.subtitle')));
    head.append(titles, button('context.refresh', 'refresh', () => void refresh())); root.append(head);
    const status = node('p', 'context-status', state ? t(`context.${state}`) : '');
    status.setAttribute('role', 'status'); status.dataset.state = state; status.hidden = !state;
    root.append(status); root.setAttribute('aria-busy', String(pending || state === 'loading'));
    if (!data) return;
    const controls = node('div', 'context-switches');
    for (const name of ['enabled', 'sessionEnabled', 'includeGenerated']) {
      const label = node('label'), input = node('input'); input.type = 'checkbox'; input.dataset.control = name;
      input.checked = name === 'includeGenerated' ? data[name] === true : data[name] !== false; input.disabled = !canEdit() || (name === 'sessionEnabled' && (!getContext()?.sessionId || !data.enabled));
      input.onchange = () => void mutate({ [name]: input.checked });
      label.append(input, node('span', '', t(`context.${name}`))); controls.append(label);
    }
    root.append(controls);
    const index = section('context.index'), row = node('div', 'context-index-heading');
    const indexState = data.enabled === false ? 'disabled' : data.index?.state === 'ready' && data.index.files === 0 ? 'empty' : data.index?.state || 'idle';
    const known = ['ready', 'idle', 'empty', 'indexing', 'disabled', 'error', 'loading'].includes(indexState) ? indexState : 'indexing';
    const badge = node('span', 'context-status', t(`context.${known}`)); badge.dataset.state = known;
    const rebuild = button('context.rebuild', 'rebuild', () => void mutate(null, '/rebuild'));
    rebuild.disabled = !canEdit() || data.enabled === false || indexState === 'indexing'; row.append(badge, rebuild); index.append(row);
    const stats = node('dl', 'context-stats');
    for (const name of ['files', 'symbols', 'chunks']) {
      const item = node('div'); item.append(node('dt', '', t(`context.${name}`)), node('dd', '', new Intl.NumberFormat(getLanguage()).format(data.index?.[name] || 0))); stats.append(item);
    }
    index.append(stats);
    if (data.index?.progress) {
      const p = data.index.progress, progress = node('progress'); progress.max = p.total || 1; progress.value = p.completed || 0;
      progress.setAttribute('aria-label', t('context.indexing')); index.append(progress, node('p', 'context-note', `${p.completed || 0} / ${p.total || 0}`));
    }
    if (data.index?.updatedAt) index.append(node('p', 'context-note', `${t('context.updated')} · ${new Date(data.index.updatedAt).toLocaleString(getLanguage())}`));
    if (data.index?.error) index.append(node('p', 'context-error', String(data.index.error)));
    const dossier = section('context.dossier');
    dossier.append(node('p', 'context-note', t('context.dossierNote')));
    if (data.dossier?.text) {
      if (data.dossier.createdAt) dossier.append(node('p', 'context-note', new Date(data.dossier.createdAt).toLocaleString(getLanguage())));
      dossier.append(node('pre', 'context-dossier', data.dossier.text));
    } else dossier.append(node('p', 'context-empty', t(getContext()?.sessionId ? 'context.noDossier' : 'context.noSession')));
    const pins = section('context.pins');
    if (!data.pins?.length) pins.append(node('p', 'context-empty', t('context.noPins')));
    for (const pin of data.pins || []) {
      const row = node('div', 'context-source');
      row.append(node('code', '', `${pin.path}${pin.startLine ? `:${pin.startLine}${pin.endLine ? `–${pin.endLine}` : ''}` : ''}`));
      const remove = button('context.remove', 'remove-pin', () => void mutate({ pins: data.pins.filter((p) => p !== pin) }), 'text-button');
      remove.disabled = !canEdit(); row.append(remove); pins.append(row);
    }
    const search = section('context.search'), form = node('form', 'context-search');
    const input = node('input'); input.type = 'search'; input.dataset.control = 'query'; input.placeholder = t('context.query'); input.setAttribute('aria-label', t('context.query')); input.value = queryValue; input.oninput = () => { queryValue = input.value; };
    const submit = button('context.search', 'search', () => {}); submit.type = 'submit'; submit.disabled = pending;
    form.onsubmit = (event) => { event.preventDefault(); void searchSources(); }; form.append(input, submit); search.append(form);
    if (results && !results.length) search.append(node('p', 'context-empty', t('context.noResults')));
    for (const result of results || []) {
      const row = node('div', 'context-result'), top = node('div', 'context-source');
      top.append(node('code', '', `${result.path}:${result.startLine || 1}${result.endLine ? `–${result.endLine}` : ''}`));
      const pin = { path: result.path, ...(result.startLine ? { startLine: result.startLine } : {}), ...(result.endLine ? { endLine: result.endLine } : {}) };
      const pinned = (data.pins || []).some((p) => p.path === pin.path && p.startLine === pin.startLine && p.endLine === pin.endLine);
      const add = button(pinned ? 'context.pinned' : 'context.pin', 'pin-result', () => void mutate({ pins: [...(data.pins || []), pin] }), 'text-button'); add.disabled = !canEdit() || pinned;
      top.append(add); row.append(top, node('pre', '', result.text || '')); search.append(row);
    }
    const exclusions = section('context.exclusions');
    const field = node('textarea'); field.rows = 3; field.dataset.control = 'exclusions'; field.setAttribute('aria-label', t('context.exclusions')); field.value = exclusionDraft ?? (data.exclusions || []).join('\n'); field.disabled = !canEdit(); field.oninput = () => { exclusionDraft = field.value; };
    const save = button('context.save', 'save-exclusions', () => void mutate({ exclusions: field.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) })); save.disabled = !canEdit();
    exclusions.append(node('p', 'context-note', t('context.exclusionsNote')), field, save);
    const automatic = node('details', 'context-automatic-exclusions');
    automatic.append(node('summary', '', `${t('context.automaticExclusions')} · ${data.index?.excludedCount || 0}`));
    const reasons = new Set(['sensitive-name', 'generated', 'lockfile', 'configured', 'unsafe', 'binary', 'too-large', 'unsupported']);
    for (const item of data.index?.automaticExclusions || []) {
      const row = node('div', 'context-exclusion');
      row.append(node('code', '', item.path), node('span', 'context-note', reasons.has(item.reason) ? t(`context.exclusion.${item.reason}`) : String(item.reason)));
      automatic.append(row);
    }
    if (data.index?.exclusionsTruncated) automatic.append(node('p', 'context-note', t('context.exclusionsTruncated')));
    exclusions.append(automatic);
    if (focused) {
      const target = [...root.querySelectorAll('[data-control], [data-action]')].find((el) => el.dataset.control === focused || el.dataset.action === focused);
      target?.focus({ preventScroll: true });
      if (typeof selection === 'number' && target?.setSelectionRange && ['search', 'textarea'].includes(target.type)) target.setSelectionRange(selection, selection);
    }
  }
  function stop() { generation++; controller?.abort(); stream?.close(); stream = null; }
  async function refresh() {
    stop(); pending = false; key = contextKey(); data = null; results = null; exclusionDraft = null;
    const c = getContext(), token = generation;
    if (!visible) return;
    if (!c?.project?.metricsId || c.unavailable) { state = 'unavailable'; render(); return; }
    state = 'loading'; render(); controller = new AbortController();
    const url = `${endpoint(c)}?${new URLSearchParams({ sessionId: c.sessionId || '' })}`;
    try {
      const snapshot = await api(url, { signal: controller.signal });
      if (token !== generation) return;
      data = snapshot;
      state = ''; render();
      stream = new EventSource(`${endpoint(c)}/events?${new URLSearchParams({ sessionId: c.sessionId || '' })}`);
      stream.addEventListener('context', (event) => {
        if (token !== generation) return;
        try { const snapshot = JSON.parse(event.data); if (snapshot.index) { data = snapshot; state = ''; render(); } } catch { /* Invalid events do not replace the last valid snapshot. */ }
      });
    } catch (error) { if (token !== generation || error.name === 'AbortError') return; data = null; state = 'error'; render(); }
  }
  async function mutate(body, suffix = '') {
    if (!canEdit()) return;
    const c = getContext(), token = generation; pending = true; state = ''; render();
    try {
      const result = await api(endpoint(c) + suffix, { method: suffix ? 'POST' : 'PATCH', body: { ...body, sessionId: c.sessionId || undefined } });
      if (token !== generation) return;
      const snapshot = result?.index ? result : await api(`${endpoint(c)}?${new URLSearchParams({ sessionId: c.sessionId || '' })}`);
      if (token !== generation) return;
      data = snapshot;
      if (body?.exclusions) exclusionDraft = null;
      state = 'saved';
    } catch { if (token === generation) state = 'error'; }
    finally { if (token === generation) { pending = false; render(); } }
  }
  async function searchSources() {
    if (!queryValue.trim() || pending) return;
    const token = generation; pending = true; state = 'searching'; render();
    try {
      const value = await api(endpoint(getContext()) + '/search', { method: 'POST', body: { q: queryValue.trim(), limit: 12 } });
      if (token === generation) { results = value.results || []; state = ''; }
    } catch { if (token === generation) state = 'error'; }
    finally { if (token === generation) { pending = false; render(); } }
  }
  const unsubscribe = onLanguageChange(render);
  return {
    root,
    update() { if (visible && key !== contextKey()) { pending = false; void refresh(); } },
    setDocked(next) {
      const was = visible; visible = next?.visible === true; root.hidden = !visible;
      if (!visible) { stop(); pending = false; }
      else if (!was || key !== contextKey()) void refresh();
    },
    destroy() { stop(); unsubscribe(); root.remove(); },
  };
}
