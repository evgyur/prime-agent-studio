import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { QUESTION_MARKER, OTHER_ANSWER } from '../runtime/studio-question-protocol.mjs';
register('./typebox-hook.mjs', import.meta.url);
const { default: registerQuestion } = await import('../runtime/studio-question-extension.mjs');
let tool;
registerQuestion({
  registerTool: (registered) => {
    tool = registered;
  },
});
const question = {
  question: 'Pick?',
  options: [
    { label: 'A', description: 'First' },
    { label: 'B', description: 'Second' },
  ],
};
const signal = new AbortController().signal;

test('one question preserves select, custom follow-up, cancellation and legacy result keys', async () => {
  assert.equal(tool.name, 'question');
  assert.deepEqual(tool.parameters.properties.questions.options, { minItems: 1, maxItems: 6 });
  for (const selected of ['1. A — First', OTHER_ANSWER, 'Direct text', undefined]) {
    let inputCalls = 0;
    const result = await tool.execute('id', { questions: [question] }, signal, null, {
      ui: {
        async select(title, options, config) {
          assert.equal(title, 'Pick?');
          assert.deepEqual(options, ['1. A — First', '2. B — Second', OTHER_ANSWER]);
          assert.equal(config.signal, signal);
          return selected;
        },
        async input(title, placeholder, config) {
          inputCalls++;
          assert.equal(title, 'Pick?');
          assert.equal(placeholder, 'Votre réponse / Your answer');
          assert.equal(config.signal, signal);
          return 'Custom text';
        },
      },
    });
    const expected =
      selected === OTHER_ANSWER ? 'Custom text' : selected === '1. A — First' ? 'A' : (selected ?? null);
    assert.equal(result.details.answer, expected);
    assert.equal(result.details.question, question.question);
    assert.deepEqual(result.details.options, question.options);
    assert.equal(result.details.answers[0].skipped, selected === undefined);
    assert.equal(inputCalls, selected === OTHER_ANSWER ? 1 : 0);
    assert.deepEqual(JSON.parse(result.content[0].text), result.details);
  }
});

test('three questions use one input, validate replies, and normalize cancelled batches', async () => {
  const questions = [question, question, question];
  const values = [{ option: 1 }, { text: '  Custom  ' }, { skipped: true }];
  let calls = 0;
  const execute = (reply) =>
    tool.execute('id', { questions }, signal, null, {
      ui: {
        async input(title, placeholder, config) {
          calls++;
          assert.equal(title, 'Questions (3)');
          assert.deepEqual(JSON.parse(placeholder.slice(QUESTION_MARKER.length)), { questions });
          assert.ok(placeholder.startsWith(QUESTION_MARKER));
          assert.equal(config.signal, signal);
          return reply;
        },
        select() {
          assert.fail('batch must not select');
        },
      },
    });
  const result = await execute(JSON.stringify(values));
  assert.equal(calls, 1);
  assert.deepEqual(
    result.details.answers.map((answer) => answer.answer),
    ['B', 'Custom', null],
  );
  assert.deepEqual(JSON.parse(result.content[0].text), result.details);
  assert.equal('answer' in result.details, false);
  for (const reply of [
    'oops',
    '[]',
    JSON.stringify([{ option: 2 }, ...values.slice(1)]),
    JSON.stringify([{ text: 'x'.repeat(1001) }, ...values.slice(1)]),
    JSON.stringify([{ option: 0, text: 'both' }, ...values.slice(1)]),
  ])
    await assert.rejects(execute(reply));
  const cancelled = await execute(undefined);
  assert.ok(cancelled.details.answers.every((answer) => answer.skipped && answer.answer === null));
});
