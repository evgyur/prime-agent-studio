import { formatMessage as tr } from '../public/i18n-core.js';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { agentEnvironment, discoverCli } from './agent.mjs';
import { HttpError, validateDirectory } from './store.mjs';
import { STUDIO_COMMANDS, COMMAND_ALIASES } from '../public/command-definitions.js';
import { skillTokens as scanSkillTokens, terminatedAfter } from '../public/skill-tokens.js';
export { STUDIO_COMMANDS, COMMAND_ALIASES };

export const SESSION_COMMANDS = new Set(['compact', 'refine', 'goal', 'autonomous']);
const descriptions = {
  compact: tr('server.resumer_le_contexte_de_la_session'),
  refine: tr('server.ameliorer_les_instructions_et_ressources_reutilisables'),
  goal: tr('server.definir_ou_gerer_un_objectif_persistant'),
  autonomous: tr('server.afficher_activer_ou_desactiver_le_mode_autonome'),
};
export function parseCommand(text) {
  const match = typeof text === 'string' && text.trim().match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/);
  return match
    ? {
        name: Object.hasOwn(COMMAND_ALIASES, match[1]) ? COMMAND_ALIASES[match[1]] : match[1],
        args: (match[2] || '').trim(),
      }
    : null;
}
export function commandCatalog(native) {
  const builtin = native.builtins || [];
  const commands = Object.entries(STUDIO_COMMANDS).map(([name, [description, action, argumentHint]]) => ({
    name,
    description,
    action,
    argumentHint,
    source: 'studio',
    supported: true,
  }));
  for (const command of builtin) {
    if (Object.hasOwn(STUDIO_COMMANDS, command.name)) continue;
    commands.push({
      ...command,
      description: descriptions[command.name] || command.description,
      source: 'native',
      supported: SESSION_COMMANDS.has(command.name),
      ...(SESSION_COMMANDS.has(command.name)
        ? {}
        : { reason: tr('server.cette_commande_necessite_l_interface_terminal_de_prime_agent') }),
    });
  }
  for (const command of native.commands || []) {
    if (commands.some((item) => item.name === command.name)) continue;
    commands.push({
      ...command,
      supported: command.source !== 'extension',
      ...(command.source === 'extension'
        ? { reason: tr('server.les_extensions_interactives_necessitent_le_terminal_prime_agent') }
        : {}),
    });
  }
  return { commands, diagnostics: native.diagnostics || [], live: native.live === true };
}

/** Parse 2+ leading /skill:name tokens sharing one trailing user text. */
export function parseMultiSkillCommand(text) {
  if (typeof text !== 'string') return null;
  const seen = [];
  let count = 0;
  let rest = text.trim();
  while (true) {
    const match = rest.match(/^\/skill:([A-Za-z0-9-]+)(?=\s|$)/);
    if (!match) break;
    count++;
    if (!seen.includes(match[1])) seen.push(match[1]);
    rest = rest.slice(match[0].length).trim();
  }
  return count >= 2 ? { names: seen, args: rest } : null;
}

/**
 * Find every inline /skill:name token at any position (start, middle, end,
 * across newlines), in order. Name grammar matches parseMultiSkillCommand
 * ([A-Za-z0-9-]+). Tokens inside fenced/inline backtick code, escaped with a
 * backslash, or glued to a path/URL slash are skipped and stay plain text.
 * Returns [{ name, index, length }] with index/length covering `/skill:name`.
 */
export function parseInlineSkills(text) {
  return scanSkillTokens(text).map(({ name, start, end }) => ({ name, index: start, length: end - start }));
}

/**
 * True when the whole draft is one single leading /skill:name invocation and
 * nothing else references a skill. Such messages stay engine-expanded, like
 * before, so the native single-skill path never sees a duplicate expansion.
 */
export function isSoleSingleSkillCommand(text, inline) {
  const tokens = inline || parseInlineSkills(text);
  if (tokens.length !== 1 || typeof text !== 'string') return false;
  const trimmed = text.trim();
  const token = tokens[0];
  if (!trimmed.startsWith(`/skill:${token.name}`)) return false;
  const rest = trimmed.slice(`/skill:${token.name}`.length);
  return rest === '' || /^\s/.test(rest);
}

/**
 * The leading skill name when the trimmed draft opens with a well-terminated
 * /skill:name token (same terminator rule as the shared scanner), else null.
 * "/skill:bad_suffix …" is NOT a valid leading skill, so the original leading
 * command validation still rejects it instead of bypassing through a later
 * valid inline token.
 */
export function leadingSkillToken(text) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  const match = trimmed.match(/^\/skill:([A-Za-z0-9-]+)/);
  if (!match || !terminatedAfter(trimmed, match[0].length)) return null;
  return match[1];
}

/**
 * True when the draft opens with a known non-skill native command (or any
 * session command): inline expansion must stay off so the engine keeps its
 * single-line command assumptions, exactly like before.
 */
export function hasNativeLeadingCommand(text, catalog) {
  const parsed = parseCommand(text);
  if (!parsed || leadingSkillToken(text)) return false;
  const entry = (catalog?.commands || []).find((item) => item.name === parsed.name);
  return !!entry && (entry.source === 'native' || SESSION_COMMANDS.has(parsed.name));
}

/** Original leading-command guards: unknown, terminal-only, studio-only, session single-line. */
function assertLeadingCommand(parsed, catalog, text, { attachments }) {
  const command = catalog.commands.find((item) => item.name === parsed.name);
  if (!command)
    throw new HttpError(
      400,
      tr('server.commande_inconnue_dans_ce_projet_ouvrez_le_menu_pour_choisir_une', { value1: parsed.name }),
    );
  if (!command.supported) throw new HttpError(400, command.reason);
  if (command.source === 'studio')
    throw new HttpError(400, tr('server.cette_commande_s_utilise_depuis_le_menu_du_studio'));
  if (SESSION_COMMANDS.has(command.name)) {
    if (/[\r\n\u2028\u2029]/.test(text.trim()) || attachments)
      throw new HttpError(400, tr('server.une_commande_de_session_s_ecrit_sur_une_seule_ligne_sans_piece_j'));
  }
}

/** Reject terminal-only/unknown commands before they can become an ordinary model prompt. */
export function validateCommand(text, catalog, { attachments = false } = {}) {
  const multi = parseMultiSkillCommand(text);
  if (multi) {
    // A later inline skill in the shared trailing text is validated too, so
    // "/skill:alpha /skill:beta text /skill:gone" fails fast like any unknown.
    const names = [...multi.names];
    for (const { name } of parseInlineSkills(multi.args)) if (!names.includes(name)) names.push(name);
    for (const name of names) {
      const command = catalog.commands.find((item) => item.name === `skill:${name}`);
      if (!command) throw new HttpError(400, tr('server.skill_inconnu_dans_ce_projet', { value1: name }));
      if (!command.supported) throw new HttpError(400, command.reason);
    }
    return;
  }
  // Trust boundary: without a valid leading skill token, the original leading
  // command validation runs FIRST (unknown / terminal-only / studio-only /
  // session single-line), even with later inline skill tokens present — so
  // "/share args /skill:alpha" can never bypass the unsupported check, and
  // "/skill:bad_suffix … /skill:alpha" can never bypass the unknown check.
  const parsed = parseCommand(text);
  if (parsed && !leadingSkillToken(text)) {
    assertLeadingCommand(parsed, catalog, text, { attachments });
    if (!hasNativeLeadingCommand(text, catalog)) validateInlineSkills(text, catalog);
    return;
  }
  // Inline /skill:name tokens anywhere in the draft reference catalog skills
  // too. A sole single leading skill keeps the historical single-command path
  // below (engine expansion); anything else with skill tokens is validated
  // here so unknown/unsupported skills fail fast with the same errors.
  const inline = parseInlineSkills(text);
  if (inline.length > 0 && !isSoleSingleSkillCommand(text, inline)) {
    validateInlineSkills(text, catalog, inline);
    return;
  }
  if (!parsed) return;
  assertLeadingCommand(parsed, catalog, text, { attachments });
}

function validateInlineSkills(text, catalog, inline) {
  for (const { name } of inline || parseInlineSkills(text)) {
    const command = catalog.commands.find((item) => item.name === `skill:${name}`);
    if (!command) throw new HttpError(400, tr('server.skill_inconnu_dans_ce_projet', { value1: name }));
    if (!command.supported) throw new HttpError(400, command.reason);
  }
}

export function createCommandService({ agentHome, getLiveClient } = {}) {
  const workers = new Set();
  const cache = new Map();
  let closed = false;
  function read(cwd) {
    const hit = cache.get(cwd);
    if (hit && hit.expires > Date.now()) return hit.promise;
    if (workers.size >= 3)
      throw new HttpError(429, tr('server.le_catalogue_se_charge_reessayez_dans_un_instant'));
    const cli = discoverCli();
    if (!cli?.packageDir)
      throw new HttpError(503, tr('server.installez_prime_agent_pour_utiliser_ses_commandes_et_skills'));
    const promise = new Promise((resolve, reject) => {
      const child = fork(
        fileURLToPath(new URL('../scripts/command-catalog-worker.mjs', import.meta.url)),
        [],
        {
          cwd,
          env: agentEnvironment({ agentHome }),
          execArgv: [],
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        },
      );
      workers.add(child);
      const timer = setTimeout(
        () => finish(new HttpError(504, tr('server.le_catalogue_prime_agent_met_trop_de_temps_a_repondre'))),
        15000,
      );
      let finished = false;
      function finish(error, result) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        workers.delete(child);
        child.kill();
        if (error) {
          cache.delete(cwd);
          reject(error);
        } else resolve(result);
      }
      child.on('error', () =>
        finish(new HttpError(503, tr('server.impossible_de_lire_le_catalogue_prime_agent'))),
      );
      child.on('exit', () =>
        finish(new HttpError(503, tr('server.le_lecteur_du_catalogue_prime_agent_s_est_arrete'))),
      );
      child.on('message', (data) =>
        data?.ok
          ? finish(null, data.catalog)
          : finish(
              new HttpError(503, tr('server.le_catalogue_necessite_une_version_compatible_de_prime_agent')),
            ),
      );
      child.send({ cwd, agentHome, packageDir: cli.packageDir });
    });
    if (cache.size > 24) cache.delete(cache.keys().next().value);
    cache.set(cwd, { promise, expires: Date.now() + 5000 });
    return promise;
  }
  return {
    async list({ cwd, sessionId } = {}) {
      if (closed) throw new HttpError(503, tr('server.le_studio_s_arrete'));
      cwd = await validateDirectory(cwd);
      const native = await read(cwd);
      const client = sessionId && (await getLiveClient?.(sessionId, cwd));
      if (client) {
        try {
          const commands = await client.getCommands(sessionId, cwd);
          return commandCatalog({
            ...native,
            commands: commands.map((c) => ({
              ...native.commands.find(
                (item) => item.name === c.name && item.sourceInfo?.path === c.sourceInfo?.path,
              ),
              ...c,
            })),
            live: true,
          });
        } finally {
          client.close?.();
        }
      }
      return commandCatalog(native);
    },
    close() {
      closed = true;
      for (const child of workers) child.kill();
      cache.clear();
    },
  };
}
