import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createNativeInteractions } from '../lib/native-interactions.mjs';
import { transformStudioRpc } from '../runtime/studio-rpc-hook.mjs';
import { discoverCli } from '../lib/agent.mjs';
import { createProjectFiles } from '../lib/project-files.mjs';

test('native answers are correlated, validated and only accepted once after acknowledgement', async () => {
  const events = [],
    commands = [];
  const bridge = createNativeInteractions({
    emit: (event) => events.push(event),
    send: (command) => commands.push(command),
  });
  bridge.consume({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'question' });
  bridge.consume({
    type: 'extension_ui_request',
    id: 'q1',
    method: 'select',
    title: 'Pick',
    options: ['A', 'B'],
  });
  const pending = bridge.respond('q1', { value: 'Custom answer' });
  assert.equal(events.at(-1).request.status, 'pending');
  await assert.rejects(bridge.respond('q1', { value: 'B' }));
  assert.deepEqual(commands, [{ type: 'extension_ui_response', id: 'q1', value: 'Custom answer' }]);
  bridge.consume({ type: 'tool_execution_end', toolCallId: 't1' });
  bridge.consume({ type: 'response', id: 'q1', command: 'extension_ui_response', success: true });
  assert.equal((await pending).status, 'answered');
  assert.equal(events.at(-1).request.answer, 'Custom answer');
  await assert.rejects(bridge.respond('q1', { value: 'B' }));
  bridge.close();
});

test('generic engine selects reject arbitrary answers; expired and cancelled tools cannot remain pending', async () => {
  const events = [];
  const bridge = createNativeInteractions({ emit: (event) => events.push(event), send() {} });
  bridge.consume({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'ipython' });
  bridge.consume({
    type: 'extension_ui_request',
    id: 'q1',
    method: 'select',
    title: 'Kernel busy',
    options: ['Wait', 'Kill'],
  });
  await assert.rejects(bridge.respond('q1', { value: 'Arbitrary' }), /invalide/);
  bridge.consume({ type: 'tool_execution_end', toolCallId: 't1' });
  assert.equal(events.at(-1).request.status, 'cancelled');
  await assert.rejects(bridge.respond('q1', { value: 'Wait' }));
  bridge.consume({ type: 'extension_ui_request', id: 'q2', method: 'input', title: 'Input' });
  const pending = bridge.respond('q2', { value: 'Text' });
  bridge.consume({ type: 'response', id: 'q2', command: 'extension_ui_response', success: false });
  await assert.rejects(pending);
  assert.equal(events.at(-1).request.status, 'interrupted');
  bridge.close();
});

test('RPC adapter matches actual packaged and source modules and fails on incompatible layouts', async () => {
  const cli = discoverCli();
  if (!cli?.packageDir) return;
  const root = cli.packageDir;
  let checked = 0;
  for (const path of [
    join(root, 'dist/modes/rpc/rpc-mode.js'),
    ...(await readdir(join(root, 'dist/bundle')))
      .filter((name) => name.endsWith('.js'))
      .map((name) => join(root, 'dist/bundle', name)),
  ]) {
    const source = await readFile(path, 'utf8');
    if (!source.includes('function runRpcModeWithConnectionInternal(')) continue;
    const adapted = transformStudioRpc(source);
    assert.equal(adapted.changed, true);
    assert.ok(adapted.source.includes('waitForRlmQuiescence: true'));
    assert.throws(() => transformStudioRpc(source.replaceAll('case "get_state": {', 'case "new_state": {')));
    checked++;
  }
  assert.ok(checked >= 2);
});

test('referenced images read current project files, detect deletion and reject private/outside paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'prime-images-'));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const cwd = join(root, 'project'),
    outside = join(root, 'private');
  await mkdir(cwd);
  await mkdir(outside);
  await mkdir(join(cwd, '.local'));
  const images = createProjectFiles({
    protectedRoots: [join(cwd, '.local')],
    store: {
      findProject: async (value) => {
        assert.equal(value, cwd);
        return { cwd };
      },
    },
  });
  const file = join(cwd, 'résultat.png');
  await writeFile(file, 'first');
  assert.equal((await images.image(cwd, 'r%C3%A9sultat.png')).data.toString(), 'first');
  await writeFile(file, 'updated');
  assert.equal((await images.image(cwd, file)).data.toString(), 'updated');
  await rm(file);
  await assert.rejects(images.image(cwd, 'résultat.png'), (error) => error.status === 404);
  await writeFile(join(outside, 'secret.png'), 'private');
  await writeFile(join(cwd, '.local', 'secret.png'), 'private');
  await symlink(outside, join(cwd, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const path of ['../private/secret.png', 'escape/secret.png', '.local/secret.png'])
    await assert.rejects(images.image(cwd, path), (error) => error.status === 403);
  await writeFile(join(cwd, 'unsafe.svg'), '<svg/>');
  await assert.rejects(images.image(cwd, 'unsafe.svg'), (error) => error.status === 415);
});


test('question select recovers custom text and descriptions without a tool-start snapshot', async () => {
  const events = [];
  const bridge = createNativeInteractions({ emit: (event) => events.push(event), send(command) {
    bridge.consume({ type: 'response', id: command.id, command: 'extension_ui_response', success: true });
  } });
  for (const stale of [false, true]) {
    if (stale) bridge.consume({ type: 'tool_execution_start', toolCallId: 'old', toolName: 'question',
      args: { options: [{ label: 'Wrong', description: 'Stale' }] } });
    bridge.consume({ type: 'extension_ui_request', id: `single-${stale}`, method: 'select', title: 'Pick',
      options: ['1. A — First — still description', '2. B — Second', 'Autre réponse / Other answer'] });
    const request = events.at(-1).request;
    assert.equal(request.allowCustom, true);
    assert.deepEqual(request.optionDetails, [
      { label: 'A', description: 'First — still description' },
      { label: 'B', description: 'Second' }, null,
    ]);
    await assert.rejects(bridge.respond(request.id, { values: [{ text: 'No batch' }] }));
    assert.equal((await bridge.respond(request.id, { value: 'Custom' })).answer, 'Custom');
  }
  bridge.close();
});

test('batch projection is self-contained, clean and validates both response carriers', async () => {
  const { QUESTION_MARKER } = await import('../runtime/studio-question-protocol.mjs');
  const questions = ['First?', 'Second?', 'Third?'].map((question) => ({ question,
    options: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }] }));
  const events = [], commands = [];
  const bridge = createNativeInteractions({ emit: (event) => events.push(event), send(command) {
    commands.push(command);
    bridge.consume({ type: 'response', id: command.id, command: 'extension_ui_response', success: true });
  } });
  const add = (id) => bridge.consume({ type: 'extension_ui_request', id, method: 'input',
    title: 'Questions (3)', placeholder: QUESTION_MARKER + JSON.stringify({ questions }) });
  add('batch');
  const projected = events.at(-1).request;
  assert.equal(projected.kind, 'questions');
  assert.equal(projected.allowCustom, true);
  assert.equal(projected.questions[0].id, 'q1');
  assert.deepEqual(projected.questions[0].options[1], { id: 'o2', label: 'B', description: 'Second' });
  assert.ok(!JSON.stringify(events).includes('studio-questions:v1:'));
  for (const values of [[], [{ skipped: true }], [{ option: 2 }, { text: 'ok' }, { skipped: true }],
    [{ option: -1 }, { text: 'ok' }, { skipped: true }],
    [{ option: 0, text: 'both' }, { text: 'ok' }, { skipped: true }],
    [{ option: 0 }, { text: ' ' }, { skipped: true }],
    [{ option: 0 }, { text: 'x'.repeat(1001) }, { skipped: true }],
    [{ option: 0 }, { text: 'ok' }, { skipped: false }]]) {
    await assert.rejects(bridge.respond('batch', { values }));
    await assert.rejects(bridge.respond('batch', { value: JSON.stringify(values) }));
  }
  for (const response of [{ confirmed: true }, { value: 'not JSON' }, { cancelled: true, values: [] },
    { values: null }, { value: '{}' }]) await assert.rejects(bridge.respond('batch', response));
  assert.equal(commands.length, 0);
  const values = [{ option: 1 }, { text: 'Custom' }, { skipped: true }];
  const answered = await bridge.respond('batch', { values });
  assert.equal(commands[0].value, JSON.stringify(values));
  assert.equal('values' in commands[0], false);
  assert.deepEqual(answered.answers, [
    { question: 'First?', answer: 'B', wasCustom: false, skipped: false },
    { question: 'Second?', answer: 'Custom', wasCustom: true, skipped: false },
    { question: 'Third?', answer: null, wasCustom: false, skipped: true },
  ]);
  await assert.rejects(bridge.respond('batch', { values }));
  add('legacy');
  assert.deepEqual((await bridge.respond('legacy', { value: JSON.stringify(values) })).answers, answered.answers);
  add('cancel');
  const cancelled = await bridge.respond('cancel', { cancelled: true });
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(cancelled.answers.every((answer) => answer.skipped && answer.answer === null));
  assert.deepEqual(commands.at(-1), { type: 'extension_ui_response', id: 'cancel', cancelled: true });
  // Malformed carrier: degrades to a plain request, never throws in the stdout handler.
  assert.doesNotThrow(() => bridge.consume({ type: 'extension_ui_request', id: 'invalid', method: 'input',
    placeholder: QUESTION_MARKER + JSON.stringify({ questions: [] }) }));
  assert.equal(events.at(-1).request.kind, undefined);
  assert.ok(!JSON.stringify(events).includes('studio-questions:v1:'));
  add('closed');
  bridge.close();
  assert.equal(events.at(-1).request.status, 'cancelled');
  await assert.rejects(bridge.respond('closed', { values }));
});

test('a malformed batch never throws in the stdout handler and never leaks the carrier', async () => {
  const { QUESTION_MARKER } = await import('../runtime/studio-question-protocol.mjs');
  const events = [];
  const bridge = createNativeInteractions({ emit: (event) => events.push(event), send() {} });
  for (const [id, placeholder] of [
    ['truncated', QUESTION_MARKER + '{"questions":[{"question":"A?"'],
    ['invalid', QUESTION_MARKER + JSON.stringify({ questions: [{ question: 'A?', options: [] }] })],
  ]) {
    assert.doesNotThrow(() => bridge.consume({ type: 'extension_ui_request', id, method: 'input', title: 'Questions', placeholder }));
    const request = events.at(-1).request;
    assert.equal(request.kind, undefined, 'degrades to a plain text request');
    await assert.rejects(bridge.respond(id, { values: [{ skipped: true }] }), /Réponse invalide/);
  }
  assert.ok(!JSON.stringify(events).includes('studio-questions:v1:'));
});
