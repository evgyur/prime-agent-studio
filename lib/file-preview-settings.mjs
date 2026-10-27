import { formatMessage as tr } from '../public/i18n-core.js';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { HttpError } from './store.mjs';

// Global preview preference: conversation-linked files outside the project.
// Enabled by default. Persisted in the Studio data dir (machine-local).
export const FILE_PREVIEW_SETTINGS_FILE = 'file-preview-settings.json';

function defaults() {
  return { allowOutsideProject: true };
}

function normalize(value) {
  if (value && typeof value === 'object' && typeof value.allowOutsideProject === 'boolean')
    return { allowOutsideProject: value.allowOutsideProject };
  return { allowOutsideProject: false };
}

export function validateFilePreviewSettingsPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new HttpError(400, tr('server.demande_invalide'));
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'allowOutsideProject' || keys[0] === '__proto__')
    throw new HttpError(400, tr('server.demande_invalide'));
  if (typeof body.allowOutsideProject !== 'boolean') throw new HttpError(400, tr('server.demande_invalide'));
  return { allowOutsideProject: body.allowOutsideProject };
}

export function createFilePreviewSettings({ dataDir } = {}) {
  const file = dataDir ? join(dataDir, FILE_PREVIEW_SETTINGS_FILE) : null;
  let writes = Promise.resolve();

  async function read() {
    if (!file) return defaults();
    try {
      return normalize(JSON.parse(await readFile(file, 'utf8')));
    } catch (error) {
      // Only a missing preference uses the enabled default. A damaged or
      // unreadable saved setting must not silently restore outside access.
      return error.code === 'ENOENT' ? defaults() : { allowOutsideProject: false };
    }
  }

  return {
    file,
    async get() {
      await writes.catch(() => {});
      return read();
    },
    async set(patch) {
      const next = validateFilePreviewSettingsPatch(patch);
      const operation = writes
        .catch(() => {})
        .then(async () => {
          if (!file) return { ...next };
          await mkdir(dirname(file), { recursive: true });
          const temporary = `${file}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
          try {
            await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
            await rename(temporary, file);
          } finally {
            await rm(temporary, { force: true });
          }
          return { ...next };
        });
      writes = operation;
      return operation;
    },
  };
}
