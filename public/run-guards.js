import { t, bindText, getLanguage } from './i18n.js';

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

export function renderRunGuard(parent, run, { disabled = false, onRetry = () => {} } = {}) {
  if (!parent) return;
  let root = parent.querySelector(':scope > .run-guards');
  if (!root) { root = document.createElement('div'); root.className = 'run-guards'; parent.prepend(root); }
  const signature = JSON.stringify([run?.id, run?.status, run?.quota, run?.budget, disabled]);
  if (root.dataset.signature === signature) return;
  root.dataset.signature = signature; root.replaceChildren();
  if (!run) return;
  const budget = document.createElement('aside'); budget.setAttribute('role', 'status');
  renderBudgetStatus(budget, run.budget); root.append(budget);
  if (run.status !== 'failed' || !run.quota || run.quota.retryRunId) return;
  const quota = document.createElement('aside'); quota.className = 'run-guard'; quota.dataset.kind = 'quota';
  const title = document.createElement('h4'); bindText(title, () => t('routing.quota'));
  const reset = document.createElement('p');
  bindText(reset, () => run.quota.resetAt && Number.isFinite(Date.parse(run.quota.resetAt))
    ? t('routing.reset', { time: new Intl.DateTimeFormat(getLanguage(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(run.quota.resetAt)) })
    : t('routing.resetUnknown'));
  const actions = document.createElement('div'); actions.className = 'run-guard-actions';
  for (const candidate of run.quota.candidates || []) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary-button';
    button.dataset.retryModel = candidate.model; button.disabled = disabled || candidate.reason === 'unavailable';
    bindText(button, () => t('routing.retry', { model: candidate.model }));
    button.onclick = () => onRetry(run, candidate.model);
    actions.append(button);
  }
  quota.append(title, reset, actions); root.append(quota);
}

// Native dialog and existing Studio modal styles; values never enter HTML.
export function confirmQuotaBilling(source, target) {
  const opener = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.className = 'modal compact'; dialog.dataset.quotaConfirm = '';
  dialog.setAttribute('aria-labelledby', 'quota-billing-title');
  dialog.setAttribute('aria-describedby', 'quota-billing-note');
  const title = document.createElement('h2'); title.id = 'quota-billing-title';
  bindText(title, () => t('routing.billingTitle'));
  const models = document.createElement('p');
  models.style.overflowWrap = 'anywhere';
  bindText(models, () => t('routing.billingModels', { source: source || t('routing.currentModel'), target }));
  const note = document.createElement('p'); note.id = 'quota-billing-note';
  bindText(note, () => t('routing.billingNote'));
  const actions = document.createElement('div'); actions.className = 'modal-actions';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'secondary-button'; cancel.autofocus = true;
  bindText(cancel, () => t('ui.annuler')); cancel.onclick = () => dialog.close('cancel');
  const confirm = document.createElement('button'); confirm.type = 'button'; confirm.className = 'primary-button'; confirm.dataset.quotaConfirmAccept = '';
  bindText(confirm, () => t('routing.billingConfirm')); confirm.onclick = () => dialog.close('confirm');
  actions.append(cancel, confirm); dialog.append(title, models, note, actions); document.body.append(dialog);
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      const accepted = dialog.returnValue === 'confirm'; dialog.remove();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
      resolve(accepted);
    }, { once: true });
    dialog.showModal();
  });
}
