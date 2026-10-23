import { formatMessage as tr } from '../public/i18n-core.js';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { powershellLaunch } from './powershell-launch.mjs';
import { createPendingJobs } from './pending-job.mjs';
import { HttpError } from './store.mjs';

const helper = fileURLToPath(new URL('../scripts/run-file.ps1', import.meta.url));
// Kind -> runnable extensions. reg/inf open in Notepad but never run;
// psm1 modules, wsh host settings and extensionless files are not runnable.
const RUNNER_EXTENSIONS = {
  bat: ['bat', 'cmd'],
  ps1: ['ps1'],
  py: ['py', 'pyw'],
  node: ['js', 'mjs', 'cjs'],
  bash: ['sh', 'bash'],
  cscript: ['vbs', 'vbe', 'wsf', 'jse'],
  ruby: ['rb'],
  perl: ['pl'],
  php: ['php'],
  lua: ['lua'],
};
// Proper nouns: identical in French and English.
export const RUNNER_PROGRAM = {
  bat: 'cmd',
  ps1: 'Windows PowerShell',
  py: 'Python',
  node: 'Node.js',
  bash: 'Git Bash',
  cscript: 'Windows Script Host',
  ruby: 'Ruby',
  perl: 'Perl',
  php: 'PHP',
  lua: 'Lua',
};
export const RUNNABLE_SCRIPT_EXTENSIONS = new Set(Object.values(RUNNER_EXTENSIONS).flat());
export function runnerKindFor(path) {
  const extension = extname(path).slice(1).toLowerCase();
  for (const [kind, extensions] of Object.entries(RUNNER_EXTENSIONS))
    if (extensions.includes(extension)) return kind;
  throw new HttpError(400, tr('server.ce_script_ne_peut_pas_etre_execute_depuis_le_studio'));
}
export function isRunnableScript(path) {
  try {
    runnerKindFor(path);
    return true;
  } catch {
    return false;
  }
}
// CommandLineToArgvW quoting, for the interpreter's own argument parsing (cmd
// passes the arguments through unchanged). Windows file names cannot contain
// a double quote, so real paths only ever hit the wrapping.
export function quoteCmdArg(value) {
  return `"${String(value)
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\+)$/, '$1$1')}"`;
}
function systemBinary(env, ...parts) {
  return join(env.SystemRoot || 'C:\\Windows', 'System32', ...parts);
}
export function findOnPath(names, env = process.env, exists = existsSync) {
  for (const folder of String(env.PATH || '').split(';')) {
    if (!folder) continue;
    for (const name of names) {
      const candidate = join(folder, name);
      try {
        if (exists(candidate)) return candidate;
      } catch {
        /* Unreadable folder: keep searching. */
      }
    }
  }
  return null;
}
// Resolve the interpreter without running anything: PATH lookup and
// well-known install folders only. Returns null when missing so the caller
// reports a translated error instead of launching.
export function resolveRunnerInterpreter(
  kind,
  { env = process.env, exists = existsSync, nodePath = process.execPath } = {},
) {
  if (kind === 'bat') return systemBinary(env, 'cmd.exe');
  if (kind === 'ps1') {
    const powershell = systemBinary(env, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    try {
      if (exists(powershell)) return powershell;
    } catch {
      /* Fall through to null. */
    }
    return null;
  }
  if (kind === 'cscript') return systemBinary(env, 'cscript.exe');
  if (kind === 'node') return nodePath || null;
  if (kind === 'py')
    return (
      findOnPath(['py.exe', 'python.exe'], env, exists) ||
      (() => {
        const launcher = join(env.SystemRoot || 'C:\\Windows', 'py.exe');
        try {
          return exists(launcher) ? launcher : null;
        } catch {
          return null;
        }
      })()
    );
  if (kind === 'bash') {
    const found = findOnPath(['bash.exe'], env, exists);
    if (found) return found;
    for (const root of [env.ProgramFiles, env['ProgramFiles(x86)']]) {
      if (!root) continue;
      for (const relative of ['Git\\bin\\bash.exe', 'Git\\usr\\bin\\bash.exe']) {
        const candidate = join(root, relative);
        try {
          if (exists(candidate)) return candidate;
        } catch {
          /* Keep searching. */
        }
      }
    }
    return null;
  }
  const direct = { ruby: 'ruby.exe', perl: 'perl.exe', php: 'php.exe', lua: 'lua.exe' }[kind];
  return direct ? findOnPath([direct], env, exists) : null;
}
// One visible console window that stays open after the script ends, working
// directory = the script folder. cmd.exe hosts every kind (ps1 keeps its own
// -NoExit). Its command line is parsed by cmd itself, so:
// - /s with a single outer pair of quotes: cmd strips exactly that pair and
//   keeps the inner quoting, so spaces, &, ^ and parentheses stay literal;
// - /v:off: ! stays literal even when delayed expansion is on by default;
// - /d: no AutoRun command runs before the script;
// - % is expanded by cmd even inside quotes and could inject commands, so a
//   command line containing % is refused (the user renames the file);
// - no CALL: it doubles carets and expands % a second time. A batch file run
//   from the /k command line returns to the prompt anyway.
// test/run-file.test.mjs checks this against the real cmd.exe on Windows.
export function buildRunLaunch(kind, file, { interpreter, cmdPath } = {}) {
  const inner =
    {
      bat: quoteCmdArg(file),
      ps1: `${quoteCmdArg(interpreter)} -NoExit -ExecutionPolicy Bypass -File ${quoteCmdArg(file)}`,
      cscript: `${quoteCmdArg(interpreter)} //NoLogo ${quoteCmdArg(file)}`,
    }[kind] || `${quoteCmdArg(interpreter)} ${quoteCmdArg(file)}`;
  if (inner.includes('%'))
    throw new HttpError(400, tr('server.renommez_ce_script_pour_l_executer_depuis_le_studio'));
  return { exe: cmdPath, params: `/d /s /v:off /k "${inner}"`, folder: dirname(file) };
}

export function createScriptRunner({
  platform = process.platform,
  run = promisify(execFile),
  env = process.env,
  nodePath = process.execPath,
  exists = existsSync,
} = {}) {
  const pending = createPendingJobs();
  return async (path) => {
    if (typeof path !== 'string' || !isAbsolute(path) || /[\x00-\x1f]/.test(path))
      throw new HttpError(400, tr('server.fichier_invalide'));
    if (platform !== 'win32')
      throw new HttpError(404, tr('server.execution_de_scripts_uniquement_sur_windows'));
    if (!(await stat(path).catch(() => null))?.isFile())
      throw new HttpError(404, tr('server.fichier_introuvable'));
    const kind = runnerKindFor(path),
      key = path.toLowerCase();
    return pending(key, async () => {
      try {
        const interpreter = resolveRunnerInterpreter(kind, { env, exists, nodePath });
        if (!interpreter)
          throw new HttpError(
            502,
            tr('server.interpreteur_introuvable_pour_executer_ce_script', {
              value1: RUNNER_PROGRAM[kind],
            }),
          );
        const launch = buildRunLaunch(kind, path, {
          interpreter,
          cmdPath: systemBinary(env, 'cmd.exe'),
        });
        const { exe, args, options } = powershellLaunch(helper, env, {
          PRIME_STUDIO_RUN_EXE: launch.exe,
          PRIME_STUDIO_RUN_ARGS: launch.params,
          PRIME_STUDIO_RUN_FOLDER: launch.folder,
        });
        const { stdout } = await run(exe, args, options);
        const result = JSON.parse(stdout.trim());
        if (result.ran !== true) {
          if (result.missing)
            throw new HttpError(
              502,
              tr('server.interpreteur_introuvable_pour_executer_ce_script', {
                value1: RUNNER_PROGRAM[result.missing] || result.missing,
              }),
            );
          throw new Error('Script launch was not accepted');
        }
        return { ran: true };
      } catch (error) {
        if (error?.status) throw error;
        throw new HttpError(502, tr('server.le_pc_n_a_pas_pu_executer_ce_script'));
      }
    });
  };
}
export const runFile = createScriptRunner();
