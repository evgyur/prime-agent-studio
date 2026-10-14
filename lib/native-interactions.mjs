import { QUESTION_MARKER, OTHER_ANSWER, validateQuestions, validateAnswers, normalizeAnswers } from '../runtime/studio-question-protocol.mjs';

// Ephemeral projection of Prime Agent's pending dialogs. The native tool call
// remains the authority; replies are confirmed before they are shown as sent.
export function createNativeInteractions({ emit, send }) {
  const requests = new Map();
  const acknowledgements = new Map();
  let toolId, toolName, toolOptions;
  function publish(request) {
    emit({ kind: 'interaction', request: { ...request, responding: undefined } });
  }
  function closeFor(id) {
    for (const request of requests.values())
      if ((!id || request.toolId === id) && request.status === 'pending' && !request.responding) {
        request.status = 'cancelled';
        publish(request);
      }
  }
  return {
    consume(event) {
      if (event.type === 'tool_execution_start') {
        toolId = event.toolCallId;
        toolName = event.toolName;
        toolOptions = toolName === 'question' ? event.args?.questions?.[0]?.options || event.args?.options : undefined;
      }
      if (event.type === 'tool_execution_end') {
        closeFor(event.toolCallId);
        if (toolId === event.toolCallId) {
          toolId = undefined;
          toolName = undefined;
          toolOptions = undefined;
        }
      }
      if (
        event.type === 'extension_ui_request' &&
        ['select', 'input', 'confirm', 'editor'].includes(event.method)
      ) {
        let questions;
        const batch = event.method === 'input' && event.placeholder?.startsWith(QUESTION_MARKER);
        // Runs inside the engine stdout handler: a malformed batch must never
        // throw here. It degrades to a plain text request, which the tool rejects.
        if (batch) try {
          questions = validateQuestions(JSON.parse(event.placeholder.slice(QUESTION_MARKER.length)).questions)
            .map((item, index) => ({
              id: `q${index + 1}`, question: item.question,
              options: item.options.map((option, optionIndex) => ({
                id: `o${optionIndex + 1}`, label: option.label, description: option.description,
              })),
            }));
        } catch {
          questions = undefined;
        }
        const request = {
          id: event.id,
          method: event.method,
          title: questions ? `Questions (${questions.length})` : event.title,
          options: event.options,
          // Keep the native select values unchanged; descriptions are display metadata.
          optionDetails: event.options?.map((value, index) => {
            const option = Array.isArray(toolOptions) ? toolOptions[index] : undefined;
            if (option && typeof option.label === 'string') {
              const description = typeof option.description === 'string' ? option.description : '';
              const expected = `${index + 1}. ${option.label}${description ? ` — ${description}` : ''}`;
              if (value === expected) return { label: option.label, description };
            }
            // Tool-start snapshots can lag behind blocking UI requests.
            const match = typeof value === 'string' && value.match(/^\d+\. (.+)$/s);
            if (!match) return null;
            const separator = match[1].indexOf(' — ');
            return separator < 0 ? { label: match[1], description: '' } : {
              label: match[1].slice(0, separator), description: match[1].slice(separator + 3),
            };
          }),
          message: event.message,
          placeholder: batch ? 'Votre réponse / Your answer' : event.placeholder,
          prefill: event.prefill,
          toolId,
          status: 'pending',
          createdAt: Date.now(),
          timeout: event.timeout,
        };
        request.allowCustom = !!questions || toolName === 'question' ||
          (event.method === 'select' && event.options?.at(-1) === OTHER_ANSWER);
        if (questions) Object.assign(request, { kind: 'questions', questions });
        requests.set(request.id, request);
        publish(request);
        return true;
      }
      if (event.type === 'response' && event.command === 'extension_ui_response') {
        const pending = acknowledgements.get(event.id);
        if (pending) {
          acknowledgements.delete(event.id);
          event.success
            ? pending.resolve()
            : pending.reject(new Error('La demande a expiré ou a déjà reçu une réponse.'));
        }
        return true;
      }
      return false;
    },
    async respond(id, response) {
      const request = requests.get(id);
      if (!request || request.status !== 'pending' || request.responding)
        throw new Error('Cette demande n’attend plus de réponse.');
      if (!response || typeof response !== 'object' || Array.isArray(response))
        throw new Error('Réponse invalide.');
      let value, answers;
      if (request.kind === 'questions') {
        if (Object.keys(response).length !== 1) throw new Error('Réponse invalide.');
        if (response.cancelled === true) {
          value = { cancelled: true };
          answers = normalizeAnswers(request.questions, request.questions.map(() => ({ skipped: true })));
        } else {
          let values;
          try {
            values = validateAnswers(
              Array.isArray(response.values) ? response.values :
                typeof response.value === 'string' ? JSON.parse(response.value) : null,
              request.questions,
            );
          } catch {
            throw new Error('Réponse invalide.');
          }
          value = { value: JSON.stringify(values) };
          answers = normalizeAnswers(request.questions, values);
        }
      } else if ('values' in response) throw new Error('Réponse invalide.');
      else if (response.cancelled === true) value = { cancelled: true };
      else if (request.method === 'confirm' && typeof response.confirmed === 'boolean')
        value = { confirmed: response.confirmed };
      else if (
        ['select', 'input', 'editor'].includes(request.method) &&
        typeof response.value === 'string' &&
        response.value.trim() &&
        response.value.length <= 10000
      ) {
        if (request.method === 'select' && !request.allowCustom && !request.options?.includes(response.value))
          throw new Error('Choix invalide.');
        value = { value: response.value };
      } else throw new Error('Réponse invalide.');
      request.responding = true;
      let timer;
      try {
        await new Promise((resolve, reject) => {
          acknowledgements.set(id, { resolve, reject });
          timer = setTimeout(() => reject(new Error('Le moteur n’a pas confirmé la réponse.')), 10000);
          send({ type: 'extension_ui_response', id, ...value });
        });
        request.status = value.cancelled ? 'cancelled' : 'answered';
        if (answers) request.answers = answers;
        else request.answer = value.value ?? value.confirmed;
      } catch (error) {
        // Never let an uncertain reply be retried as a second answer.
        request.status = 'interrupted';
        throw error;
      } finally {
        clearTimeout(timer);
        acknowledgements.delete(id);
        request.responding = false;
        publish(request);
      }
      return { ...request };
    },
    close() {
      for (const pending of acknowledgements.values())
        pending.reject(new Error('La session a été interrompue.'));
      acknowledgements.clear();
      closeFor();
    },
  };
}
