import { formatMessage as tr } from '../public/i18n-core.js';
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { extname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { powershellLaunch } from './powershell-launch.mjs';
import { createPendingJobs } from './pending-job.mjs';
import { HttpError } from './store.mjs';

const helper = fileURLToPath(new URL('../scripts/open-file.ps1', import.meta.url));
// Ouvrir with the associated Windows application: documents, images, media,
// archives, web pages and code or data files whose default handler does not
// execute them (a .ts file may belong to a video player: that stays the
// user's Windows choice).
export const DOCUMENT_EXTENSIONS = new Set(
  'txt md markdown mdown mkd json jsonl log csv tsv pdf png jpg jpeg gif webp bmp tif tiff ico svg doc docx odt rtf xls xlsx ods ppt pptx odp zip 7z tar gz mp3 wav flac mp4 webm mov'.split(
    ' ',
  ),
);
export const ASSOCIATED_CODE_EXTENSIONS = new Set(
  'html htm xhtml xml css scss less ts tsx jsx jsonc yaml yml toml ini conf cfg sql c h cpp hpp cs java kt go rs swift tex'.split(
    ' ',
  ),
);
// Ouvrir in Notepad: files Windows (or a common installer such as Python,
// Node, Git Bash or Ruby) would EXECUTE when opened. Runnable scripts also
// feed the Exécuter button (see lib/run-file.mjs); reg/inf stay
// editor-only on purpose.
export const EDITOR_EXTENSIONS = new Set(
  'js mjs cjs jse vbs vbe wsf wsh ps1 psm1 bat cmd sh bash py pyw rb pl php lua reg inf'.split(' '),
);
// When no application is associated (Shell error 31), the helper falls back
// to Notepad for every text-like type instead of failing. Binary documents
// (pdf, images, office files, archives, media) keep failing.
export const TEXT_LIKE_EXTENSIONS = new Set([
  ...EDITOR_EXTENSIONS,
  ...'txt md markdown mdown mkd json jsonl log csv tsv svg html htm xhtml xml css scss less ts tsx jsx jsonc yaml yml toml ini conf cfg sql c h cpp hpp cs java kt go rs swift tex'.split(
    ' ',
  ),
]);
export function fileLaunchMode(path) {
  const extension = extname(path).slice(1).toLowerCase();
  if (EDITOR_EXTENSIONS.has(extension) || !extension) return 'editor';
  if (DOCUMENT_EXTENSIONS.has(extension) || ASSOCIATED_CODE_EXTENSIONS.has(extension)) return 'associated';
  throw new HttpError(400, tr('server.ce_type_de_fichier_ne_peut_pas_etre_ouvert_depuis_le_studio'));
}
export function isTextLikeFile(path) {
  return TEXT_LIKE_EXTENSIONS.has(extname(path).slice(1).toLowerCase());
}

export function createFileOpener({
  platform = process.platform,
  run = promisify(execFile),
  env = process.env,
} = {}) {
  const pending = createPendingJobs();
  return async (path) => {
    if (typeof path !== 'string' || !isAbsolute(path) || /[\x00-\x1f]/.test(path))
      throw new HttpError(400, tr('server.fichier_invalide'));
    if (!(await stat(path).catch(() => null))?.isFile())
      throw new HttpError(404, tr('server.fichier_introuvable'));
    const mode = fileLaunchMode(path),
      key = platform === 'win32' ? path.toLowerCase() : path;
    return pending(key, async () => {
      try {
        if (platform === 'win32') {
          const { exe, args, options } = powershellLaunch(helper, env, {
            PRIME_STUDIO_OPEN_FILE: path,
            PRIME_STUDIO_FILE_MODE: mode,
            PRIME_STUDIO_FILE_TEXT: isTextLikeFile(path) ? '1' : '0',
          });
          const { stdout } = await run(exe, args, options);
          if (JSON.parse(stdout.trim()).opened !== true) throw new Error('File opening was not accepted');
        } else {
          if (mode === 'editor') throw new Error('Text editor not configured');
          await run(platform === 'darwin' ? 'open' : 'xdg-open', [path], {
            shell: false,
            timeout: 15000,
            env,
          });
        }
        return { opened: true };
      } catch {
        throw new HttpError(
          502,
          tr('server.le_pc_n_a_pas_pu_ouvrir_ce_fichier_verifiez_qu_une_application_e'),
        );
      }
    });
  };
}
export const openFile = createFileOpener();
