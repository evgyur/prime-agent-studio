import { t, bindText, getLanguage, onLanguageChange } from './i18n.js';
import { renderBudgetStatus } from './run-guards.js';

const node = (tag, className = '', text = '') => {
  const value = document.createElement(tag);
  value.className = className;
  value.textContent = text;
  return value;
};
export const successRate = (row) => row.completedRuns + row.failedRuns ? row.completedRuns / (row.completedRuns + row.failedRuns) : null;
// The ledger only accepts completed, failed and stopped terminal statuses.
export const stoppedRuns = (row) => Math.max(0, row.finishedRuns - row.completedRuns - row.failedRuns);
const totalTokens = (row) => Object.values(row.tokens).reduce((sum, n) => sum + n, 0);
const hasMeasurements = (totals) => Object.values(totals).some((value) =>
  typeof value === 'number' ? value > 0 : value && typeof value === 'object' && hasMeasurements(value));

// No timer-driven reads. Dock visibility, project changes and run completions
// are explicit inputs. A generation prevents late replies crossing projects.
export function createPerformance({ api, getContext }) {
  const root = node('section', 'performance-panel');
  root.hidden = true;
  const heading = node('h2'), subtitle = node('p', 'performance-subtitle');
  bindText(heading, () => t('docking.performance'));
  const toolbar = node('div', 'performance-toolbar');
  function select(key, options) {
    const label = node('label'), title = node('span'), field = node('select');
    field.dataset.control = key;
    bindText(title, () => t(`performance.${key}`));
    for (const [value, message, params] of options) {
      const option = node('option');
      option.value = value;
      bindText(option, () => t(message, params));
      field.append(option);
    }
    label.append(title, field);
    toolbar.append(label);
    return field;
  }
  const scope = select('scope', [['project', 'performance.project'], ['all', 'performance.all']]);
  const period = select('period', [['1', 'performance.today'], ...[7, 30, 90].map((n) => [String(n), 'performance.days', { count: n }])]);
  period.value = '7';
  const refreshButton = node('button', 'secondary-button');
  refreshButton.type = 'button';
  refreshButton.dataset.action = 'refresh';
  bindText(refreshButton, () => t('performance.refresh'));
  toolbar.append(refreshButton);
  const status = node('p', 'performance-status');
  status.setAttribute('role', 'status');
  const retry = node('button', 'text-button');
  retry.type = 'button';
  bindText(retry, () => t('performance.retry'));
  retry.hidden = true;
  const body = node('div', 'performance-body');
  const budgetStatus = node('aside');
  budgetStatus.setAttribute('role', 'status');
  budgetStatus.hidden = true;
  root.append(heading, subtitle, toolbar, budgetStatus, status, retry, body);
  let visible = false, key = '', generation = 0, controller = null, timer = null;
  let data = null, state = '', sort = 'cost', chart = 'cost';
  let budgetSnapshot = null;
  const number = (n) => new Intl.NumberFormat(getLanguage(), { maximumFractionDigits: 1 }).format(n);
  const money = (row) => row.costKnown ? new Intl.NumberFormat(getLanguage(), {
    style: 'currency', currency: 'USD', maximumFractionDigits: 4,
  }).format(row.cost) : t('metrics.unknown');
  const percent = (n) => n === null ? t('performance.na') : new Intl.NumberFormat(getLanguage(), {
    style: 'percent', maximumFractionDigits: 1,
  }).format(n);
  const duration = (value) => value?.medianMs == null ? t('performance.na') :
    `${number(value.medianMs < 1000 ? value.medianMs : value.medianMs / 1000)} ${value.medianMs < 1000 ? 'ms' : 's'}`;
  const statusText = () => {
    status.textContent = t(`performance.${state}`);
    status.dataset.state = state;
    retry.hidden = !['error', 'incomplete', 'backfilling', 'truncated'].includes(state);
    root.setAttribute('aria-busy', String(state === 'loading'));
  };
  function render() {
    renderBudgetStatus(budgetStatus, getContext()?.run?.budget || budgetSnapshot);
    subtitle.textContent = scope.value === 'all' ? t('performance.all') : getContext()?.project?.name || t('performance.project');
    statusText();
    body.replaceChildren();
    if (!data) return;
    const totals = data.day.totals;
    if (!hasMeasurements(totals)) return;
    const kpis = node('dl', 'performance-kpis');
    function kpi(label, value, hint = '') {
      const item = node('div');
      item.append(node('dt', '', t(label)), node('dd', '', value));
      if (hint) {
        const detail = node('small');
        detail.append(...(Array.isArray(hint) ? hint : [hint]));
        item.append(detail);
      }
      kpis.append(item);
    }
    kpi('performance.cost', money(totals), totals.unknownCostMessages ? t('performance.unknownCost', { count: totals.unknownCostMessages }) : '');
    kpi('performance.tokens', number(totalTokens(totals)), [
      ['metrics.input', totals.tokens.input], ['ui.tokens_sortants', totals.tokens.output],
      ['metrics.cacheRead', totals.tokens.cacheRead], ['metrics.cacheWrite', totals.tokens.cacheWrite],
    ].map(([label, amount]) => `${t(label)} ${number(amount)}`).join(' · '));
    kpi('metrics.cacheRate', percent(totals.cacheHitRatio));
    kpi('performance.runs', number(totals.runs), [
      node('span', 'performance-run-status', `${t('performance.completed')} ${number(totals.completedRuns)}`), ' · ',
      node('span', 'performance-run-status', `${t('performance.failed')} ${number(totals.failedRuns)}`), ' · ',
      node('span', 'performance-run-status', `${t('performance.stopped')} ${number(stoppedRuns(totals))}`),
    ]);
    kpi('performance.duration', duration(totals.duration));
    kpi('performance.ttft', duration(totals.timeToFirstToken));
    body.append(kpis);
    const chartHead = node('div', 'performance-section-head');
    chartHead.append(node('h3', '', t('performance.daily')));
    const chartSelect = node('select');
    chartSelect.dataset.control = 'chart';
    chartSelect.setAttribute('aria-label', t('performance.chart'));
    for (const value of ['cost', 'tokens']) {
      const option = node('option', '', t(`performance.${value}`));
      option.value = value;
      chartSelect.append(option);
    }
    chartSelect.value = chart;
    chartSelect.onchange = () => { chart = chartSelect.value; render(); body.querySelector('[data-control="chart"]').focus({ preventScroll: true }); };
    chartHead.append(chartSelect);
    body.append(chartHead);
    if (!data.day.groups.length) {
      body.append(node('p', 'performance-note performance-chart-note', t('performance.noDaily')));
    } else {
      const days = new Map(data.day.groups.map((row) => [row.key, row]));
      const bars = [];
      for (let at = Date.parse(data.day.from); at <= Date.parse(data.day.to); at += 86400000) {
        const date = new Date(at).toISOString().slice(0, 10), row = days.get(date);
        bars.push({ date, row, value: row ? chart === 'cost' ? row.cost : totalTokens(row) : 0 });
      }
      const max = Math.max(0, ...bars.map((bar) => bar.value));
      const graph = node('div', 'performance-chart');
      graph.setAttribute('role', 'img');
      graph.setAttribute('aria-label', `${t('performance.daily')} · ${t(`performance.${chart}`)} · ${data.day.from} / ${data.day.to}`);
      for (const bar of bars) {
        const column = node('span', 'performance-bar');
        column.style.height = `${Math.max(1, bar.value / (max || 1) * 100)}%`;
        column.title = `${bar.date}: ${chart === 'cost' && bar.row ? money(bar.row) : number(bar.value)}`;
        graph.append(column);
      }
      const axis = node('div', 'performance-axis');
      axis.append(node('span', '', data.day.from), node('span', '', data.day.to));
      const scale = node('div', 'performance-scale');
      // Same currency notation as the cost figures (e.g. $US in French, $ in English).
      const maximum = chart === 'cost' ? money({ costKnown: true, cost: max }) : `${number(max)} ${t('performance.tokens').toLowerCase()}`;
      scale.append(node('span', 'performance-maximum', maximum), node('span', 'performance-zero', number(0)));
      const plot = node('div', 'performance-plot');
      plot.append(scale, graph);
      body.append(plot, axis);
    }
    const modelHead = node('div', 'performance-section-head');
    modelHead.append(node('h3', '', t('performance.models')));
    const sortLabel = node('label', '', t('performance.sort'));
    const sortSelect = node('select');
    sortSelect.dataset.control = 'sort';
    for (const value of ['cost', 'runs']) {
      const option = node('option', '', t(`performance.${value}`));
      option.value = value;
      sortSelect.append(option);
    }
    sortSelect.value = sort;
    sortSelect.onchange = () => { sort = sortSelect.value; render(); body.querySelector('[data-control="sort"]').focus({ preventScroll: true }); };
    sortLabel.append(sortSelect);
    modelHead.append(sortLabel);
    body.append(modelHead, table(data.model.groups, false));
    if (data.project) body.append(node('h3', '', t('performance.projects')), table(data.project.groups, true));
    body.append(node('p', 'performance-note', t('metrics.costNote')), node('p', 'performance-note', t('performance.retention')));
  }
  function table(rows, projects) {
    const table = node('table', 'performance-table');
    table.dataset.group = projects ? 'project' : 'model';
    const labels = ['performance.' + (projects ? 'name' : 'model'), 'performance.runs', 'performance.success', 'performance.tokens', 'metrics.cacheRate', 'performance.cost', 'performance.perRun', 'performance.duration', 'performance.ttft', 'performance.errors'];
    const head = node('thead'), header = node('tr');
    for (const label of labels) {
      const cell = node('th', '', t(label));
      cell.scope = 'col';
      header.append(cell);
    }
    head.append(header);
    const tbody = node('tbody');
    for (const row of [...rows].sort((a, b) => b[sort] - a[sort] || a.key.localeCompare(b.key))) {
      const tr = node('tr');
      const values = [projects ? row.name : row.key, number(row.runs), percent(successRate(row)), number(totalTokens(row)), percent(row.cacheHitRatio), money(row), row.completedRuns ? money({ ...row, cost: row.cost / row.completedRuns }) : t('performance.na'), duration(row.duration), duration(row.timeToFirstToken), `${number(row.errors['4xx'])} / ${number(row.errors['5xx'])}`];
      values.forEach((value, index) => {
        const cell = node(index ? 'td' : 'th', '', value);
        if (!index) cell.scope = 'row';
        cell.dataset.label = t(labels[index]);
        if (index === 2) cell.title = `${t('performance.successNote')} · ${t('performance.stopped')}: ${number(stoppedRuns(row))}`;
        tr.append(cell);
      });
      tbody.append(tr);
    }
    table.append(head, tbody);
    return table;
  }
  function contextKey() {
    const context = getContext();
    return JSON.stringify([scope.value, period.value, scope.value === 'all' ? '' : context?.project?.metricsId, scope.value === 'project' && context?.unavailable]);
  }
  async function refresh() {
    if (!visible || document.hidden) return;
    clearTimeout(timer);
    controller?.abort();
    const token = ++generation;
    controller = new AbortController();
    key = contextKey();
    data = null;
    const context = getContext();
    if (scope.value === 'project' && (!context?.project?.metricsId || context.unavailable)) {
      state = 'unavailable'; render(); return;
    }
    state = 'loading'; render();
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.parse(to) - (Number(period.value) - 1) * 86400000).toISOString().slice(0, 10);
    const query = new URLSearchParams({ from, to });
    if (scope.value === 'project') query.set('project', context.project.metricsId);
    try {
      // One snapshot per refresh, never a second budget polling loop.
      const active = await api('/api/runs', { signal: controller.signal }).catch(() => ({ runs: [] }));
      if (token !== generation || !visible) return;
      const candidates = (active.runs || []).filter((run) => scope.value === 'all' || run.cwd === (context.cwd || context.project?.cwd));
      budgetSnapshot = candidates.find((run) => ['paused', 'stopped'].includes(run.budget?.status))?.budget
        || candidates.find((run) => run.budget?.status === 'warning')?.budget || null;
      const groups = scope.value === 'all' ? ['day', 'model', 'project'] : ['day', 'model'];
      const values = await Promise.all(groups.map((groupBy) => api(`/api/metrics/summary?${query}&groupBy=${groupBy}`, { signal: controller.signal })));
      if (token !== generation || !visible) return;
      data = Object.fromEntries(groups.map((group, i) => [group, values[i]]));
      state = values.some((v) => v.backfilling) ? 'backfilling' : values.some((v) => v.truncated) ? 'truncated' : values.some((v) => !v.complete) ? 'incomplete' : !hasMeasurements(data.day.totals) ? 'empty' : 'ready';
      render();
    } catch (error) {
      if (token !== generation || error.name === 'AbortError') return;
      state = 'error'; render();
    }
  }
  function update() {
    if (visible) renderBudgetStatus(budgetStatus, getContext()?.run?.budget || budgetSnapshot);
    if (visible && key !== contextKey()) { budgetSnapshot = null; void refresh(); }
  }
  const onBudget = (event) => {
    const context = getContext();
    if (visible && (scope.value === 'all' || event.detail.run.cwd === (context?.cwd || context?.project?.cwd))) {
      budgetSnapshot = event.detail.run.budget;
      renderBudgetStatus(budgetStatus, budgetSnapshot);
    }
  };
  document.addEventListener('studio-budget-update', onBudget);
  scope.onchange = period.onchange = refreshButton.onclick = retry.onclick = () => void refresh();
  const stopLanguage = onLanguageChange(render);
  const onVisible = () => { if (visible && !document.hidden) void refresh(); };
  document.addEventListener('visibilitychange', onVisible);
  return {
    root, update,
    setDocked(next) {
      const wasVisible = visible;
      visible = next?.visible === true;
      root.hidden = !visible;
      if (!visible) { generation++; controller?.abort(); clearTimeout(timer); }
      else if (!wasVisible) void refresh();
      else update();
    },
    runDone() {
      if (!visible || document.hidden) return;
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 1100);
    },
    destroy() {
      generation++; controller?.abort(); clearTimeout(timer);
      stopLanguage(); document.removeEventListener('visibilitychange', onVisible);
      document.removeEventListener('studio-budget-update', onBudget); root.remove();
    },
  };
}
