import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isFileReference } from '../public/file-links.js';
import { parentFolder } from '../public/file-presentation.js';
import { createProjectFiles } from '../lib/project-files.mjs';
import { pathToFileURL } from 'node:url';

test('file links cover dot folders, binaries, spaces, encoded and folder paths', () => {
  for (const reference of [
    'md_files/PLAN.md',
    'C:\\Project\\notes.md',
    'file:///C:/Project/report.pdf',
    'src/app.ts:12:3',
    'src/app.ts#L4-L9',
    'notes.md',
    '.local/desktop-release/v4.0.2/Prime-Agent-Studio_4.0.2_x64-setup.exe',
    'builds/app.exe',
    'archive.zip',
    'installer.msi',
    'run.tar.gz',
    'docs/guide.md',
    'docs/mes notes.md',
    'docs/mes%20notes.md',
    'docs/',
    'docs/sub/',
    '.local/release/app.exe',
    'lib/provider-auth.mjs:62-63',
    'beta.json',
  ])
    assert.equal(isFileReference(reference), true, reference);
  for (const value of [
    'https://example.com/file.md',
    'javascript:alert(1)',
    'mailto:user@example.test',
    '#heading',
    '//example.com/file.md',
    'hello world',
    'x\n.md',
    'justaword',
    'README',
    // Versions are not file names.
    'v4.4.3',
    '4.4.3-local.3',
    'local.2',
    '',
    null,
    undefined,
  ])
    assert.equal(isFileReference(value), false, String(value));
});

test('link resolution keeps security boundaries while serving files and folders', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'prime-file-links-'));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, 'builds'), { recursive: true });
  await mkdir(join(root, '.github', 'workflows'), { recursive: true });
  await writeFile(join(root, 'docs', 'guide.md'), '# Guide\n');
  await writeFile(join(root, 'docs', 'mes notes.md'), '# Notes\n');
  await writeFile(join(root, 'builds', 'app.exe'), Buffer.from([0x4d, 0x5a, 0x00, 0xff]));
  await writeFile(join(root, '.github', 'workflows', 'ci.yml'), 'on: push\n');
  const files = createProjectFiles({
    store: { findProject: async () => ({ cwd: root }) },
    protectedRoots: [],
  });
  assert.deepEqual(await files.resolveReference(root, 'docs/guide.md'), { path: 'docs/guide.md' });
  assert.deepEqual(await files.resolveReference(root, 'builds/app.exe'), { path: 'builds/app.exe' });
  assert.deepEqual(await files.resolveReference(root, 'docs/mes notes.md'), {
    path: 'docs/mes notes.md',
  });
  assert.deepEqual(await files.resolveReference(root, 'docs/mes%20notes.md'), {
    path: 'docs/mes notes.md',
  });
  assert.deepEqual(await files.resolveReference(root, 'docs/'), { path: 'docs', directory: true });
  assert.deepEqual(await files.resolveReference(root, 'docs'), { path: 'docs', directory: true });
  // Dot folders other than internals resolve like any project path.
  assert.deepEqual(await files.resolveReference(root, '.github/workflows/ci.yml'), {
    path: '.github/workflows/ci.yml',
  });
  const preview = await files.preview(root, 'builds/app.exe');
  assert.equal(preview.type, 'binary');
  await assert.rejects(files.resolveReference(root, '../outside'), { status: 403 });
  await assert.rejects(files.resolveReference(root, '/etc/hosts'), (error) =>
    [400, 403, 404].includes(error.status),
  );
  await assert.rejects(files.resolveReference(root, 'docs/missing.md'), { status: 404 });
  assert.equal(parentFolder('builds/app.exe'), 'builds');
  assert.equal(parentFolder('root.txt'), '');
});

test('published .local artifacts resolve unless the data dir covers them', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'prime-file-links-dot-'));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, '.local', 'desktop-release', 'v4.0.2'), { recursive: true });
  await mkdir(join(root, '.git'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
  const reference = '.local/desktop-release/v4.0.2/Prime-Agent-Studio_4.0.2_x64-setup.exe';
  await writeFile(join(root, reference), Buffer.from([0x4d, 0x5a, 0x00, 0xff]));
  await writeFile(join(root, '.local', 'workspace.json'), '{"projects":[]}');
  await writeFile(join(root, '.git', 'config'), '[core]\n');
  await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'export default 1;\n');
  // Installed app layout: the Studio data dir lives outside the project,
  // so a project .local is ordinary project content.
  const files = createProjectFiles({
    store: { findProject: async () => ({ cwd: root }) },
    protectedRoots: [join(root, '..', 'studio-data')],
  });
  assert.equal(isFileReference(reference), true);
  assert.deepEqual(await files.resolveReference(root, reference), { path: reference });
  const preview = await files.preview(root, reference);
  assert.equal(preview.type, 'binary');
  assert.ok(preview.size > 0);
  // Reveal targets the containing folder through the same public artifact path.
  assert.equal(
    await files.localDirectory(root, parentFolder(reference)),
    await realpath(join(root, '.local', 'desktop-release', 'v4.0.2')),
  );
  // Version control internals and dependencies keep refusing.
  await assert.rejects(files.resolveReference(root, '.git/config'), { status: 403 });
  await assert.rejects(files.resolveReference(root, 'node_modules/pkg/index.js'), { status: 403 });
  // Source tree layout: when the running Studio data dir IS the project
  // .local folder, its content stays refused.
  const devFiles = createProjectFiles({
    store: { findProject: async () => ({ cwd: root }) },
    protectedRoots: [join(root, '.local')],
  });
  await assert.rejects(devFiles.resolveReference(root, reference), { status: 403 });
  await assert.rejects(devFiles.resolveReference(root, '.local/workspace.json'), { status: 403 });
});

test('project root references resolve as folders and symlinks never widen resolution', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'prime-file-links-root-'));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'docs', 'guide.md'), '# Guide\n');
  const outside = await mkdtemp(join(tmpdir(), 'prime-file-links-outside-'));
  t.after(async () => {
    await rm(outside, { recursive: true, force: true, maxRetries: 5 });
  });
  await writeFile(join(outside, 'secret.txt'), 'private');
  await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const files = createProjectFiles({
    store: { findProject: async () => ({ cwd: root }) },
    protectedRoots: [],
  });
  // Absolute and file: references to the project root resolve as a folder,
  // so the viewer can offer the folder reveal action for them.
  assert.deepEqual(await files.resolveReference(root, root), { path: '', directory: true });
  assert.deepEqual(await files.resolveReference(root, pathToFileURL(root).href), {
    path: '',
    directory: true,
  });
  // Symlinked directories are never descended or matched: a bare filename
  // reachable only through the link stays missing, and the slashed escape
  // path is refused for leaving the project.
  await assert.rejects(files.resolveReference(root, 'secret.txt'), { status: 404 });
  await assert.rejects(files.resolveReference(root, 'escape/secret.txt'), { status: 403 });
});

test('file names and path endings resolve through the git file list, ignoring build outputs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'prime-file-links-index-'));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  for (const dir of ['web/src/components', 'build/web/src/components', 'docs'])
    await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, '.gitignore'), 'build/\n');
  await writeFile(join(root, 'web', 'src', 'app.js'), 'export {};\n');
  await writeFile(join(root, 'web', 'src', 'components', 'button.js'), 'export {};\n');
  await writeFile(join(root, 'docs', 'button.js'), '// other button\n');
  // Ignored build copies must never shadow or duplicate the real file.
  await writeFile(join(root, 'build', 'web', 'src', 'app.js'), 'compiled\n');
  await writeFile(join(root, 'build', 'web', 'src', 'components', 'button.js'), 'compiled\n');
  await promisify(execFile)('git', ['-C', root, 'init', '-q']);
  const files = createProjectFiles({ store: { findProject: async () => ({ cwd: root }) }, protectedRoots: [] });
  assert.deepEqual(await files.resolveReference(root, 'app.js'), { path: 'web/src/app.js' });
  assert.deepEqual(await files.resolveReference(root, 'app.js:12'), { path: 'web/src/app.js' });
  assert.deepEqual(await files.resolveReference(root, 'src/app.js:62-63'), { path: 'web/src/app.js' });
  assert.deepEqual(await files.resolveReference(root, './components/button.js'), {
    path: 'web/src/components/button.js',
  });
  // The same name in two real folders stays a choice.
  assert.deepEqual(await files.resolveReference(root, 'button.js'), {
    matches: [{ path: 'docs/button.js' }, { path: 'web/src/components/button.js' }],
  });
  // A path ending matches whole folder names only.
  await assert.rejects(files.resolveReference(root, 'rc/app.js'), { status: 404 });
  // Explicit relative paths are never guessed from another folder.
  await assert.rejects(files.resolveReference(root, '../src/app.js'), { status: 403 });
  if (process.platform === 'win32')
    assert.deepEqual(await files.resolveReference(root, '/web/src/app.js'), { path: 'web/src/app.js' });
  // A new file is found once the short index cache expires (5 s): an exact path works at once.
  await writeFile(join(root, 'docs', 'new.md'), '# New\n');
  assert.deepEqual(await files.resolveReference(root, 'docs/new.md'), { path: 'docs/new.md' });
});

test('folders outside git still resolve file names with the bounded walk', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'prime-file-links-walk-'));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'notes', 'deep'), { recursive: true });
  await writeFile(join(root, 'notes', 'deep', 'plan.md'), '# Plan\n');
  const files = createProjectFiles({ store: { findProject: async () => ({ cwd: root }) }, protectedRoots: [] });
  assert.deepEqual(await files.resolveReference(root, 'plan.md'), { path: 'notes/deep/plan.md' });
  await assert.rejects(files.resolveReference(root, 'missing.md'), { status: 404 });
});

test('reference checks report what each rendered reference would open', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'prime-file-links-check-'));
  const outsideDir = await mkdtemp(join(tmpdir(), 'prime-file-links-outside-'));
  t.after(async () => {
    for (const dir of [root, outsideDir]) {
      assert.equal(dirname(dir), resolve(tmpdir()));
      await rm(dir, { recursive: true, force: true });
    }
  });
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, 'a'), { recursive: true });
  await mkdir(join(root, 'b'), { recursive: true });
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, 'docs', 'guide.md'), '# Guide\n');
  await writeFile(join(root, 'a', 'same.txt'), 'a\n');
  await writeFile(join(root, 'b', 'same.txt'), 'b\n');
  await writeFile(join(root, '.git', 'config'), '[core]\n');
  await writeFile(join(outsideDir, 'secret.md'), '# Secret\n');
  const files = createProjectFiles({ store: { findProject: async () => ({ cwd: root }) }, protectedRoots: [] });
  const references = [
    'docs/guide.md:3',
    'guide.md',
    'docs/',
    'same.txt',
    'missing.md',
    '.git/config',
    join(outsideDir, 'secret.md'),
    'https://example.com/a.md',
  ];
  const { results } = await files.checkReferences(root, references);
  assert.deepEqual(
    results.map((item) => item.status),
    ['file', 'file', 'directory', 'ambiguous', 'missing', 'blocked', 'outside', 'invalid'],
  );
  assert.deepEqual(
    results.map((item) => item.reference),
    references,
  );
  // Relative references follow the rendered document folder.
  assert.deepEqual((await files.checkReferences(root, ['guide.md'], 'docs/index.md')).results, [
    { reference: 'guide.md', status: 'file' },
  ]);
  await assert.rejects(files.checkReferences(root, 'docs/guide.md'), { status: 400 });
  await assert.rejects(files.checkReferences(root, Array(51).fill('a.md')), { status: 400 });
});
