// Shared by the tool and Studio projection; no engine imports or tool-start state.
export const QUESTION_MARKER = '\u2063studio-questions:v1:';
export const OTHER_ANSWER = 'Autre réponse / Other answer';
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && !!value.trim() && value.length <= max;

export function validateQuestions(questions) {
  if (
    !Array.isArray(questions) ||
    questions.length < 1 ||
    questions.length > 6 ||
    questions.some(
      (item) =>
        !record(item) ||
        !text(item.question, 2000) ||
        !Array.isArray(item.options) ||
        item.options.length < 2 ||
        item.options.length > 6 ||
        item.options.some(
          (option) => !record(option) || !text(option.label, 160) || !text(option.description, 500),
        ),
    )
  )
    throw new Error('Invalid questions.');
  return questions;
}

// Option indices are zero-based. Without questions, validate the public API shape.
export function validateAnswers(values, questions) {
  if (
    !Array.isArray(values) ||
    values.length < 1 ||
    values.length > 6 ||
    (questions && values.length !== questions.length)
  )
    throw new Error('Invalid answer count.');
  return values.map((value, index) => {
    if (!record(value) || Object.keys(value).length !== 1) throw new Error('Invalid answer.');
    if (value.skipped === true) return { skipped: true };
    if (text(value.text, 1000)) return { text: value.text.trim() };
    if (
      Number.isInteger(value.option) &&
      value.option >= 0 &&
      value.option < (questions?.[index].options.length ?? 6)
    )
      return { option: value.option };
    throw new Error('Invalid answer.');
  });
}

export function normalizeAnswers(questions, values) {
  return questions.map((item, index) => ({
    question: item.question,
    answer: values[index].skipped ? null : (values[index].text ?? item.options[values[index].option].label),
    wasCustom: typeof values[index].text === 'string',
    skipped: values[index].skipped === true,
  }));
}
