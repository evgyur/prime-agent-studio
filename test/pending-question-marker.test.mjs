import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasPendingQuestion, pendingQuestionCount } from '../public/project-navigation.js';
import { formatMessage } from '../public/i18n-core.js';

test('only current unanswered pending interactions count on a running run', () => {
  const run = {
    status: 'running',
    interactions: [
      { id: 'q-1', status: 'pending' },
      { id: 'q-2', status: 'pending' },
      { id: 'q-3', status: 'answered', answer: 'Fixture' },
      { id: 'q-4', status: 'cancelled' },
    ],
  };
  assert.equal(pendingQuestionCount(run), 2);
  assert.equal(hasPendingQuestion(run), true);
  run.interactions[0] = { id: 'q-1', status: 'answered', answer: 'A' };
  assert.equal(pendingQuestionCount(run), 1);
  run.interactions[1] = { id: 'q-2', status: 'answered', answer: false };
  assert.equal(pendingQuestionCount(run), 0);
  assert.equal(hasPendingQuestion(run), false);
});

test('answered history supersedes an old replayed pending snapshot', () => {
  assert.equal(
    pendingQuestionCount({
      status: 'running',
      interactions: [
        { id: 'q-1', status: 'pending' },
        { id: 'q-1', status: 'answered', answer: 'A' },
      ],
    }),
    0,
  );
  assert.equal(
    pendingQuestionCount({
      status: 'running',
      interactions: [{ id: 'q-1', status: 'pending', answer: false }],
    }),
    0,
  );
});

test('finished, stopping and malformed runs never advertise pending answers', () => {
  for (const status of ['stopping', 'completed', 'failed', 'stopped'])
    assert.equal(pendingQuestionCount({ status, interactions: [{ id: 'q-1', status: 'pending' }] }), 0);
  for (const run of [
    null,
    {},
    { status: 'running', interactions: {} },
    { status: 'running', interactions: [null] },
  ])
    assert.equal(pendingQuestionCount(run), 0);
});

test('pending answer labels preserve English and French plural forms', () => {
  assert.equal(formatMessage('navigation.pendingAnswers', { count: 1 }, 'en'), 'Waiting for your answer');
  assert.equal(
    formatMessage('navigation.pendingAnswers', { count: 2 }, 'en'),
    'Waiting for your answer (2 questions)',
  );
  assert.equal(formatMessage('navigation.pendingAnswers', { count: 1 }, 'fr'), 'En attente de votre réponse');
  assert.equal(
    formatMessage('navigation.pendingAnswers', { count: 2 }, 'fr'),
    'En attente de votre réponse (2 questions)',
  );
});
