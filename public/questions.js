import { t as tr, bindText, bindAttribute } from './i18n.js';

// Bridge questions have no native tool id. Keep their resolved form beside
// the assistant message that was current when the question was asked.
export function questionAnchorMessageId(run, request) {
  const messages = run?.messages;
  if (!Array.isArray(messages) || !request) return null;
  if (request.toolId) {
    const owner = messages.findLast((message) => message.tools?.some((tool) => tool.id === request.toolId));
    return owner?.id || null;
  }
  if (request.status === 'pending') return null;
  const askedAt = typeof request.createdAt === 'number' ? request.createdAt : Date.parse(request.createdAt);
  if (!Number.isFinite(askedAt)) return null;
  let anchor = null;
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.id) continue;
    const messageAt =
      typeof message.timestamp === 'number' ? message.timestamp : Date.parse(message.timestamp);
    if (Number.isFinite(messageAt) && messageAt <= askedAt) anchor = message.id;
  }
  return anchor;
}

export function createQuestions({ root, api, getContext }) {
  const nodes = new Map();
  let currentRun;
  const node = (tag, className, text) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text) el.textContent = text;
    return el;
  };
  function update() {
    const { run, readOnly, hidden } = getContext();
    root.hidden = !!hidden;
    if (currentRun !== run?.id) {
      for (const entry of nodes.values()) entry.form.remove();
      root.replaceChildren();
      nodes.clear();
      currentRun = run?.id;
    }
    for (const request of run?.interactions || []) {
      let entry = nodes.get(request.id);
      if (!entry) {
        const form = node('form', 'agent-question');
        const label = node('div', 'question-label');
        bindText(label, () => tr('questions.title'));
        const title = node('h3', '', request.title);
        title.id = `question-${request.id}`;
        form.setAttribute('aria-labelledby', title.id);
        const fields = node('fieldset', 'question-fields');
        const legend = node('legend', 'sr-only', request.title);
        fields.append(legend);
        let value = null;
        const inputs = [];
        const options =
          request.method === 'confirm' ? [tr('questions.yes'), tr('questions.no')] : request.options || [];
        options.forEach((option, index) => {
          if (request.allowCustom && option === 'Autre réponse / Other answer') return;
          const metadata = request.optionDetails?.[index];
          const choice = node('div', 'question-choice');
          const row = node('label', 'question-option');
          const radio = node('input');
          radio.type = 'radio';
          radio.name = request.id;
          radio.value = option;
          radio.onchange = () => {
            value = request.method === 'confirm' ? index === 0 : option;
            if (entry.input) entry.input.value = '';
          };
          row.append(radio, node('span', '', metadata?.label || option));
          choice.append(row);
          if (metadata?.description) {
            const details = node('details', 'question-option-details');
            const summary = node('summary');
            const descriptionLabel = () =>
              tr(details.open ? 'questions.hideDescription' : 'questions.showDescription');
            bindText(summary, descriptionLabel);
            bindAttribute(summary, 'aria-label', () => `${descriptionLabel()} : ${metadata.label}`);
            details.ontoggle = () => {
              bindText(summary, descriptionLabel);
              bindAttribute(summary, 'aria-label', () => `${descriptionLabel()} : ${metadata.label}`);
            };
            details.append(summary, node('p', '', metadata.description));
            choice.append(details);
          }
          fields.append(choice);
          inputs.push(radio);
        });
        const textAllowed = request.allowCustom || ['input', 'editor'].includes(request.method);
        const input = textAllowed ? node('textarea', 'question-input') : null;
        if (input) {
          input.rows = request.method === 'editor' ? 4 : 2;
          input.maxLength = 10000;
          input.placeholder = request.allowCustom
            ? tr('questions.other')
            : request.placeholder || tr('questions.answer');
          input.setAttribute('aria-label', input.placeholder);
          input.value = request.prefill || '';
          input.oninput = () => {
            if (input.value) {
              value = null;
              inputs.forEach((radio) => (radio.checked = false));
            }
          };
          fields.append(input);
        }
        if (request.message) fields.prepend(node('p', '', request.message));
        const actions = node('div', 'question-actions');
        const submit = node('button', 'primary-button');
        submit.type = 'submit';
        bindText(submit, () => tr('questions.send'));
        const cancel = node('button', 'question-cancel');
        cancel.type = 'button';
        bindText(cancel, () => tr('questions.skip'));
        const status = node('p', 'question-status');
        status.setAttribute('role', 'status');
        const error = node('p', 'question-error');
        error.setAttribute('role', 'alert');
        error.hidden = true;
        actions.append(submit, cancel);
        form.append(label, title, fields, actions, status, error);
        entry = { form, fields, actions, input, status, error, pending: false, statusKey: null };
        const reply = async (response) => {
          if (entry.pending || entry.statusKey !== 'pending' || getContext().readOnly) return;
          entry.pending = true;
          fields.disabled = true;
          submit.disabled = cancel.disabled = true;
          error.hidden = true;
          try {
            await api(`/api/runs/${run.id}/interactions`, {
              method: 'POST',
              body: { id: request.id, response },
            });
          } catch (cause) {
            error.textContent = cause.message;
            error.hidden = false;
          } finally {
            entry.pending = false;
            update();
          }
        };
        form.onsubmit = (event) => {
          event.preventDefault();
          const answer = input?.value.trim() || value;
          if (answer === null || answer === '') {
            error.textContent = tr('questions.required');
            error.hidden = false;
            return;
          }
          void reply(request.method === 'confirm' ? { confirmed: answer } : { value: answer });
        };
        cancel.onclick = () => void reply({ cancelled: true });
        root.append(form);
        nodes.set(request.id, entry);
      }
      const pending = request.status === 'pending' && run.status === 'running';
      entry.anchorMessageId = questionAnchorMessageId(run, request);
      entry.form.hidden = !!hidden;
      entry.statusKey = pending ? 'pending' : request.status;
      entry.form.classList.toggle('question-resolved', !pending);
      entry.fields.hidden = entry.actions.hidden = !pending;
      entry.fields.disabled = !!readOnly || entry.pending;
      entry.actions
        .querySelectorAll('button')
        .forEach((button) => (button.disabled = !!readOnly || entry.pending));
      if (pending)
        bindText(entry.status, () => (readOnly ? tr('questions.readOnly') : tr('questions.waiting')));
      else
        bindText(entry.status, () =>
          request.status === 'answered'
            ? `${tr('questions.answered')} ${typeof request.answer === 'boolean' ? tr(request.answer ? 'questions.yes' : 'questions.no') : request.answer || ''}`
            : tr('questions.closed'),
        );
      // The transcript may be windowed, with this message offscreen.
      // Remove a resolved question from the live bottom until it mounts there.
      if (!pending && entry.form.parentNode === root && entry.anchorMessageId) entry.form.remove();
    }
  }
  function partsFor(message) {
    const run = getContext().run;
    const toolIds = new Set((message.tools || []).map((tool) => tool.id));
    return (run?.interactions || [])
      .filter(
        (request) =>
          nodes.has(request.id) &&
          ((request.toolId && toolIds.has(request.toolId)) ||
            (request.status !== 'pending' && nodes.get(request.id).anchorMessageId === message.id)),
      )
      .map((request) => ({ key: `question:${request.id}`, node: nodes.get(request.id).form }));
  }
  return { update, partsFor };
}
