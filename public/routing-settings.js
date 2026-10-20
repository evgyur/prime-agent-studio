import { t, bindText, bindAttribute, onLanguageChange, translateKnown } from './i18n.js';

export function createRoutingSettings({ api, root, getContext = () => ({}), getModels = () => [], openModelPicker }) {
  root.classList.add('routing-settings');
  root.innerHTML = `
    <form data-routing-form="fallback" class="routing-section">
      <div class="model-defaults-heading"><h3 data-i18n="routing.fallback"></h3><button class="primary-button" type="submit" data-i18n="ui.enregistrer"></button></div>
      <p class="model-defaults-note" data-i18n="routing.fallbackNote"></p>
      <ol class="routing-fallback-list"></ol>
      <button type="button" class="inspector-refresh" data-fallback-add data-i18n="routing.add"></button>
      <label class="routing-toggle"><input type="checkbox" data-fallback-automatic><span data-i18n="routing.automatic"></span></label>
      <p class="model-defaults-note" data-i18n="routing.guard"></p>
      <p class="routing-result" role="status"></p>
    </form>
    <form data-routing-form="budgets" class="routing-section">
      <div class="model-defaults-heading"><h3 data-i18n="routing.runBudget"></h3><button class="primary-button" type="submit" data-i18n="ui.enregistrer"></button></div>
      <div class="routing-budget-grid" data-budget-group="run"></div>
      <h4 data-i18n="routing.projectBudget"></h4><p class="routing-project model-defaults-note"></p>
      <div class="routing-budget-grid" data-budget-group="project"></div>
      <p class="model-defaults-note" data-i18n="routing.budgetNote"></p>
      <p class="routing-result" role="status"></p>
    </form>`;
  const $ = (s) => root.querySelector(s);
  const forms = Object.fromEntries(['fallback', 'budgets'].map((name) => [name, $(`[data-routing-form="${name}"]`)]));
  let fallback = null, budgets = null, draft = [], busy = new Set(), generation = 0, cwd = '';
  const locked = () => !!getContext().readOnly || getContext().online === false;
  for (const scope of ['run', 'project']) for (const field of ['tokens', 'estimatedCost']) {
    const label = document.createElement('label');
    const text = document.createElement('span');
    bindText(text, () => t(field === 'tokens' ? 'routing.tokens' : 'routing.usd'));
    const input = document.createElement('input');
    input.type = 'number'; input.min = field === 'tokens' ? '1' : '0.000001';
    input.step = field === 'tokens' ? '1' : 'any';
    input.inputMode = field === 'tokens' ? 'numeric' : 'decimal';
    input.dataset.budgetScope = scope; input.dataset.budgetField = field;
    bindAttribute(input, 'placeholder', () => t('routing.off'));
    label.append(text, input); $(`[data-budget-group="${scope}"]`).append(label);
  }
  function translate() {
    for (const node of root.querySelectorAll('[data-i18n]')) bindText(node, () => t(node.dataset.i18n));
    renderList();
  }
  function controls() {
    for (const [name, form] of Object.entries(forms)) {
      for (const input of form.querySelectorAll('button,input')) {
        input.disabled = locked() || busy.has(name) || !(name === 'fallback' ? fallback : budgets)
          || (input.dataset.budgetScope === 'project' && !cwd)
          || input.dataset.edge === 'true';
      }
    }
  }
  function result(name, message = '', error = false) {
    const node = forms[name].querySelector('.routing-result');
    node.classList.toggle('form-error', error);
    bindText(node, () => typeof message === 'function' ? message() : translateKnown(message));
  }
  function renderList() {
    const list = $('.routing-fallback-list'); list.replaceChildren();
    if (!draft.length) {
      const empty = document.createElement('li'); empty.className = 'routing-empty';
      bindText(empty, () => t('routing.empty')); list.append(empty);
    }
    draft.forEach((id, index) => {
      const row = document.createElement('li'); row.dataset.model = id;
      const text = document.createElement('span'); text.className = 'routing-model-name';
      const model = getModels().find((value) => value.id === id);
      text.textContent = model?.name || id; text.title = id;
      const provider = document.createElement('small'); provider.textContent = id;
      text.append(provider); row.append(text);
      for (const action of ['up', 'down', 'remove']) {
        const button = document.createElement('button'); button.type = 'button';
        button.className = 'inspector-refresh'; button.dataset.fallbackAction = action;
        bindText(button, () => t(`routing.${action}`));
        bindAttribute(button, 'aria-label', () => `${t(`routing.${action}`)} · ${id}`);
        button.dataset.edge = String(action === 'up' && index === 0 || action === 'down' && index === draft.length - 1);
        button.onclick = () => {
          if (locked() || busy.has('fallback')) return;
          if (action === 'remove') draft.splice(index, 1);
          else { const next = index + (action === 'up' ? -1 : 1); [draft[index], draft[next]] = [draft[next], draft[index]]; }
          renderList();
        };
        row.append(button);
      }
      list.append(row);
    });
    controls();
  }
  $('[data-fallback-add]').onclick = () => {
    if (locked() || busy.has('fallback') || !fallback) return;
    const turn = generation;
    openModelPicker({ button: $('[data-fallback-add]'), value: '', title: t('routing.add'), onSelect(id) {
      if (turn !== generation || locked() || busy.has('fallback') || !id || draft.includes(id)) return;
      draft.push(id); renderList();
    } });
  };
  function projectKey() {
    if (!/^[a-z]:[\\/]/i.test(cwd)) return cwd;
    const normalized = cwd.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '');
    return Object.keys(budgets?.projects || {}).find((key) => key.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '') === normalized) || cwd;
  }
  function fillBudgets() {
    for (const input of forms.budgets.querySelectorAll('input')) {
      const caps = input.dataset.budgetScope === 'run' ? budgets?.run : budgets?.projects?.[projectKey()];
      input.value = caps?.[input.dataset.budgetField] ?? '';
    }
    bindText($('.routing-project'), () => cwd || t('routing.noProject'));
    $('.routing-project').title = cwd;
  }
  async function open() {
    const turn = ++generation;
    cwd = getContext().cwd || getContext().projectCwd || '';
    busy = new Set(['fallback', 'budgets']); controls();
    await Promise.all(Object.keys(forms).map(async (name) => {
      result(name, () => t('routing.loading'));
      try {
        const value = await api(name === 'fallback' ? '/api/quota-fallback' : '/api/budgets');
        if (turn !== generation) return;
        if (name === 'fallback') { fallback = value; draft = [...value.models]; $('[data-fallback-automatic]').checked = value.automatic; renderList(); }
        else { budgets = value; fillBudgets(); }
        result(name);
      } catch (error) { if (turn === generation) { if (name === 'fallback') fallback = null; else budgets = null; result(name, error.message, true); } }
      finally { if (turn === generation) { busy.delete(name); controls(); } }
    }));
  }
  for (const [name, form] of Object.entries(forms)) form.onsubmit = async (event) => {
    event.preventDefault();
    if (locked() || busy.has(name) || !form.reportValidity() || !(name === 'fallback' ? fallback : budgets)) return;
    const turn = generation;
    let body;
    if (name === 'fallback') body = { revision: fallback.revision, models: [...draft], automatic: $('[data-fallback-automatic]').checked };
    else {
      const caps = (scope) => Object.fromEntries([...form.querySelectorAll(`[data-budget-scope="${scope}"]`)].map((input) => [input.dataset.budgetField, input.value === '' ? null : Number(input.value)]));
      body = { revision: budgets.revision, period: 'day', run: caps('run'), projects: { ...budgets.projects, ...(cwd ? { [projectKey()]: caps('project') } : {}) } };
    }
    busy.add(name); controls(); result(name, () => t('common.saving'));
    try {
      const value = await api(name === 'fallback' ? '/api/quota-fallback' : '/api/budgets', { method: 'PUT', body });
      if (turn !== generation) return;
      if (name === 'fallback') fallback = value; else budgets = value;
      result(name, () => t('routing.saved'));
    } catch (error) { if (turn === generation) result(name, error.message, true); }
    finally { if (turn === generation) { busy.delete(name); controls(); } }
  };
  translate(); controls();
  const offLanguage = onLanguageChange(translate);
  return { root, open, update() {
    const next = getContext().cwd || getContext().projectCwd || '';
    if (next !== cwd) { generation++; cwd = next; busy.clear(); fillBudgets(); }
    controls();
  }, dispose() { generation++; offLanguage(); } };
}
