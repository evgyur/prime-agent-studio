import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createDirectoryOpener, directoryForReference } from '../lib/open-directory.mjs';
import { realpath, symlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'prime-studio-folder-unit-'));
  const folder = join(root, "dossier é & [notes], l'atelier (1)");
  await mkdir(folder);
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  return { root, folder };
}

test('Windows opens through a hidden helper with a literal Unicode path and requires foreground Explorer confirmation', async (t) => {
  const { folder } = await fixture(t);
  let launch;
  const open = createDirectoryOpener({
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows', PRIME_GUI_SILENT: '1' },
    run: async (...args) => {
      launch = args;
      return { stdout: '{"opened":true,"visible":true,"foreground":true}\r\n' };
    },
  });
  assert.deepEqual(await open(folder), { opened: true });
  const [command, args, options] = launch;
  assert.match(command, /powershell\.exe$/);
  assert.match(args.at(-1), /open-directory\.ps1$/);
  assert.equal(args.includes(folder), false);
  assert.equal(args.includes('-Command'), false);
  assert.equal(options.env.PRIME_STUDIO_OPEN_DIRECTORY, folder);
  assert.equal(options.windowsHide, true);
  assert.equal(options.shell, false);
  assert.ok(options.timeout > 0 && options.timeout <= 15000);
});

test('failed, timed out, or unconfirmed Explorer launches never report success and can be retried', async (t) => {
  const { folder } = await fixture(t);
  let outcome;
  const open = createDirectoryOpener({
    platform: 'win32',
    run: async () => {
      if (outcome instanceof Error) throw outcome;
      return { stdout: outcome };
    },
  });
  for (outcome of [
    new Error('launch failed'),
    new Error('timeout'),
    '',
    '{"opened":true}',
    '{"opened":true,"visible":false}',
    '{"opened":true,"visible":true}',
    '{"opened":true,"visible":true,"foreground":false}',
    'not-json',
  ]) {
    await assert.rejects(open(folder), { status: 502 });
  }
  outcome = '{"opened":true,"visible":true,"foreground":true}';
  assert.deepEqual(await open(folder), { opened: true });
});

test('rapid requests for one folder share a launch and invalid folders never start a helper', async (t) => {
  const { root, folder } = await fixture(t);
  let complete,
    launches = 0;
  const open = createDirectoryOpener({
    platform: 'win32',
    run: () => {
      launches++;
      return new Promise((done) => {
        complete = done;
      });
    },
  });
  const jobs = [open(folder), open(folder), open(folder)];
  while (!complete) await new Promise((done) => setTimeout(done, 5));
  await new Promise((done) => setTimeout(done, 20));
  assert.equal(launches, 1);
  complete({ stdout: '{"opened":true,"visible":true,"foreground":true}' });
  assert.deepEqual(await Promise.all(jobs), [{ opened: true }, { opened: true }, { opened: true }]);
  const file = join(root, 'not-a-folder.txt');
  await writeFile(file, 'fixture');
  for (const path of [file, join(root, 'missing'), 'relative-path', null])
    await assert.rejects(open(path), { status: 400 });
  assert.equal(launches, 1);
});

test('other desktop openers report nonzero command failures instead of treating process creation as success', async (t) => {
  const { folder } = await fixture(t);
  for (const platform of ['darwin', 'linux']) {
    let fail = false;
    const open = createDirectoryOpener({
      platform,
      run: async (command, args, options) => {
        assert.equal(command, platform === 'darwin' ? 'open' : 'xdg-open');
        assert.deepEqual(args, [folder]);
        assert.equal(options.shell, false);
        if (fail) throw new Error('exit 1');
        return { stdout: '' };
      },
    });
    assert.deepEqual(await open(folder), { opened: true });
    fail = true;
    await assert.rejects(open(folder), { status: 502 });
  }
});

test('native folder references are independent of project containment and preserve literal names', async (t) => {
  const { root, folder } = await fixture(t);
  const project = join(root, 'project');
  await mkdir(join(project, 'docs'), { recursive: true });
  const file = join(folder, 'mes notes.txt');
  await writeFile(file, 'Fixture');
  const expected = await realpath(folder);
  for (const input of [
    { cwd: folder },
    { path: folder },
    { cwd: project, path: '../' + basename(folder) },
    { cwd: project, reference: folder },
    { reference: folder },
    { reference: file },
    { cwd: project, reference: pathToFileURL(file).href },
    { cwd: project, reference: file + ':12:3' },
    { cwd: project, reference: file + '#L4-L9' },
    { cwd: project, reference: '../../' + basename(folder) + '/mes%20notes.txt', basePath: 'docs/readme.md' },
  ]) {
    const actual = await directoryForReference(input).catch((error) => {
      error.message += ' ' + JSON.stringify(input);
      throw error;
    });
    assert.equal(actual, expected, JSON.stringify(input));
  }
  const literal = join(folder, 'folder#L12');
  const percent = join(folder, '100% done');
  const encodedLiteral = join(folder, 'literal%20space');
  await mkdir(literal);
  await mkdir(percent);
  await mkdir(encodedLiteral);
  assert.equal(await directoryForReference({ reference: literal }), await realpath(literal));
  assert.equal(await directoryForReference({ reference: percent }), await realpath(percent));
  assert.equal(await directoryForReference({ reference: encodedLiteral }), await realpath(encodedLiteral));
  const junction = join(project, 'external');
  await symlink(folder, junction, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await directoryForReference({ cwd: project, reference: 'external' }), expected);
});

test('native folder resolution validates paths, types and existence without reading or launching files', async (t) => {
  const { root, folder } = await fixture(t);
  const file = join(root, 'installer.exe');
  await writeFile(file, 'Fixture: never executed');
  assert.equal(await directoryForReference({ reference: file }), await realpath(root));
  await assert.rejects(directoryForReference({ path: file }), { status: 400 });
  await assert.rejects(directoryForReference({ reference: join(root, 'missing') }), { status: 404 });
  for (const input of [
    {},
    { cwd: 'relative', reference: 'docs' },
    { cwd: null },
    { path: null },
    { cwd: folder, reference: '' },
    { reference: 12 },
    { reference: folder, basePath: [] },
    { reference: folder, path: 'ambiguous' },
    { reference: 'https://example.com/path' },
    { reference: 'javascript:alert(1)' },
    { reference: 'data:text/plain,test' },
    { reference: 'file:' },
    { cwd: folder, reference: 'bad\x00path' },
    { cwd: folder, reference: 'bad%00path' },
  ])
    await assert.rejects(directoryForReference(input), { status: 400 }, JSON.stringify(input));
});
