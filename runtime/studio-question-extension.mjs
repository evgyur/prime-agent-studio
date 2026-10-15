import { Type } from 'typebox';
import { QUESTION_MARKER, OTHER_ANSWER, validateQuestions, validateAnswers, normalizeAnswers } from './studio-question-protocol.mjs';

// Adapter of Prime Agent's question example: same tool/result concept, using
// its transportable select/input primitives instead of terminal-only ui.custom.
export default function studioQuestion(pi) {
  pi.registerTool({
    name: 'question',
    label: 'Question',
    description:
      'Ask the user 1 to 6 related, necessary clarification questions in one call. Offer a few distinct options, each with a short description explaining its impact or tradeoff; a free-text answer is always possible. Wait for the result before continuing dependent work. Delegated agents should ask their parent instead.',
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          question: Type.String({ minLength: 1, maxLength: 2000 }),
          options: Type.Array(
            Type.Object({
              label: Type.String({ minLength: 1, maxLength: 160 }),
              description: Type.String({ minLength: 1, maxLength: 500 }),
            }),
            { minItems: 2, maxItems: 6 },
          ),
        }),
        { minItems: 1, maxItems: 6 },
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const questions = validateQuestions(params.questions);
      if (questions.length > 1) {
        const reply = await ctx.ui.input(
          `Questions (${questions.length})`,
          QUESTION_MARKER + JSON.stringify({ questions }),
          { signal },
        );
        const values = reply === undefined
          ? questions.map(() => ({ skipped: true }))
          : validateAnswers(JSON.parse(reply), questions);
        const details = { questions, answers: normalizeAnswers(questions, values) };
        return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
      }
      const single = questions[0];
      const labels = single.options.map(
        (option, i) => `${i + 1}. ${option.label}${option.description ? ` — ${option.description}` : ''}`,
      );
      const other = OTHER_ANSWER;
      const selected = await ctx.ui.select(single.question, [...labels, other], { signal });
      let answer,
        wasCustom = false;
      if (selected === other) {
        wasCustom = true;
        answer = await ctx.ui.input(single.question, 'Votre réponse / Your answer', { signal });
      } else {
        const index = labels.indexOf(selected);
        if (index >= 0) answer = single.options[index].label;
        else if (typeof selected === 'string') {
          answer = selected;
          wasCustom = true;
        }
      }
      const details = {
        question: single.question,
        options: single.options,
        answer: answer?.trim() || null,
        wasCustom,
      };
      details.questions = questions;
      details.answers = [{ question: single.question, answer: details.answer, wasCustom, skipped: details.answer === null }];
      return {
        content: [{ type: 'text', text: JSON.stringify(details) }],
        details,
      };
    },
  });
}
