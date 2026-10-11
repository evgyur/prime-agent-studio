import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatMessage as tr } from '../public/i18n-core.js';
import {
  isSoleSingleSkillCommand,
  parseInlineSkills,
  parseMultiSkillCommand,
  validateCommand,
} from '../lib/commands.mjs';
import { expandInlineSkillMessage, expandMultiSkillMessage } from '../lib/skill-expansion.mjs';
import { commandAtCaret, inCodeLiteral, skillTokens } from '../public/skill-tokens.js';

const catalog = {
  commands: [
    { name: 'skill:alpha', source: 'skill', supported: true, sourceInfo: { path: '/skills/alpha/SKILL.md' } },
    { name: 'skill:beta', source: 'skill', supported: true, sourceInfo: { path: '/skills/beta/SKILL.md' } },
  ],
};

test('multi skill invocation parses two leading skills', () => {
  assert.deepEqual(parseMultiSkillCommand('/skill:alpha /skill:beta Do work'), {
    names: ['alpha', 'beta'],
    args: 'Do work',
  });
  assert.equal(parseMultiSkillCommand('/skill:alpha Do work'), null);
  assert.equal(parseMultiSkillCommand('Do work'), null);
});

test('repeated skill names dedupe to one expansion', () => {
  assert.deepEqual(parseMultiSkillCommand('/skill:alpha /skill:alpha /skill:beta text'), {
    names: ['alpha', 'beta'],
    args: 'text',
  });
  assert.deepEqual(parseMultiSkillCommand('/skill:alpha /skill:alpha text'), {
    names: ['alpha'],
    args: 'text',
  });
});

test('validateCommand accepts known multi skills and rejects unknown', () => {
  assert.doesNotThrow(() => validateCommand('/skill:alpha /skill:beta Do work', catalog));
  assert.throws(() => validateCommand('/skill:alpha /skill:missing Do work', catalog), { status: 400 });
});

test('expansion matches engine block format byte for byte', async () => {
  const files = {
    '/skills/alpha/SKILL.md': '---\nname: alpha\ndescription: A\n---\nAlpha body',
    '/skills/beta/SKILL.md': 'Beta body without frontmatter',
  };
  const expanded = await expandMultiSkillMessage('/skill:alpha /skill:beta Shared text', catalog, {
    read: async (path) => files[path],
  });
  const expected =
    '<skill name="alpha" location="/skills/alpha/SKILL.md">\n' +
    'References are relative to /skills/alpha.\n\nAlpha body\n</skill>\n\n' +
    '<skill name="beta" location="/skills/beta/SKILL.md">\n' +
    'References are relative to /skills/beta.\n\nBeta body without frontmatter\n</skill>\n\n' +
    'Shared text';
  assert.equal(expanded, expected);
  assert.equal(await expandMultiSkillMessage('/skill:alpha Only one', catalog), null);
});

test('frontmatter stripped like the engine on CRLF and edge cases', async () => {
  const files = {
    '/skills/alpha/SKILL.md': '---\r\nname: alpha\r\n---\r\nBody CRLF   ',
    '/skills/beta/SKILL.md': 'No frontmatter body',
  };
  const expanded = await expandMultiSkillMessage('/skill:alpha /skill:beta text', catalog, {
    read: async (path) => files[path],
  });
  assert.ok(expanded.includes('Body CRLF\n</skill>'));
  assert.ok(expanded.includes('No frontmatter body\n</skill>'));
  const missingClose = await expandMultiSkillMessage('/skill:alpha /skill:beta text', catalog, {
    read: async (path) => (path.endsWith('alpha/SKILL.md') ? '---\nno closing marker' : 'plain'),
  });
  assert.ok(missingClose.includes('---\nno closing marker\n</skill>'));
});

test('duplicate manual command expands once without duplication', async () => {
  const files = {
    '/skills/alpha/SKILL.md': 'Alpha',
    '/skills/beta/SKILL.md': 'Beta',
  };
  let reads = 0;
  const expanded = await expandMultiSkillMessage('/skill:alpha /skill:alpha /skill:beta go', catalog, {
    read: async (path) => {
      reads++;
      return files[path];
    },
  });
  assert.equal(reads, 2);
  assert.equal(expanded.match(/<skill name="alpha"/g).length, 1);
  assert.equal(expanded.match(/<skill name="beta"/g).length, 1);
});

test('unknown skill produces clear error and oversize is refused while reading', async () => {
  await assert.rejects(
    expandMultiSkillMessage('/skill:alpha /skill:gone Text', catalog, {
      read: async () => {
        throw new Error('no');
      },
    }),
    { status: 400 },
  );
  const reads = [];
  await assert.rejects(
    expandMultiSkillMessage('/skill:alpha /skill:beta Text', catalog, {
      read: async (path) => {
        reads.push(path);
        return 'x'.repeat(500);
      },
      maxChars: 10,
    }),
    { status: 400 },
  );
  assert.ok(reads.length <= 1);
});

test('same skill twice consumes both tokens and expands only once', async () => {
  const result = await expandMultiSkillMessage('/skill:alpha /skill:alpha Do work', catalog, {
    read: async () => 'Alpha',
  });
  assert.equal((result.match(/<skill name="alpha"/g) || []).length, 1);
  assert.equal(result.includes('/skill:'), false);
  assert.ok(result.endsWith('Do work'));
});

test('real disk reads reject a large skill before loading its body', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-skill-limit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'SKILL.md');
  await writeFile(path, 'x'.repeat(8192));
  const localCatalog = { commands: [{ name: 'skill:alpha', source: 'skill', sourceInfo: { path } }] };
  await assert.rejects(
    expandMultiSkillMessage('/skill:alpha /skill:alpha request', localCatalog, { maxChars: 1000 }),
    (error) => error.status === 400 && error.message === tr('server.skills_trop_volumineux'),
  );
  await writeFile(path, 'Valid instructions');
  const expanded = await expandMultiSkillMessage('/skill:alpha /skill:alpha request', localCatalog, {
    maxChars: 1000,
  });
  assert.ok(expanded.includes('Valid instructions'));
});

test('inline skill tokens parse at start, middle, end and across newlines in order', () => {
  assert.deepEqual(
    parseInlineSkills("D'abord /skill:one ceci puis /skill:two cela").map((token) => token.name),
    ['one', 'two'],
  );
  const end = parseInlineSkills('fin /skill:alpha');
  assert.equal(end.length, 1);
  assert.equal(end[0].name, 'alpha');
  const lines = parseInlineSkills('premi\u00e8re ligne\n/skill:alpha milieu\n/skill:beta fin');
  assert.deepEqual(
    lines.map((token) => token.name),
    ['alpha', 'beta'],
  );
  const tokens = parseInlineSkills('/skill:alpha /skill:beta go');
  assert.equal(tokens[0].index, 0);
  assert.ok(tokens[1].index > tokens[0].index + tokens[0].length);
  assert.equal(parseInlineSkills('plain text without tokens').length, 0);
});

test('inline parsing ignores code literals, escaped tokens, paths and URLs', () => {
  for (const text of [
    'voir https://example.com/skill:alpha ensuite',
    'lire /tmp/skill:alpha puis continuer',
    'lancer \\/skill:alpha ensuite',
    'lire `utiliser /skill:alpha ici` ensuite',
    '```\n/skill:alpha\n```\nensuite',
    '~~~\n/skill:alpha\n~~~\nensuite',
    'mot-/skill:alpha colle',
  ])
    assert.deepEqual(parseInlineSkills(text), [], text);
  assert.deepEqual(
    parseInlineSkills('lire `/skill:alpha` puis /skill:beta fin').map((token) => token.name),
    ['beta'],
  );
  assert.deepEqual(
    parseInlineSkills('(/skill:alpha) et :/skill:beta fin').map((token) => token.name),
    ['alpha', 'beta'],
  );
});

test('sole single leading skill stays on the engine path', () => {
  assert.equal(isSoleSingleSkillCommand('/skill:alpha hello'), true);
  assert.equal(isSoleSingleSkillCommand('/skill:alpha'), true);
  assert.equal(isSoleSingleSkillCommand('  /skill:alpha hello  '), true);
  for (const text of [
    '/skill:alpha /skill:beta hello',
    "D'abord /skill:alpha ensuite",
    '/skill:alpha, hello',
    'plain text',
  ])
    assert.equal(isSoleSingleSkillCommand(text), false);
});

test('validateCommand accepts known inline skills and rejects unknown or unsupported', () => {
  const extended = {
    commands: [
      ...catalog.commands,
      { name: 'skill:old', source: 'skill', supported: false, reason: 'retired' },
    ],
  };
  assert.doesNotThrow(() => validateCommand("D'abord /skill:alpha ceci puis /skill:beta cela", catalog));
  assert.throws(() => validateCommand('texte /skill:gone fin', catalog), { status: 400 });
  assert.throws(() => validateCommand('texte /skill:old fin', extended), { status: 400 });
  assert.doesNotThrow(() => validateCommand('lire `/skill:gone` fin', catalog));
});

test('inline expansion replaces each token in place keeping order and text', async () => {
  const files = {
    '/skills/alpha/SKILL.md': '---\nname: alpha\ndescription: A\n---\nAlpha body',
    '/skills/beta/SKILL.md': 'Beta body without frontmatter',
  };
  const expanded = await expandInlineSkillMessage(
    "D'abord /skill:alpha ceci puis /skill:beta cela",
    catalog,
    { read: async (path) => files[path] },
  );
  assert.ok(expanded.startsWith("D'abord "));
  assert.ok(expanded.endsWith(' cela'));
  assert.ok(expanded.includes(' ceci puis '));
  const alpha = expanded.indexOf('<skill name="alpha"');
  const beta = expanded.indexOf('<skill name="beta"');
  assert.ok(alpha > 0 && beta > alpha);
  assert.ok(expanded.includes('Alpha body\n</skill>'));
  assert.ok(expanded.includes('Beta body without frontmatter\n</skill>'));
  assert.equal(expanded.includes('/skill:'), false);
});

test('inline expansion reads a repeated skill once but expands every position', async () => {
  let reads = 0;
  const expanded = await expandInlineSkillMessage(
    '/skill:alpha one /skill:beta two /skill:alpha three',
    catalog,
    {
      read: async (path) => {
        reads++;
        return path.endsWith('alpha/SKILL.md') ? 'Alpha' : 'Beta';
      },
    },
  );
  assert.equal(reads, 2);
  assert.equal(expanded.match(/<skill name="alpha"/g).length, 2);
  assert.equal(expanded.match(/<skill name="beta"/g).length, 1);
  assert.ok(expanded.indexOf(' one ') < expanded.indexOf(' two '));
  assert.ok(expanded.indexOf(' two ') < expanded.indexOf(' three'));
});

test('inline expansion leaves a sole single skill to the engine and refuses unknown or oversize', async () => {
  assert.equal(await expandInlineSkillMessage('/skill:alpha hello', catalog), null);
  assert.equal(await expandInlineSkillMessage('plain text', catalog), null);
  await assert.rejects(
    expandInlineSkillMessage('avant /skill:gone apres', catalog, { read: async () => 'x' }),
    { status: 400 },
  );
  await assert.rejects(
    expandInlineSkillMessage('avant /skill:alpha /skill:beta apres', catalog, {
      read: async () => 'x'.repeat(500),
      maxChars: 10,
    }),
    { status: 400 },
  );
});

test('shared lexical helpers back the backend and drive the caret query', () => {
  assert.deepEqual(
    skillTokens("D'abord /skill:one puis /skill:two fin").map((token) => token.name),
    ['one', 'two'],
  );
  assert.deepEqual(
    parseInlineSkills('a /skill:one b').map((token) => [token.name, token.index, token.length]),
    skillTokens('a /skill:one b').map((token) => [token.name, token.start, token.end - token.start]),
  );
  assert.equal(inCodeLiteral('`code /skill:x`', 8), true);
  assert.equal(inCodeLiteral('~~~\n/skill:x\n~~~', 6), true);
  assert.equal(inCodeLiteral('plain /skill:x', 8), false);
  assert.deepEqual(commandAtCaret('/skill:al', 9, 9), { start: 0, end: 9, query: '/skill:al' });
  assert.deepEqual(commandAtCaret('hi /sk', 6, 6), { start: 3, end: 6, query: '/sk' });
  assert.deepEqual(commandAtCaret('hi /skill:ax by', 10, 10), { start: 3, end: 12, query: '/skill:' });
  assert.equal(commandAtCaret('`/sk`', 3, 3), null);
  assert.equal(commandAtCaret('/ab', 1, 3), null);
  assert.equal(commandAtCaret('plain', 5, 5), null);
});

test('inline suffix keeps paths and invalid tokens literal, sentence punctuation terminates', () => {
  for (const text of [
    'open /skill:alpha/SKILL.md then',
    'run /skill:alpha_other now',
    'run /skill:alpha.txt now',
    'run /skill:alpha:beta now',
    'see /skill:alpha@home now',
  ])
    assert.deepEqual(parseInlineSkills(text), [], text);
  assert.deepEqual(
    parseInlineSkills('run /skill:alpha. Next').map((token) => token.name),
    ['alpha'],
  );
  assert.deepEqual(
    parseInlineSkills('run /skill:alpha, next (/skill:beta)!').map((token) => token.name),
    ['alpha', 'beta'],
  );
});

test('unfinished literals hide tokens and caret queries, closed literals reopen', () => {
  assert.equal(inCodeLiteral('```js\n/skill:al', 13), true);
  assert.equal(inCodeLiteral('~~~\n/skill:al', 11), true);
  assert.equal(inCodeLiteral('Exemple `/skill:al', 18), true);
  assert.equal(inCodeLiteral('`a` plain', 9), false);
  assert.equal(commandAtCaret('```js\n/skill:al', 13, 13), null);
  assert.equal(commandAtCaret('~~~\n/skill:al', 11, 11), null);
  assert.equal(commandAtCaret('Exemple `/skill:al', 18, 18), null);
  assert.equal(commandAtCaret('``/skill:al``', 5, 5), null);
  assert.deepEqual(
    skillTokens('``/skill:al`` ok /skill:ok').map((token) => token.name),
    ['ok'],
  );
  assert.deepEqual(commandAtCaret('`a` /sk', 6, 6), { start: 4, end: 7, query: '/s' });
  assert.deepEqual(commandAtCaret('`a` /sk', 7, 7), { start: 4, end: 7, query: '/sk' });
});

test('multi leading skills also expand a later inline skill at its position', async () => {
  const trio = {
    commands: [
      ...catalog.commands,
      {
        name: 'skill:gamma',
        source: 'skill',
        supported: true,
        sourceInfo: { path: '/skills/gamma/SKILL.md' },
      },
    ],
  };
  const files = {
    '/skills/alpha/SKILL.md': 'Alpha body',
    '/skills/beta/SKILL.md': 'Beta body',
    '/skills/gamma/SKILL.md': 'Gamma body',
  };
  const expanded = await expandMultiSkillMessage('/skill:alpha /skill:beta text /skill:gamma fin', trio, {
    read: async (path) => files[path],
  });
  const alpha = expanded.indexOf('<skill name="alpha"');
  const beta = expanded.indexOf('<skill name="beta"');
  const gamma = expanded.indexOf('<skill name="gamma"');
  assert.ok(alpha === 0 && beta > alpha);
  const textAt = expanded.indexOf('\n\ntext ');
  assert.ok(textAt > beta);
  assert.ok(gamma > textAt);
  assert.ok(expanded.endsWith(' fin'));
  assert.ok(expanded.includes('Gamma body\n</skill>'));
  assert.equal(expanded.includes('/skill:'), false);
  await assert.rejects(
    expandMultiSkillMessage('/skill:alpha /skill:beta text /skill:gone fin', trio, {
      read: async (path) => files[path],
    }),
    { status: 400 },
  );
  assert.throws(() => validateCommand('/skill:alpha /skill:beta text /skill:gone fin', trio), {
    status: 400,
  });
});

test('leading non-skill command guards run before any inline skill validation', () => {
  const guarded = {
    commands: [
      ...catalog.commands,
      { name: 'share', source: 'native', supported: false, reason: 'terminal only' },
      { name: 'settings', source: 'studio', supported: true },
      { name: 'goal', source: 'native', supported: true },
    ],
  };
  assert.throws(() => validateCommand('/share args /skill:alpha', guarded), { status: 400 });
  assert.throws(() => validateCommand('/settings /skill:alpha', guarded), { status: 400 });
  assert.throws(() => validateCommand('/goal a\nb /skill:alpha', guarded), { status: 400 });
  assert.throws(() => validateCommand('/goal ok /skill:alpha', guarded, { attachments: true }), {
    status: 400,
  });
  assert.throws(() => validateCommand('/unknown /skill:alpha', guarded), { status: 400 });
  assert.doesNotThrow(() => validateCommand('/skill:alpha hello /skill:beta world', catalog));
  assert.doesNotThrow(() => validateCommand('/goal status /skill:alpha', guarded));
  assert.doesNotThrow(() => validateCommand('plain /skill:alpha text', catalog));
});

test('loader budget stops reading once the cumulative size breaks', async () => {
  const reads = [];
  await assert.rejects(
    expandMultiSkillMessage('/skill:alpha /skill:beta go', catalog, {
      read: async (path) => {
        reads.push(path);
        return 'A'.repeat(60);
      },
      maxChars: 120,
    }),
    (error) => error.status === 400 && error.message === tr('server.skills_trop_volumineux'),
  );
  assert.deepEqual(reads, ['/skills/alpha/SKILL.md']);
});

test('repeated huge trailing tokens reject before building the output', async () => {
  const trio = {
    commands: [
      ...catalog.commands,
      { name: 'skill:big', source: 'skill', supported: true, sourceInfo: { path: '/skills/big/SKILL.md' } },
    ],
  };
  const reads = [];
  await assert.rejects(
    expandMultiSkillMessage('/skill:alpha /skill:beta go /skill:big /skill:big /skill:big', trio, {
      read: async (path) => {
        reads.push(path);
        return path.endsWith('big/SKILL.md') ? 'x'.repeat(200) : 'small';
      },
      maxChars: 400,
    }),
    (error) => error.status === 400 && error.message === tr('server.skills_trop_volumineux'),
  );
  assert.deepEqual(reads, ['/skills/alpha/SKILL.md', '/skills/beta/SKILL.md', '/skills/big/SKILL.md']);
});

test('malformed leading skill cannot bypass the unknown check through a later valid token', () => {
  assert.throws(() => validateCommand('/skill:bad_suffix then /skill:alpha', catalog), { status: 400 });
  assert.deepEqual(
    parseInlineSkills('/skill:bad_suffix then /skill:alpha').map((token) => token.name),
    ['alpha'],
  );
  assert.doesNotThrow(() => validateCommand('/skill:alpha, hello /skill:beta', catalog));
});

test('leading native session command keeps prior verbatim behavior', async () => {
  const withGoal = {
    commands: [...catalog.commands, { name: 'goal', source: 'native', supported: true, description: 'Goal' }],
  };
  assert.doesNotThrow(() => validateCommand('/goal status /skill:alpha', withGoal));
  let reads = 0;
  assert.equal(
    await expandInlineSkillMessage('/goal status /skill:alpha', withGoal, {
      read: async () => {
        reads++;
        return 'Alpha';
      },
    }),
    null,
  );
  assert.equal(reads, 0);
});

test('inline and mixed skills accept the exact output limit and reject one character less', async () => {
  const all = {
    commands: [
      ...catalog.commands,
      ...['gamma', 'delta'].map((name) => ({
        name: `skill:${name}`,
        source: 'skill',
        supported: true,
        sourceInfo: { path: `/skills/${name}/SKILL.md` },
      })),
    ],
  };
  const read = async () => 'Method';
  for (const [expand, text] of [
    [expandInlineSkillMessage, 'Before /skill:alpha after /skill:beta.'],
    [expandMultiSkillMessage, '/skill:alpha /skill:beta then /skill:gamma and /skill:delta.'],
  ]) {
    const expected = await expand(text, all, { read });
    assert.equal(await expand(text, all, { read, maxChars: expected.length }), expected);
    await assert.rejects(expand(text, all, { read, maxChars: expected.length - 1 }), { status: 400 });
  }
});

test('native command arguments keep unknown skill-like text literal', async () => {
  const native = { commands: [{ name: 'goal', source: 'native', supported: true }] };
  const text = '/goal Document /skill:missing without invoking it';
  assert.doesNotThrow(() => validateCommand(text, native));
  assert.equal(
    await expandInlineSkillMessage(text, native, {
      read: async () => assert.fail('Native command arguments must not read a skill'),
    }),
    null,
  );
});
