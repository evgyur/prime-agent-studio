import { t, bindText, getLanguage } from './i18n.js';

// Read-only run guards. Quota and budget management was removed: no retry
// actions, no caps editing. Stored runs and transcripts may still carry
// quota or budget data, which keeps rendering here generically without
// errors.
export function renderBudgetStatus(root, budget) {
  root.replaceChildren();
  root.className = 'run-guard'; root.dataset.kind = 'budget';
  root.hidden = !budget || !['warning', 'paused', 'stopped'].includes(budget.status);
  if (root.hidden) return;
  const title = document.createElement('h4');
  bindText(title, () => t(budget.status === 'paused' ? 'routing.paused' : budget.status === 'stopped' ? 'routing.stopped' : 'routing.warning'));
  const usage = document.createElement('p');
  bindText(usage, () => t('routing.usage', {
    tokens: new Intl.NumberFormat(getLanguage()).format(budget.tokens || 0),
    cost: budget.costKnown && Number.isFinite(budget.estimatedCost) ? budget.estimatedCost.toFixed(4) : '—',
  }));
  root.append(title, usage);
  const caps = document.createElement('p');
  bindText(caps, () => t('routing.caps', { tokens: budget.limits?.tokens ?? t('routing.off'), cost: budget.limits?.estimatedCost ?? t('routing.off') }));
  root.append(caps);
  if (budget.project && (budget.project.limits?.tokens || budget.project.limits?.estimatedCost)) {
    const project = document.createElement('p');
    bindText(project, () => t('routing.projectUsage', {
      tokens: new Intl.NumberFormat(getLanguage()).format(budget.project.tokens || 0),
      cost: budget.project.costKnown && Number.isFinite(budget.project.estimatedCost) ? budget.project.estimatedCost.toFixed(4) : '—',
    }));
    root.append(project);
  }
  if (!budget.costKnown || budget.project?.costKnown === false) {
    const note = document.createElement('p');
    bindText(note, () => t('routing.costUnknown') + (budget.limits?.estimatedCost || budget.project?.limits?.estimatedCost ? ` ${t('routing.costStop')}` : ''));
    root.append(note);
  }
}

export function renderRunGuard(parent, run) {
  if (!parent) return;
  let root = parent.querySelector(':scope > .run-guards');
  if (!root) { root = document.createElement('div'); root.className = 'run-guards'; parent.prepend(root); }
  const signature = JSON.stringify([run?.id, run?.status, run?.quota, run?.budget]);
  if (root.dataset.signature === signature) return;
  root.dataset.signature = signature; root.replaceChildren();
  if (!run) return;
  const budget = document.createElement('aside'); budget.setAttribute('role', 'status');
  renderBudgetStatus(budget, run.budget); root.append(budget);
  if (run.status !== 'failed' || !run.quota) return;
  const quota = document.createElement('aside'); quota.className = 'run-guard'; quota.dataset.kind = 'quota';
  const title = document.createElement('h4'); bindText(title, () => t('routing.quota'));
  const reset = document.createElement('p');
  bindText(reset, () => run.quota.resetAt && Number.isFinite(Date.parse(run.quota.resetAt))
    ? t('routing.reset', { time: new Intl.DateTimeFormat(getLanguage(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(run.quota.resetAt)) })
    : t('routing.resetUnknown'));
  quota.append(title, reset); root.append(quota);
}
