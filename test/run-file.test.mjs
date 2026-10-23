import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { request } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  createScriptRunner,
  runnerKindFor,
  isRunnableScript,
  quoteCmdArg,
  buildRunLaunch,
  resolveRunnerInterpreter,
  findOnPath,
  RUNNABLE_SCRIPT_EXTENSIONS,
  RUNNER_PROGRAM,
} from '../lib/run-file.mjs';
import { EDITOR_EXTENSIONS } from '../lib/open-file.mjs';
import { createApp } from '../server.mjs';
import { createLanGateway, hashAccessCode } from '../lib/lan.mjs';
import { messages } from '../public/translations.js';
import { desktopRuntimeScripts } from '../scripts/desktop-runtime-resources.mjs';

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const NASTY_DIR = 'dossier é & [1]; $x \u00e9\u4e2d ^ (2)';
const nasty = (name) => join('C:\\Atelier', NASTY_DIR, name);

test('run classification only accepts runnable scripts, never registry data or programs', () => {
  assert.equal(runnerKindFor('run.bat'), 'bat');
  assert.equal(runnerKindFor('run.cmd'), 'bat');
  assert.equal(runnerKindFor('task.ps1'), 'ps1');
  assert.equal(runnerKindFor('tool.py'), 'py');
  assert.equal(runnerKindFor('tool.pyw'), 'py');
  assert.equal(runnerKindFor('app.js'), 'node');
  assert.equal(runnerKindFor('app.mjs'), 'node');
  assert.equal(runnerKindFor('app.cjs'), 'node');
  assert.equal(runnerKindFor('deploy.sh'), 'bash');
  assert.equal(runnerKindFor('deploy.bash'), 'bash');
  assert.equal(runnerKindFor('macro.vbs'), 'cscript');
  assert.equal(runnerKindFor('macro.vbe'), 'cscript');
  assert.equal(runnerKindFor('macro.wsf'), 'cscript');
  assert.equal(runnerKindFor('macro.jse'), 'cscript');
  assert.equal(runnerKindFor('gem.rb'), 'ruby');
  assert.equal(runnerKindFor('script.pl'), 'perl');
  assert.equal(runnerKindFor('page.php'), 'php');
  assert.equal(runnerKindFor('mod.lua'), 'lua');
  assert.equal(runnerKindFor('RUN.PS1'), 'ps1');
  for (const path of [
    'settings.reg',
    'setup.inf',
    'module.psm1',
    'host.wsh',
    'notes.md',
    'report.pdf',
    'style.css',
    'app.exe',
    'setup.msi',
    'run.com',
    'lib.jar',
    'page.url',
    'README',
    'archive.tar.gz',
  ])
    assert.throws(() => runnerKindFor(path), { status: 400 }, path);
  assert.equal(isRunnableScript('task.ps1'), true);
  assert.equal(isRunnableScript('settings.reg'), false);
  assert.equal(isRunnableScript('app.exe'), false);
});

test('run classification stays in sync with the Ouvrir editor set and the UI button set', async () => {
  for (const extension of RUNNABLE_SCRIPT_EXTENSIONS)
    assert.ok(EDITOR_EXTENSIONS.has(extension), `${extension} must open in Notepad for Ouvrir`);
  assert.ok(!RUNNABLE_SCRIPT_EXTENSIONS.has('reg'));
  assert.ok(!RUNNABLE_SCRIPT_EXTENSIONS.has('inf'));
  const inspector = await readFile(new URL('../public/inspector.js', import.meta.url), 'utf8');
  const match = inspector.match(/RUNNABLE_SCRIPT_EXTENSIONS = new Set\(\n?\s*'([^']+)'/);
  assert.ok(match, 'UI mirror set found');
  assert.deepEqual(new Set(match[1].split(' ')), RUNNABLE_SCRIPT_EXTENSIONS);
});

test('console quoting keeps spaces, %, &, ^, quotes and unicode literal', () => {
  assert.equal(quoteCmdArg('C:\\simple\\run.bat'), '"C:\\simple\\run.bat"');
  assert.equal(quoteCmdArg(nasty('sc ript.bat')), `"${nasty('sc ript.bat')}"`);
  assert.equal(quoteCmdArg('C:\\100%\\x.bat'), '"C:\\100%\\x.bat"');
  assert.equal(quoteCmdArg('C:\\a&b^c\\s.bat'), '"C:\\a&b^c\\s.bat"');
  assert.equal(quoteCmdArg('trail\\'), '"trail\\\\"');
  assert.equal(quoteCmdArg('say "hi"'), '"say \\"hi\\""');
  const quoted = quoteCmdArg(nasty('tâche ünïcodé (1).ps1'));
  assert.ok(quoted.startsWith('"') && quoted.endsWith('"'));
  assert.ok(quoted.includes('tâche ünïcodé (1).ps1'));
});

test('run plans use one visible console that stays open in the script folder', () => {
  const cmd = 'C:\\Windows\\System32\\cmd.exe';
  const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const cases = {
    bat: { interpreter: cmd, inner: (file) => quoteCmdArg(file) },
    ps1: {
      interpreter: ps,
      inner: (file) => `${quoteCmdArg(ps)} -NoExit -ExecutionPolicy Bypass -File ${quoteCmdArg(file)}`,
    },
    py: { interpreter: 'C:\\Python\\py.exe', inner: (file) => `"C:\\Python\\py.exe" ${quoteCmdArg(file)}` },
    node: { interpreter: 'C:\\node\\node.exe', inner: (file) => `"C:\\node\\node.exe" ${quoteCmdArg(file)}` },
    bash: {
      interpreter: 'C:\\Program Files\\Git\\bin\\bash.exe',
      inner: (file) => `"C:\\Program Files\\Git\\bin\\bash.exe" ${quoteCmdArg(file)}`,
    },
    cscript: {
      interpreter: 'C:\\Windows\\System32\\cscript.exe',
      inner: (file) => `"C:\\Windows\\System32\\cscript.exe" //NoLogo ${quoteCmdArg(file)}`,
    },
    ruby: { interpreter: 'C:\\Ruby\\ruby.exe', inner: (file) => `"C:\\Ruby\\ruby.exe" ${quoteCmdArg(file)}` },
    perl: { interpreter: 'p', inner: (file) => `"p" ${quoteCmdArg(file)}` },
    php: { interpreter: 'p', inner: (file) => `"p" ${quoteCmdArg(file)}` },
    lua: { interpreter: 'l', inner: (file) => `"l" ${quoteCmdArg(file)}` },
  };
  for (const [kind, { interpreter, inner }] of Object.entries(cases)) {
    const file = nasty(`run ${kind}.ext`);
    const launch = buildRunLaunch(kind, file, { interpreter, cmdPath: cmd });
    assert.equal(launch.exe, cmd, kind);
    // One outer pair of quotes under /s: cmd strips exactly that pair.
    assert.equal(launch.params, `/d /s /v:off /k "${inner(file)}"`, kind);
    assert.equal(launch.folder, dirname(file), kind);
  }
  // No CALL: it would double carets and expand % a second time.
  assert.doesNotMatch(buildRunLaunch('bat', nasty('a.bat'), { cmdPath: cmd }).params, /\bcall\b/i);
  // cmd expands %VAR% even inside quotes: such paths are refused, never run.
  for (const file of ['C:\\100%\\run.bat', 'C:\\proj\\x%TEMP%.py', 'C:\\proj\\%PATH%&calc&.ps1'])
    assert.throws(
      () => buildRunLaunch(runnerKindFor(file), file, { interpreter: 'C:\\i.exe', cmdPath: cmd }),
      { status: 400, message: messages['server.renommez_ce_script_pour_l_executer_depuis_le_studio'].fr },
      file,
    );
  assert.throws(() => buildRunLaunch('py', 'C:\\proj\\ok.py', { interpreter: 'C:\\50%\\py.exe', cmdPath: cmd }), {
    status: 400,
  });
});

// The real cmd.exe parses the command line, not CommandLineToArgvW: this test
// runs the exact launch, with /c instead of /k so the hidden console exits.
// The scripts only print a marker; nothing else runs and no window opens.
test(
  'the real cmd.exe keeps paths with spaces, &, ^, parentheses and unicode literal',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'prime-run-cmd-'));
    t.after(async () => {
      assert.equal(dirname(resolve(root)), resolve(tmpdir()));
      await rm(root, { recursive: true, force: true });
    });
    const folder = join(root, 'dossier é & (1); x^y !z');
    await mkdir(folder, { recursive: true });
    const env = process.env;
    const cmd = join(env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
    const scripts = [
      ['node', 'pro^be & (1)!.js', 'console.log("NODE-OK " + process.argv[1]);'],
      ['bat', 'ru^n & (1)!.bat', '@echo BAT-OK'],
      ['ps1', 'tâche & (1)!.ps1', 'Write-Output PS-OK'],
    ];
    for (const [kind, name, body] of scripts) {
      const file = join(folder, name);
      await writeFile(file, body);
      const interpreter = resolveRunnerInterpreter(kind, { env, nodePath: process.execPath });
      if (!interpreter) continue;
      const launch = buildRunLaunch(kind, file, { interpreter, cmdPath: cmd });
      const params = launch.params.replace(' /k ', ' /c ').replace(' -NoExit', '');
      const { stdout } = await promisify(execFile)(cmd, [params], {
        cwd: launch.folder,
        windowsVerbatimArguments: true,
        windowsHide: true,
        timeout: 30000,
      });
      const expected = { node: `NODE-OK ${file}`, bat: 'BAT-OK', ps1: 'PS-OK' }[kind];
      assert.equal(stdout.trim(), expected, kind);
    }
  },
);

test('interpreter resolution never executes anything and reports plain paths', () => {
  const env = { SystemRoot: 'C:\\Windows', PATH: 'C:\\Python;D:\\tools' };
  const exists = (path) => path === 'C:\\Python\\py.exe';
  assert.equal(
    resolveRunnerInterpreter('py', { env, exists }),
    'C:\\Python\\py.exe',
  );
  assert.equal(resolveRunnerInterpreter('py', { env, exists: () => false }), null);
  assert.equal(resolveRunnerInterpreter('ruby', { env, exists: () => false }), null);
  assert.equal(
    resolveRunnerInterpreter('node', { env, exists: () => false, nodePath: 'C:\\node\\node.exe' }),
    'C:\\node\\node.exe',
  );
  assert.equal(
    resolveRunnerInterpreter('bash', {
      env: { ...env, ProgramFiles: 'C:\\Program Files' },
      exists: (path) => path === 'C:\\Program Files\\Git\\bin\\bash.exe',
    }),
    'C:\\Program Files\\Git\\bin\\bash.exe',
  );
  assert.equal(
    findOnPath(['bash.exe'], { PATH: '' }, () => true),
    null,
  );
  for (const kind of ['bat', 'ps1', 'py', 'node', 'bash', 'cscript', 'ruby', 'perl', 'php', 'lua'])
    assert.ok(RUNNER_PROGRAM[kind]?.trim(), kind);
});

test('script runner validates before touching the helper and stays hidden itself', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'prime-run-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const script = join(root, 'tâche & ünï (1); $x.ps1');
  await writeFile(script, 'Write-Host hi');
  let calls = 0;
  const seen = [];
  const runner = createScriptRunner({
    platform: 'win32',
    nodePath: 'C:\\node\\node.exe',
    run: async (...args) => {
      calls++;
      seen.push(args);
      return { stdout: '{"ran":true}' };
    },
  });
  await assert.rejects(runner('relative.ps1'), { status: 400 });
  await assert.rejects(runner(join(root, 'missing.ps1')), { status: 404 });
  assert.equal(calls, 0);
  const windowsOnly = createScriptRunner({ platform: 'darwin', run: async () => ({ stdout: '' }) });
  const forbidden = await windowsOnly(script).then(
    () => null,
    (failure) => failure,
  );
  assert.ok(forbidden);
  assert.equal(forbidden.status, 404);
  assert.equal(forbidden.message, messages['server.execution_de_scripts_uniquement_sur_windows'].fr);
  await assert.rejects(runner(join(root, 'settings.reg').replace('settings.reg', 'x.reg')), {
    status: 404,
  });
  await writeFile(join(root, 'settings.reg'), 'x');
  const refused = await runner(join(root, 'settings.reg')).then(
    () => null,
    (failure) => failure,
  );
  assert.ok(refused);
  assert.equal(refused.status, 400);
  assert.equal(calls, 0);
  assert.deepEqual(await runner(script), { ran: true });
  assert.equal(calls, 1);
  const [exe, args, options] = seen[0];
  assert.match(exe, /powershell\.exe$/i);
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.ok(args.some((arg) => String(arg).endsWith('run-file.ps1')), 'hidden run helper');
  assert.equal(options.env.PRIME_STUDIO_RUN_FOLDER, root);
  assert.match(options.env.PRIME_STUDIO_RUN_EXE, /cmd\.exe$/i);
  assert.ok(options.env.PRIME_STUDIO_RUN_ARGS.includes(quoteCmdArg(script)));
  assert.ok(!args.some((arg) => String(arg).includes(script)), 'script path stays out of argv');
  assert.ok(!Object.values(options.env).some((value) => String(value).includes('-Command')));
});

test('script runner reports a missing interpreter and helper failures as 502', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'prime-run-missing-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const script = join(root, 'tool.py');
  await writeFile(script, 'print(1)');
  const runner = createScriptRunner({
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows', PATH: '' },
    exists: () => false,
    run: async () => ({ stdout: '{"ran":true}' }),
  });
  const missing = await runner(script).then(
    () => null,
    (failure) => failure,
  );
  assert.ok(missing);
  assert.equal(missing.status, 502);
  assert.match(missing.message, /Python/);
  const refused = createScriptRunner({
    platform: 'win32',
    nodePath: 'C:\\node\\node.exe',
    run: async () => ({ stdout: '{"missing":"node"}' }),
  });
  await writeFile(join(root, 'app.js'), '1');
  const viaHelper = await refused(join(root, 'app.js')).then(
    () => null,
    (failure) => failure,
  );
  assert.ok(viaHelper);
  assert.equal(viaHelper.status, 502);
  assert.match(viaHelper.message, /Node\.js/);
  const bad = createScriptRunner({
    platform: 'win32',
    nodePath: 'C:\\node\\node.exe',
    run: async () => {
      await delay(20);
      return { stdout: 'not json' };
    },
  });
  const app = join(root, 'app.js');
  await writeFile(app, '1');
  const [first, second] = await Promise.allSettled([bad(app), bad(app)]);
  assert.equal(first.status, 'rejected');
  assert.equal(second.status, 'rejected');
  assert.equal(first.reason.status, 502);
  assert.ok(first.reason.message?.length > 20);
});

test('run helper script opens a visible console from data only', async () => {
  const script = await readFile(new URL('../scripts/run-file.ps1', import.meta.url), 'utf8');
  assert.match(script, /ShellExecuteW/);
  assert.match(script, /, 1\)/);
  assert.match(script, /Test-Path -LiteralPath/);
  assert.ok(script.includes('$env:PRIME_STUDIO_RUN_EXE'));
  assert.ok(script.includes('$env:PRIME_STUDIO_RUN_ARGS'));
  assert.ok(script.includes('$env:PRIME_STUDIO_RUN_FOLDER'));
  assert.ok(script.includes('{"ran":true}'));
  for (const risky of ['Invoke-Expression', 'Invoke-Command', '-Command', 'WhatIf', 'dry', 'DryRun'])
    assert.ok(!script.includes(risky), risky);
  const opener = await readFile(new URL('../scripts/open-file.ps1', import.meta.url), 'utf8');
  assert.ok(opener.includes('$env:PRIME_STUDIO_FILE_TEXT'));
  assert.match(opener, /SE_ERR_NOASSOC/);
});

test('run translations, LAN allowlist and packaged helper stay in sync', async () => {
  for (const key of [
    'ui.executer',
    'ui.executer_sur_le_pc',
    'ui.executer_dans_une_console_du_pc',
    'ui.executer_ce_script',
    'ui.le_script_va_s_executer_sur_votre_pc_dans_une_fenetre_visible',
    'ui.execution_sur_le_pc',
    'ui.execution_demandee_sur_le_pc',
    'server.ce_script_ne_peut_pas_etre_execute_depuis_le_studio',
    'server.execution_de_scripts_uniquement_sur_windows',
    'server.interpreteur_introuvable_pour_executer_ce_script',
    'server.le_pc_n_a_pas_pu_executer_ce_script',
  ]) {
    assert.ok(messages[key]?.fr?.trim(), key);
    assert.ok(messages[key]?.en?.trim(), key);
  }
  assert.ok(messages['server.interpreteur_introuvable_pour_executer_ce_script'].fr.includes('{value1}'));
  assert.ok(messages['server.interpreteur_introuvable_pour_executer_ce_script'].en.includes('{value1}'));
  const lan = await readFile(new URL('../lib/lan.mjs', import.meta.url), 'utf8');
  assert.ok(lan.includes("'/api/project-files/run'"));
  assert.ok(desktopRuntimeScripts.includes('run-file.ps1'));
  const inspector = await readFile(new URL('../public/inspector.js', import.meta.url), 'utf8');
  assert.match(inspector, /\/api\/project-files\/run/);
  assert.match(inspector, /ui\.executer_ce_script/);
  assert.match(inspector, /showModal/);
});

function fakeRuntime() {
  return {
    async getStatus() {
      return { available: true, version: 'fixture', nodeVersion: process.versions.node };
    },
    async getModels() {
      return { models: [], default: {} };
    },
    async start() {
      throw new Error('no runs in this fixture');
    },
    async close() {},
  };
}

function httpRequest(port, path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((done, reject) => {
    const payload = body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined;
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(payload !== undefined ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('end', () => {
          let json;
          try {
            json = JSON.parse(text);
          } catch {}
          done({ status: response.statusCode, json, text, headers: response.headers });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

async function fixture(t, extraOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'prime-run-server-'));
  const cwd = join(root, 'project');
  await mkdir(cwd, { recursive: true });
  const app = createApp({
    agentHome: join(root, 'agent'),
    sessionDir: join(root, 'sessions'),
    dataDir: join(root, 'data'),
    initialCwd: cwd,
    runtime: fakeRuntime(),
    ...extraOptions,
  });
  await mkdir(join(root, 'sessions'), { recursive: true });
  await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
  const port = app.server.address().port;
  t.after(async () => {
    await app.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { app, api: (path, options) => httpRequest(port, path, options), cwd, root };
}

test('project run route executes registered scripts and refuses the rest', async (t) => {
  const ran = [];
  const f = await fixture(t, {
    runFile: async (path) => {
      runnerKindFor(path);
      ran.push(path);
      return { ran: true };
    },
  });
  await writeFile(join(f.cwd, 'task.ps1'), 'Write-Host hi');
  await writeFile(join(f.cwd, 'app.exe'), 'MZ');
  await mkdir(join(f.cwd, 'folder'), { recursive: true });
  const ok = await f.api('/api/project-files/run', {
    method: 'POST',
    body: { cwd: f.cwd, path: 'task.ps1' },
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { ran: true });
  assert.deepEqual(ran, [join(f.cwd, 'task.ps1')]);
  assert.equal(
    (await f.api('/api/project-files/run', { method: 'POST', body: { cwd: f.cwd, path: 'app.exe' } })).status,
    400,
  );
  assert.equal(
    (await f.api('/api/project-files/run', { method: 'POST', body: { cwd: f.cwd, path: '../outside.ps1' } }))
      .status,
    403,
  );
  assert.equal(
    (await f.api('/api/project-files/run', { method: 'POST', body: { cwd: f.cwd, path: 'folder' } })).status,
    400,
  );
  assert.equal(
    (await f.api('/api/project-files/run', { method: 'POST', body: { cwd: f.cwd, path: 'missing.ps1' } }))
      .status,
    404,
  );
  assert.deepEqual(ran, [join(f.cwd, 'task.ps1')]);
});

test('project run route surfaces runner failures as 502', async (t) => {
  const f = await fixture(t, {
    runFile: async () => {
      const error = new Error('nope');
      error.status = 502;
      throw error;
    },
  });
  await writeFile(join(f.cwd, 'task.ps1'), 'x');
  assert.equal(
    (await f.api('/api/project-files/run', { method: 'POST', body: { cwd: f.cwd, path: 'task.ps1' } })).status,
    502,
  );
});

test('run route is allowed in LAN full control and refused in read-only mode', async (t) => {
  const ACCESS_CODE = '12345678';
  for (const readOnly of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), 'prime-run-lan-'));
    const cwd = join(root, 'project');
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, 'task.ps1'), 'x');
    const ran = [];
    const app = createApp({
      agentHome: join(root, 'agent'),
      sessionDir: join(root, 'sessions'),
      dataDir: join(root, 'data'),
      initialCwd: cwd,
      runtime: fakeRuntime(),
      runFile: async (path) => {
        ran.push(path);
        return { ran: true };
      },
    });
    await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
    const upstreamPort = app.server.address().port;
    const salt = 'f'.repeat(32);
    const gateway = createLanGateway({
      host: '127.0.0.1',
      upstreamPort,
      config: { salt, codeHash: hashAccessCode(ACCESS_CODE, salt), readOnly },
    });
    await new Promise((done) => gateway.listen(0, '127.0.0.1', done));
    const port = gateway.address().port;
    t.after(async () => {
      gateway.closeAllConnections();
      await new Promise((done, reject) => gateway.close((error) => (error ? reject(error) : done())));
      await app.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    const login = await httpRequest(port, '/lan/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: ACCESS_CODE }).toString(),
    });
    assert.equal(login.status, 303, login.text);
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const response = await httpRequest(port, '/api/project-files/run', {
      method: 'POST',
      headers: { Cookie: cookie, Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' },
      body: { cwd, path: 'task.ps1' },
    });
    assert.equal(response.status, readOnly ? 405 : 200, response.text);
    assert.deepEqual(ran, readOnly ? [] : [join(cwd, 'task.ps1')]);
  }
});
