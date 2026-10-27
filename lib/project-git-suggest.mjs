// Agent-proposed commit message for the Git panel (Files tab).
// Builds a staged-like diff for exactly the checked paths (bounded, binary
// listed by name only), reads the last commit subjects for the language hint,
// then asks ONE model for a concise conventional message. No tools, no
// session file, nothing persisted. Model credentials stay in the worker child
// process; this module only shapes the prompt and parses the reply.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HttpError } from './store.mjs';
import { formatMessage as tr } from '../public/i18n-core.js';

const exec = promisify(execFile);

export const SUGGEST_DIFF_LIMIT = 60 * 1024;
export const SUGGEST_TIMEOUT_MS = 60_000;

export function parseModelSelector(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const slash = trimmed.indexOf('/');
  if (slash <= 0) return null;
  const provider = trimmed.slice(0, slash).trim();
  const id = trimmed.slice(slash + 1).trim();
  if (!provider || !id) return null;
  return { provider, id };
}

export function detectSuggestLanguage(subjects) {
  const list = Array.isArray(subjects) ? subjects.filter((s) => typeof s === 'string' && s.trim()) : [];
  if (!list.length) return 'fr';
  let fr = 0;
  for (const subject of list) {
    if (/[àâäéèêëîïôöùûüç]/i.test(subject)) fr++;
    else if (/\b(le|la|les|des|une?|ajoute?r?|corrige?r?|mise|jour|supprime?r?|cr[eé]e?r?|modifie?r?|fusion|nettoyage|correctif|fonctionnalit[eé])\b/i.test(subject)) fr++;
  }
  return fr * 2 >= list.length ? 'fr' : 'en';
}

export function buildSuggestPrompt({ diffText, truncated, binaries, subjects, language }) {
  const lang = language === 'en' ? 'en' : 'fr';
  const recent = (Array.isArray(subjects) ? subjects : []).filter(Boolean).slice(0, 10);
  const binaryNote =
    Array.isArray(binaries) && binaries.length
      ? `\nBinary or unrenderable files (name only):\n${binaries.map((name) => `- ${name}`).join('\n')}\n`
      : '';
  const truncNote = truncated ? '\n[Note: diff truncated to 60 KB total. Propose from what is visible.]\n' : '';
  const system =
    lang === 'en'
      ? 'You write concise conventional commit messages. Reply with the message only, no quotes, no em dashes.'
      : 'Tu rédiges des messages de commit conventionnels et concis. Réponds avec le seul message, sans guillemets, sans tiret cadratin.';
  const user =
    lang === 'en'
      ? `Write ONE conventional commit message for the changes below.\nRules: subject line <= 72 chars, lowercase type prefix (feat, fix, chore, docs, refactor, test), optional short body (max 2 lines). Language: English.\n${recent.length ? `Recent subjects for style:\n${recent.map((s) => `- ${s}`).join('\n')}\n` : ''}${binaryNote}${truncNote}\nDiff:\n${diffText || '(no textual diff)'}`
      : `Rédige UN message de commit conventionnel pour les changements ci-dessous.\nRègles : ligne de sujet <= 72 caractères, préfixe de type en minuscules (feat, fix, chore, docs, refactor, test), corps court optionnel (2 lignes max). Langue : français.\n${recent.length ? `Sujets récents pour le style :\n${recent.map((s) => `- ${s}`).join('\n')}\n` : ''}${binaryNote}${truncNote}\nDiff :\n${diffText || '(aucun diff textuel)'}`;
  return { system, user };
}

export function cleanSuggestMessage(text) {
  let value = String(text || '').trim();
  if (!value) return '';
  // Strip code fences when the model wraps its answer.
  const fence = /^```[\w-]*\n([\s\S]*?)\n```\s*$/.exec(value);
  if (fence) value = fence[1].trim();
  value = value.replace(/^["'\u00ab\u00bb]+|["'\u00ab\u00bb]+$/g, '').trim();
  if (!value) return '';
  const lines = value.split('\n').map((line) => line.replace(/\s+$/g, ''));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  if (!lines.length) return '';
  // Subject <= 72 chars, no em dashes.
  lines[0] = lines[0].replaceAll('\u2014', '-').slice(0, 72).trimEnd();
  // Keep an optional short body (drop excess blank lines, cap length).
  const body = lines.slice(1).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const cappedBody = body ? body.slice(0, 500).trimEnd() : '';
  const message = cappedBody ? `${lines[0]}\n\n${cappedBody}` : lines[0];
  return message.slice(0, 1200);
}

export async function readRecentSubjects(root, run) {
  const execGit =
    run ||
    ((args) =>
      exec('git', args, {
        cwd: root,
        windowsHide: true,
        shell: false,
        timeout: 10_000,
        maxBuffer: 1 << 20,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
      }).then((result) => String(result.stdout)));
  try {
    const output = await execGit(['log', '--format=%s', '-n', '10']);
    return String(output || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 10);
  } catch {
    return [];
  }
}

export async function collectSuggestDiff(root, paths, filesFor) {
  const api = filesFor(root);
  const wanted = [...new Set(paths)];
  let total = 0;
  const chunks = [];
  const binaries = [];
  let truncated = false;
  for (const path of wanted) {
    let entry;
    try {
      entry = await api.diff(root, path);
    } catch {
      binaries.push(path);
      continue;
    }
    const text = typeof entry?.text === 'string' ? entry.text : '';
    if (!text.trim()) {
      binaries.push(path);
      const placeholder = `File ${path}: binary or empty diff, listed by name only.\n`;
      if (total + placeholder.length > SUGGEST_DIFF_LIMIT) {
        truncated = true;
        break;
      }
      chunks.push(placeholder);
      total += placeholder.length;
      continue;
    }
    const header = `diff -- ${path}\n`;
    const piece = header + text + (text.endsWith('\n') ? '' : '\n');
    if (total + piece.length > SUGGEST_DIFF_LIMIT) {
      const room = SUGGEST_DIFF_LIMIT - total;
      if (room > header.length + 200) chunks.push(piece.slice(0, room));
      truncated = true;
      total = SUGGEST_DIFF_LIMIT;
      break;
    }
    chunks.push(piece);
    total += piece.length;
  }
  let diffText = chunks.join('\n');
  if (truncated) diffText += '\n... [diff truncated to 60 KB total]\n';
  return { diffText, truncated, binaries };
}

export function createProjectGitSuggest({ store, filesFor, resolveProject }) {
  const findProject =
    typeof resolveProject === 'function' ? resolveProject : ((cwd) => store.findProject(cwd));
  const resolveCwd = async (cwd) => (await findProject(cwd)).cwd;
  async function suggestMessage(cwd, { paths } = {}, injected = {}) {
    const project = await findProject(cwd);
    const root = project.cwd;
    const wanted = Array.isArray(paths) ? [...new Set(paths.filter((p) => typeof p === 'string' && p))] : [];
    if (!wanted.length) throw new HttpError(400, tr('git.panel_commit_paths'));
    const changes = await filesFor(root).changes(root);
    if (!changes.git) throw new HttpError(409, tr('git.align_not_repo'));
    const listed = new Set(changes.entries.map((entry) => entry.path));
    if (!wanted.every((path) => listed.has(path)))
      throw new HttpError(400, tr('git.panel_commit_paths'));
    const collect = injected.collectDiff || ((r, p) => collectSuggestDiff(r, p, filesFor));
    const bundle = await collect(root, wanted);
    if (!bundle.diffText.trim() && !bundle.binaries.length)
      throw new HttpError(400, tr('git.panel_commit_paths'));
    const subjects = injected.subjects || (await readRecentSubjects(root, injected.runGit));
    const language = detectSuggestLanguage(subjects);
    const { system, user } = buildSuggestPrompt({
      diffText: bundle.diffText,
      truncated: bundle.truncated,
      binaries: bundle.binaries,
      subjects,
      language,
    });
    const complete = injected.complete;
    if (typeof complete !== 'function') throw new HttpError(500, tr('git.suggest_failed'));
    let text;
    try {
      text = await complete({ system, user, language, subjects });
    } catch (error) {
      if (error?.status) throw error;
      throw new HttpError(502, tr('git.suggest_failed'));
    }
    const message = cleanSuggestMessage(text);
    if (!message) throw new HttpError(502, tr('git.suggest_failed'));
    return { message };
  }

  return { suggestMessage, resolveCwd };
}
