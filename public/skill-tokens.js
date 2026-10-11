// Shared skill-token lexical helpers (Node-safe, DOM-free).
//
// One canonical scanner for `/skill:name` tokens, used by the Studio backend
// (lib/commands.mjs delegation) and the composer suggestion UI. Every function
// is pure: pass the pane's own text/caret in, so modular panes never share or
// leak state through a global. No document/window access, importable from both
// public/*.js and lib/*.mjs (same pattern as command-definitions.js).
//
// Skill name grammar everywhere: [A-Za-z0-9-]+ (matches parseMultiSkillCommand).

// Boundary opening an inline /skill:name: start of text, whitespace, or an
// opening punctuation mark. A slash (paths, URLs) or a backslash (escaped
// token) never opens an invocation, so ordinary paths/URLs stay plain text.
const BEFORE = new Set([
  ' ',
  '\t',
  '\n',
  '\r',
  '\u000b',
  '\u000c',
  '\u2028',
  '\u2029',
  '(',
  '[',
  '{',
  '<',
  '"',
  "'",
  '\u00ab',
  '\u201c',
  '\u2018',
  '\u00bf',
  '\u00a1',
  ':',
]);

const TOKEN = /\/skill:([A-Za-z0-9-]+)/g;
// A token is invocable only when the name truly ends here: end of text,
// whitespace, or closing/sentence punctuation. A directly glued `/` (path),
// `_` (invalid token), `@`, `#`, … or a `.` starting an extension keeps the
// whole span literal — never a partial expansion of the valid prefix.
const AFTER_PUNCT = new Set([
  ',',
  ';',
  '!',
  '?',
  ')',
  ']',
  '}',
  '"',
  "'",
  '\u00bb',
  '\u201d',
  '\u2019',
  '\u2026',
]);

export function terminatedAfter(text, end) {
  if (end >= text.length) return true;
  const next = text[end];
  if (/\s/.test(next)) return true;
  if (next === '.') {
    const following = end + 1 < text.length ? text[end + 1] : '';
    return following === '' || /\s/.test(following);
  }
  return AFTER_PUNCT.has(next);
}
// Partial command word the caret query accepts (also ':'/'_' while typing).
const QUERY_WORD = /^[A-Za-z0-9:_-]*/;
// UI caret query: slash token at the very end of the text before the caret.
const QUERY_BEFORE = /(?:^|[\s([{])\/([A-Za-z0-9:_-]*)$/;

// Ranges are [start, end, closed]. Unclosed ranges run to the fence/EOF or
// to the end of their line; a caret exactly at the end of an unclosed range
// is still inside (unfinished literal), while a caret after a closed range
// is outside again.
function fencedRanges(text, ranges) {
  const fences = [
    [/```[\s\S]*?(```|$)/g, '```'],
    [/~~~[\s\S]*?(~~~|$)/g, '~~~'],
  ];
  for (const [pattern, marker] of fences) {
    let match;
    while ((match = pattern.exec(text))) {
      const end = match.index + match[0].length;
      const closed = match[0].length > marker.length && match[0].endsWith(marker);
      ranges.push([match.index, end, closed]);
    }
  }
}

function inlineRanges(text, ranges) {
  const fencedAt = (index) => ranges.some(([start, end]) => index >= start && index < end);
  const linePattern = /[^\n]*(?:\n|$)/g;
  let line;
  while ((line = linePattern.exec(text))) {
    if (line[0] === '') break;
    const lineStart = line.index;
    const body = line[0].endsWith('\n') ? line[0].slice(0, -1) : line[0];
    const lineEnd = lineStart + body.length;
    const runs = [];
    const runPattern = /`+/g;
    let run;
    while ((run = runPattern.exec(body))) runs.push({ index: lineStart + run.index, length: run[0].length });
    for (let i = 0; i < runs.length; i++) {
      const opener = runs[i];
      if (fencedAt(opener.index)) continue;
      let closer = null;
      for (let cursor = i + 1; cursor < runs.length; cursor++) {
        if (fencedAt(runs[cursor].index)) continue;
        if (runs[cursor].length === opener.length) {
          closer = runs[cursor];
          break;
        }
      }
      if (closer) {
        ranges.push([opener.index, closer.index + closer.length, true]);
        i = runs.indexOf(closer);
      } else {
        // Unfinished opener: the rest of the line is a literal.
        ranges.push([opener.index, lineEnd, false]);
        break;
      }
    }
  }
}

function codeRanges(text) {
  const ranges = [];
  fencedRanges(text, ranges);
  inlineRanges(text, ranges);
  return ranges;
}

/**
 * True when a caret/selection offset sits inside a fenced (``` or ~~~) or
 * inline (`) code literal, including an unfinished literal whose range ends
 * exactly at the caret (open fence to EOF, unterminated inline span). The UI
 * suggestion popup and the backend scanner both skip such positions so
 * documented tokens stay plain text.
 */
export function inCodeLiteral(text, position) {
  if (typeof text !== 'string' || !Number.isInteger(position)) return false;
  if (position < 0 || position > text.length) return false;
  return codeRanges(text).some(
    ([start, end, closed]) => position > start && (position < end || (position === end && !closed)),
  );
}

function tokenRanges(text) {
  return codeRanges(text);
}

/**
 * Enumerate every invocable /skill:name token at any position (start, middle,
 * end, across newlines), in source order. Tokens inside code literals,
 * escaped with a backslash, or glued to a path/URL slash are ignored.
 * Returns [{ name, start, end }] with start/end covering `/skill:name`.
 */
export function skillTokens(text) {
  if (typeof text !== 'string' || !text) return [];
  const excluded = tokenRanges(text);
  const inside = (index) => excluded.some(([start, end]) => index >= start && index < end);
  const found = [];
  TOKEN.lastIndex = 0;
  let match;
  while ((match = TOKEN.exec(text))) {
    const start = match.index;
    const end = start + match[0].length;
    if (!terminatedAfter(text, end)) continue;
    if (inside(start) || inside(end - 1)) continue;
    if (start > 0) {
      const before = text[start - 1];
      if (before === '\\' || before === '/') continue;
      if (!BEFORE.has(before)) continue;
    }
    found.push({ name: match[1], start, end });
  }
  return found;
}

/**
 * Suggestion query for the slash popup in any pane. Rejects selections
 * (start !== end) and carets inside code literals. Otherwise matches
 * /(?:^|[\s([{])\/([A-Za-z0-9:_-]*)$/ on the text before the caret.
 * Returns { start, end, query } where start is the slash index, end consumes
 * the remaining full token word after the caret, and query runs from the
 * slash through the caret (e.g. "/ski"). Null when there is no query.
 */
export function commandAtCaret(value, selectionStart, selectionEnd) {
  if (typeof value !== 'string') return null;
  const caret = Number(selectionStart);
  if (!Number.isInteger(caret) || caret !== Number(selectionEnd)) return null;
  if (caret < 0 || caret > value.length) return null;
  if (inCodeLiteral(value, caret)) return null;
  const before = value.slice(0, caret);
  const match = before.match(QUERY_BEFORE);
  if (!match) return null;
  const head = match[0];
  const start = caret - head.length + (head[0] === '/' ? 0 : 1);
  const query = value.slice(start, caret);
  const rest = (value.slice(caret).match(QUERY_WORD) || [''])[0].length;
  return { start, end: caret + rest, query };
}
