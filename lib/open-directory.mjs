import { formatMessage as tr } from '../public/i18n-core.js';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import { powershellLaunch } from './powershell-launch.mjs';
import { createPendingJobs } from './pending-job.mjs';
import { HttpError, validateDirectory } from './store.mjs';
import { LINE_SUFFIX } from './project-files.mjs';

const WINDOWS_HELPER = fileURLToPath(new URL('../scripts/open-directory.ps1', import.meta.url));

// Native reveal is an explicit desktop action, not a project-content read.
// Keep the project sandbox on preview/download; only validate the OS path here.
export async function directoryForReference({ cwd, path = '', reference, basePath = '' } = {}) {
  const invalid = () => new HttpError(400, tr('server.reference_de_fichier_invalide'));
  const check = (value) => typeof value === 'string' && value.length <= 4096 && !/[\x00-\x1f]/.test(value);
  if (!check(path) || !check(basePath) || (cwd !== undefined && !check(cwd))) throw invalid();
  if (reference !== undefined && (!check(reference) || !reference.trim())) throw invalid();
  if (reference !== undefined && path) throw invalid();
  let input = reference === undefined ? path : reference.trim();
  let literal = null;
  if (/^file:/i.test(input)) {
    try {
      input = fileURLToPath(new URL(input));
    } catch {
      throw invalid();
    }
  } else if (reference !== undefined) {
    literal = input;
    try {
      input = decodeURIComponent(input);
    } catch {
      /* A literal percent sign can be part of a native filename. */
    }
  }
  if (!check(input)) throw invalid();
  if (process.platform === 'win32' && /^\/[a-z]:[\\/]/i.test(input)) input = input.slice(1);
  if (/^[a-z][\w+.-]*:/i.test(input) && !/^[a-z]:[\\/]/i.test(input)) throw invalid();
  if (!isAbsolute(input) && (!cwd || !isAbsolute(cwd))) throw invalid();
  const base = basePath ? dirname(basePath) : '';
  let absolute = resolve(cwd || '', base, literal ?? input);
  let info = await stat(absolute).catch(() => null);
  if (!info && literal !== null && literal !== input) {
    absolute = resolve(cwd || '', base, input);
    info = await stat(absolute).catch(() => null);
  }
  if (!info && reference !== undefined) {
    // Prefer an existing literal name; only strip editor line/column suffixes on a miss.
    const stripped = input.replace(LINE_SUFFIX, '');
    if (stripped !== input) {
      absolute = resolve(cwd || '', base, stripped);
      info = await stat(absolute).catch(() => null);
    }
  }
  if (!info) throw new HttpError(404, tr('server.ce_dossier_est_introuvable_ou_inaccessible'));
  if (!info.isDirectory() && !(reference !== undefined && info.isFile()))
    throw new HttpError(400, tr('server.choisissez_un_dossier'));
  const folder = info.isDirectory() ? absolute : dirname(absolute);
  return realpath(folder).catch(() => {
    throw new HttpError(404, tr('server.ce_dossier_est_introuvable_ou_inaccessible'));
  });
}

export function createDirectoryOpener({
  platform = process.platform,
  run = promisify(execFile),
  env = process.env,
} = {}) {
  const pending = createPendingJobs();
  async function launch(path) {
    try {
      if (platform === 'win32') {
        // Explorer must be visible and in the foreground, not just launched.
        const { exe, args, options } = powershellLaunch(WINDOWS_HELPER, env, {
          PRIME_STUDIO_OPEN_DIRECTORY: path,
        });
        const { stdout } = await run(exe, args, options);
        const result = JSON.parse(stdout.trim());
        if (result.opened !== true || result.visible !== true || result.foreground !== true)
          throw new Error('Explorer is not in the foreground');
      } else {
        await run(platform === 'darwin' ? 'open' : 'xdg-open', [path], { shell: false, timeout: 15000, env });
      }
      return { opened: true };
    } catch {
      throw new HttpError(
        502,
        platform === 'win32'
          ? tr('server.impossible_d_afficher_ce_dossier_dans_l_explorateur_du_pc_reessa')
          : tr('server.impossible_d_ouvrir_ce_dossier_sur_le_pc_reessayez'),
      );
    }
  }
  return async (cwd) => {
    const path = await validateDirectory(cwd),
      key = platform === 'win32' ? path.toLowerCase() : path;
    return pending(key, () => launch(path));
  };
}

export const openDirectory = createDirectoryOpener();
