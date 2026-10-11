import { open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { formatMessage as tr } from '../public/i18n-core.js';
import { HttpError } from './store.mjs';
import {
  hasNativeLeadingCommand,
  isSoleSingleSkillCommand,
  parseInlineSkills,
  parseMultiSkillCommand,
} from './commands.mjs';

// Engine parity (packages/coding-agent/src/utils/frontmatter.ts + agent-session.ts):
// normalize newlines, split leading --- frontmatter, trim body, then
// <skill name="..." location="...">\nReferences are relative to <dir>.\n\n<body>\n</skill>
function stripFrontmatter(content) {
  const normalized = String(content || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  if (!normalized.startsWith('---')) return normalized;
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) return normalized;
  return normalized.slice(end + 4).trim();
}

export function skillBlockFor({ name, filePath, body }) {
  const baseDir = dirname(filePath);
  const trimmed = String(body || '').trim();
  return `<skill name="${name}" location="${filePath}">\nReferences are relative to ${baseDir}.\n\n${trimmed}\n</skill>`;
}

function lookupSkill(catalog, name) {
  const wanted = `skill:${name}`;
  return (catalog?.commands || []).find((item) => item.name === wanted && item.source === 'skill');
}

// Expand 2+ leading /skill:name tokens the SAME way the engine expands one:
// identical block format, same SKILL.md files from the catalog (engine precedence),
// frontmatter stripped like the engine. Returns null when not a multi-skill message.
// Single-skill messages stay engine expanded to avoid any duplicate expansion.
async function readSkill(path, _encoding, maxChars) {
  const handle = await open(path, 'r');
  try {
    // UTF-8 needs at most four bytes per character. Read one extra byte to
    // detect growth too, without loading an arbitrarily large local file.
    const limit = maxChars * 4;
    if ((await handle.stat()).size > limit) throw new HttpError(400, tr('server.skills_trop_volumineux'));
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new HttpError(400, tr('server.skills_trop_volumineux'));
    return buffer.subarray(0, length).toString('utf8');
  } finally {
    await handle.close();
  }
}

// Read each named SKILL.md once (engine precedence via the catalog) and reuse
// the engine-identical block for every occurrence. Shared by both expansion paths.
// Count literal text and each unique block during loading. Repeated occurrences
// are bounded below before concatenation, without rejecting a valid exact limit.
async function loadSkillBlocks(names, catalog, { read, maxChars, startTotal = 0 }) {
  const blocks = new Map();
  let total = startTotal;
  if (total > maxChars) throw new HttpError(400, tr('server.skills_trop_volumineux'));
  for (const name of names) {
    if (blocks.has(name)) continue;
    const entry = lookupSkill(catalog, name);
    if (!entry?.sourceInfo?.path)
      throw new HttpError(400, tr('server.skill_inconnu_dans_ce_projet', { value1: name }));
    let raw;
    try {
      raw = await read(entry.sourceInfo.path, 'utf8', maxChars);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, tr('server.skill_inconnu_dans_ce_projet', { value1: name }));
    }
    if (raw.length > maxChars) throw new HttpError(400, tr('server.skills_trop_volumineux'));
    const block = skillBlockFor({ name, filePath: entry.sourceInfo.path, body: stripFrontmatter(raw) });
    total += block.length;
    if (total > maxChars) throw new HttpError(400, tr('server.skills_trop_volumineux'));
    blocks.set(name, block);
  }
  return { blocks, total };
}

// Replace every inline token in `text` with its preloaded block, in place.
function spliceInlineTokens(text, tokens, blocks) {
  let expanded = '';
  let cursor = 0;
  for (const { name, index, length } of tokens) {
    expanded += text.slice(cursor, index) + blocks.get(name);
    cursor = index + length;
  }
  return expanded + text.slice(cursor);
}

export async function expandMultiSkillMessage(text, catalog, { read = readSkill, maxChars = 200000 } = {}) {
  const parsed = parseMultiSkillCommand(text);
  if (!parsed) return null;
  // A later inline skill after the shared trailing text belongs to the same
  // draft: "/skill:alpha /skill:beta text /skill:gamma" expands gamma at its
  // position instead of leaving it silently ignored.
  const trailing = parseInlineSkills(parsed.args);
  const ordered = [...parsed.names];
  for (const { name } of trailing) if (!ordered.includes(name)) ordered.push(name);
  const { blocks } = await loadSkillBlocks(ordered, catalog, {
    read,
    maxChars,
    startTotal:
      parsed.args.length -
      trailing.reduce((total, token) => total + token.length, 0) +
      (parsed.names.length - 1) * 2 +
      (parsed.args ? 2 : 0),
  });
  let args = parsed.args;
  if (trailing.length) {
    // Bound the estimated spliced length BEFORE concatenating, so repeated
    // huge trailing tokens reject without building the output.
    let estimate = parsed.args.length;
    for (const { name, length } of trailing) {
      estimate += blocks.get(name).length - length;
      if (estimate > maxChars) throw new HttpError(400, tr('server.skills_trop_volumineux'));
    }
    args = spliceInlineTokens(parsed.args, trailing, blocks);
  }
  const leading = parsed.names.map((name) => blocks.get(name));
  const expanded = args ? `${leading.join('\n\n')}\n\n${args}` : leading.join('\n\n');
  if (expanded.length > maxChars) throw new HttpError(400, tr('server.skills_trop_volumineux'));
  return expanded;
}

/**
 * Expand inline /skill:name tokens in place, at their chosen positions.
 * Returns null when the draft holds no inline skill (or only the sole single
 * leading skill, which stays engine-expanded). Each occurrence is replaced by
 * the engine-identical <skill> block; repeated names are read once and reused,
 * surrounding text and order are fully retained. Same catalog/size guards as
 * the leading multi-skill path.
 */
export async function expandInlineSkillMessage(text, catalog, { read = readSkill, maxChars = 200000 } = {}) {
  const tokens = parseInlineSkills(text);
  if (!tokens.length || isSoleSingleSkillCommand(text, tokens)) return null;
  // A leading native/session command (e.g. a valid one-line "/goal text")
  // keeps its single-line engine contract: no inline expansion, so the draft
  // stays verbatim exactly like before.
  if (hasNativeLeadingCommand(text, catalog)) return null;
  const { blocks } = await loadSkillBlocks(
    tokens.map((token) => token.name),
    catalog,
    {
      read,
      maxChars,
      startTotal: text.length - tokens.reduce((total, token) => total + token.length, 0),
    },
  );
  // Bound the estimated spliced length BEFORE concatenating.
  let estimate = text.length;
  for (const { name, length } of tokens) {
    estimate += blocks.get(name).length - length;
    if (estimate > maxChars) throw new HttpError(400, tr('server.skills_trop_volumineux'));
  }
  const expanded = spliceInlineTokens(text, tokens, blocks);
  if (expanded.length > maxChars) throw new HttpError(400, tr('server.skills_trop_volumineux'));
  return expanded;
}
