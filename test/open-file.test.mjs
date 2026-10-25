import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import {
  createFileOpener,
  fileLaunchMode,
  isTextLikeFile,
  DOCUMENT_EXTENSIONS,
  ASSOCIATED_CODE_EXTENSIONS,
  EDITOR_EXTENSIONS,
} from '../lib/open-file.mjs';

test('native open passes a literal filename to a hidden helper and requires Shell acceptance', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'prime-native-file-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const path = join(root, 'rapport é & [1]; $test.md');
  await writeFile(path, '# Fixture');
  let call,
    response = '{"opened":true}';
  const opener = createFileOpener({
    platform: 'win32',
    run: async (...args) => {
      call = args;
      return { stdout: response };
    },
  });
  assert.deepEqual(await opener(path), { opened: true });
  assert.equal(call[2].windowsHide, true);
  assert.equal(call[2].shell, false);
  assert.equal(call[2].env.PRIME_STUDIO_OPEN_FILE, path);
  assert.equal(call[2].env.PRIME_STUDIO_FILE_MODE, 'associated');
  assert.equal(call[2].env.PRIME_STUDIO_FILE_TEXT, '1');
  assert.equal(call[1].includes(path), false);
  assert.equal(call[1].includes('-Command'), false);
  response = '{"opened":false}';
  await assert.rejects(opener(path), { status: 502 });
  await assert.rejects(opener(join(root, 'missing.md')), { status: 404 });
});

test('open classification: documents and safe code open associated, executable scripts go to Notepad', () => {
  for (const path of ['notes.md', 'report.pdf', 'table.xlsx', 'photo.png', 'archive.zip'])
    assert.equal(fileLaunchMode(path), 'associated');
  for (const path of [
    'page.html',
    'page.htm',
    'feed.xhtml',
    'data.xml',
    'image.svg',
    'style.css',
    'theme.scss',
    'theme.less',
    'app.ts',
    'view.tsx',
    'view.jsx',
    'config.jsonc',
    'config.yaml',
    'config.yml',
    'config.toml',
    'setup.ini',
    'app.conf',
    'app.cfg',
    'query.sql',
    'main.c',
    'main.h',
    'main.cpp',
    'main.hpp',
    'Main.cs',
    'Main.java',
    'Main.kt',
    'main.go',
    'main.rs',
    'main.swift',
    'paper.tex',
  ])
    assert.equal(fileLaunchMode(path), 'associated', path);
  for (const path of [
    'script.js',
    'script.mjs',
    'script.cjs',
    'script.jse',
    'macro.vbs',
    'macro.vbe',
    'macro.wsf',
    'host.wsh',
    'install.ps1',
    'module.psm1',
    'start.bat',
    'start.cmd',
    'deploy.sh',
    'deploy.bash',
    'app.py',
    'app.pyw',
    'gem.rb',
    'script.pl',
    'page.php',
    'mod.lua',
    'settings.reg',
    'setup.inf',
    'README',
  ])
    assert.equal(fileLaunchMode(path), 'editor', path);
  for (const path of [
    'app.exe',
    'shortcut.lnk',
    'page.url',
    'installer.msi',
    'run.hta',
    'run.com',
    'screen.scr',
    'panel.cpl',
    'lib.jar',
  ])
    assert.throws(() => fileLaunchMode(path), { status: 400 }, path);
});

test('open classification sets stay explicit and disjoint', () => {
  for (const extension of ASSOCIATED_CODE_EXTENSIONS) assert.ok(!EDITOR_EXTENSIONS.has(extension), extension);
  for (const extension of EDITOR_EXTENSIONS) assert.ok(!DOCUMENT_EXTENSIONS.has(extension), extension);
  for (const extension of ASSOCIATED_CODE_EXTENSIONS)
    assert.ok(!DOCUMENT_EXTENSIONS.has(extension), extension);
  assert.ok(!EDITOR_EXTENSIONS.has('ts'), 'a .ts file follows the user Windows choice');
  assert.ok(EDITOR_EXTENSIONS.has('reg') && EDITOR_EXTENSIONS.has('inf'));
});

test('text-like fallback flag covers every text type but no binary document', () => {
  for (const path of ['notes.md', 'page.html', 'style.css', 'app.ts', 'data.yaml', 'query.sql', 'script.ps1'])
    assert.equal(isTextLikeFile(path), true, path);
  for (const path of ['report.pdf', 'photo.png', 'archive.zip', 'movie.mp4', 'sound.mp3'])
    assert.equal(isTextLikeFile(path), false, path);
});

test('text flag travels to the helper for both associated and editor modes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'prime-native-flag-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const seen = {};
  const opener = createFileOpener({
    platform: 'win32',
    run: async (exe, args, options) => {
      seen[options.env.PRIME_STUDIO_OPEN_FILE] = {
        mode: options.env.PRIME_STUDIO_FILE_MODE,
        text: options.env.PRIME_STUDIO_FILE_TEXT,
      };
      return { stdout: '{"opened":true}' };
    },
  });
  for (const name of ['page.html', 'archive.zip', 'photo.png', 'setup.ps1']) {
    const path = join(root, name);
    await writeFile(path, 'x');
    await opener(path);
  }
  assert.deepEqual(seen[join(root, 'page.html')], { mode: 'associated', text: '1' });
  assert.deepEqual(seen[join(root, 'setup.ps1')], { mode: 'editor', text: '1' });
  assert.deepEqual(seen[join(root, 'archive.zip')], { mode: 'associated', text: '0' });
  assert.deepEqual(seen[join(root, 'photo.png')], { mode: 'associated', text: '0' });
});
