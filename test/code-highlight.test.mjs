import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  HIGHLIGHT_MAX_BYTES,
  HIGHLIGHT_MAX_LINES,
  HIGHLIGHT_MAX_LINE_LENGTH,
  HIGHLIGHT_BLOCK_MAX_CHARS,
  HIGHLIGHT_BUNDLED_LANGUAGES,
  HIGHLIGHT_EXTRA_LANGUAGES,
  isHighlightLanguage,
  languageForFence,
  languageForPath,
  highlightLimit,
  canHighlightFile,
  canHighlightBlock,
  splitHighlightLines,
  highlightCacheKey,
} from '../public/code-highlight.js';

describe('languageForFence', () => {
  it('maps common fences to highlight.js languages', () => {
    assert.equal(languageForFence('js'), 'javascript');
    assert.equal(languageForFence('JS'), 'javascript');
    assert.equal(languageForFence('  python  '), 'python');
    assert.equal(languageForFence('html'), 'xml');
    assert.equal(languageForFence('c++'), 'cpp');
    assert.equal(languageForFence('ps1'), 'powershell');
    assert.equal(languageForFence('bat'), 'dos');
    assert.equal(languageForFence('Dockerfile'), 'dockerfile');
  });
  it('returns null for unknown or empty fences (plain text)', () => {
    assert.equal(languageForFence('toml'), null);
    assert.equal(languageForFence('brainfuck-xyz'), null);
    assert.equal(languageForFence(''), null);
    assert.equal(languageForFence(null), null);
    assert.equal(languageForFence(undefined), null);
  });
  it('only returns registered languages', () => {
    assert.equal(languageForFence('powershell'), 'powershell');
    assert.equal(languageForFence('cmake'), 'cmake');
    for (const language of HIGHLIGHT_BUNDLED_LANGUAGES) assert.ok(isHighlightLanguage(language));
    for (const language of Object.keys(HIGHLIGHT_EXTRA_LANGUAGES)) assert.ok(isHighlightLanguage(language));
  });
});

describe('languageForPath', () => {
  it('maps extensions used in file previews', () => {
    assert.equal(languageForPath('src/app.js'), 'javascript');
    assert.equal(languageForPath('src/app.mjs'), 'javascript');
    assert.equal(languageForPath('src/app.ts'), 'typescript');
    assert.equal(languageForPath('script.py'), 'python');
    assert.equal(languageForPath('page.html'), 'xml');
    assert.equal(languageForPath('data.json'), 'json');
    assert.equal(languageForPath('style.css'), 'css');
    assert.equal(languageForPath('run.ps1'), 'powershell');
    assert.equal(languageForPath('run.bat'), 'dos');
    assert.equal(languageForPath('notes.txt'), 'plaintext');
  });
  it('maps well-known filenames without extensions', () => {
    assert.equal(languageForPath('Dockerfile'), 'dockerfile');
    assert.equal(languageForPath('docker/Dockerfile.prod'), 'dockerfile');
    assert.equal(languageForPath('Makefile'), 'makefile');
    assert.equal(languageForPath('CMakeLists.txt'), 'cmake');
  });
  it('returns null without guessing (no auto-detection)', () => {
    assert.equal(languageForPath('config.toml'), null);
    assert.equal(languageForPath('mystery.xyz123'), null);
    assert.equal(languageForPath('README'), null);
    assert.equal(languageForPath(''), null);
    assert.equal(languageForPath(null), null);
  });
});

describe('highlightLimit', () => {
  it('accepts ordinary files', () => {
    assert.equal(highlightLimit('const x = 1;\n'), null);
    assert.equal(highlightLimit(''), null);
  });
  it('rejects files above about 512 KB', () => {
    const unit = `${'x'.repeat(4000)}\n`; // short lines, few lines
    assert.equal(highlightLimit(unit.repeat(132)), 'too-large');
    assert.equal(highlightLimit(unit.repeat(131)), null);
  });
  it('rejects too many lines', () => {
    assert.equal(highlightLimit('x\n'.repeat(HIGHLIGHT_MAX_LINES + 5)), 'too-many-lines');
    assert.equal(highlightLimit('x\n'.repeat(HIGHLIGHT_MAX_LINES - 1)), null);
  });
  it('rejects a line longer than a few thousand characters', () => {
    assert.equal(highlightLimit('x'.repeat(HIGHLIGHT_MAX_LINE_LENGTH + 1)), 'line-too-long');
    assert.equal(highlightLimit(`short\n${'x'.repeat(HIGHLIGHT_MAX_LINE_LENGTH)}`), null);
  });
});

describe('canHighlightBlock', () => {
  it('accepts small blocks in known languages', () => {
    assert.equal(canHighlightBlock('javascript', 'const x = 1;'), true);
    assert.equal(canHighlightBlock('powershell', 'Write-Host "hi"'), true);
  });
  it('rejects unknown languages and oversized blocks', () => {
    assert.equal(canHighlightBlock('toml', 'a = 1'), false);
    assert.equal(canHighlightBlock(null, 'const x = 1;'), false);
    assert.equal(canHighlightBlock('javascript', ''), false);
    assert.equal(canHighlightBlock('javascript', 'x'.repeat(HIGHLIGHT_BLOCK_MAX_CHARS + 1)), false);
  });
  it('accepts or rejects whole files consistently', () => {
    assert.equal(canHighlightFile('const x = 1;\n'), true);
    assert.equal(canHighlightFile('x'.repeat(HIGHLIGHT_MAX_BYTES + 1)), false);
  });
});

describe('splitHighlightLines', () => {
  it('keeps single-line spans on one line', () => {
    assert.deepEqual(splitHighlightLines('<span class="hljs-keyword">const</span> x = 1;'), [
      '<span class="hljs-keyword">const</span> x = 1;',
    ]);
  });
  it('reopens spans across newlines so every line is balanced', () => {
    const lines = splitHighlightLines('<span class="hljs-comment">// one\n// two</span>\nplain');
    assert.equal(lines.length, 3);
    assert.equal(lines[0], '<span class="hljs-comment">// one</span>');
    assert.equal(lines[1], '<span class="hljs-comment">// two</span>');
    assert.equal(lines[2], 'plain');
  });
  it('reopens nested spans in order across newlines', () => {
    const lines = splitHighlightLines(
      '<span class="hljs-tag">&lt;<span class="hljs-name">div</span>\nattr</span>',
    );
    assert.equal(lines.length, 2);
    assert.equal(lines[0], '<span class="hljs-tag">&lt;<span class="hljs-name">div</span></span>');
    assert.equal(lines[1], '<span class="hljs-tag">attr</span>');
  });
  it('drops non-hljs classes and never emits raw tags', () => {
    // highlight.js escapes its input, so a raw tag here simulates hostile
    // input: it must come out escaped, never as a live element.
    const lines = splitHighlightLines(
      '<span class="evil">a</span><script>alert(1)</script>&lt;b&gt;ok&lt;/b&gt;',
    );
    assert.ok(!lines.join('\n').includes('evil'));
    assert.ok(!lines.join('\n').includes('<script>'));
    assert.ok(lines.join('\n').includes('&lt;script&gt;'));
  });
  it('escapes stray markup and invalid entities', () => {
    const lines = splitHighlightLines('a < b &bogus; c');
    assert.deepEqual(lines, ['a &lt; b &amp;bogus; c']);
  });
});

describe('highlightCacheKey', () => {
  it('is stable and separates language and text', () => {
    assert.equal(highlightCacheKey('js', 'x'), highlightCacheKey('js', 'x'));
    assert.notEqual(highlightCacheKey('js', 'x'), highlightCacheKey('python', 'x'));
    assert.notEqual(highlightCacheKey('js', 'x'), highlightCacheKey('js', 'y'));
  });
});
