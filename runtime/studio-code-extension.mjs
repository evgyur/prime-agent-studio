import { Type } from 'typebox';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const worker = fileURLToPath(new URL('../scripts/studio-code-worker.mjs', import.meta.url));
export function requestCode(config, action, params, signal, ctx) {
  return new Promise((resolveResult, reject) => {
    if (signal?.aborted) return reject(new Error('Code lookup cancelled.'));
    const child = spawn(process.execPath, [worker], {
      cwd: ctx.cwd, windowsHide: true, shell: false,
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '', finished = false;
    const timers = typeof ctx.setTimeout === 'function' ? ctx : globalThis;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      timers.clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (error) { child.kill(); reject(error); } else resolveResult(result);
    };
    const cancel = () => finish(new Error('Code lookup cancelled.'));
    const timer = timers.setTimeout(() => finish(new Error('Code lookup timed out.')), 15000);
    signal?.addEventListener('abort', cancel, { once: true });
    child.on('error', finish);
    child.stdin.on('error', finish);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output) > 128 * 1024) finish(new Error('Code lookup response too large.'));
    });
    child.stderr.resume();
    child.on('close', (code) => {
      if (finished) return;
      try {
        const result = JSON.parse(output);
        if (code || result.error) throw new Error(result.error || 'Code lookup failed.');
        finish(null, result);
      } catch (error) { finish(error); }
    });
    child.stdin.end(JSON.stringify({ config, action, params }));
  });
}

export default function studioCode(pi) {
  let config;
  try { config = JSON.parse(process.env.PRIME_STUDIO_CODE_CONFIG || 'null'); } catch { return; }
  if (!config?.enabled || config.sessionEnabled === false || !config.dataDir || !config.projectPath || !config.projectId) return;
  const scoped = (ctx) => resolve(ctx.cwd) === resolve(config.projectPath);
  for (const [name, action, key, description] of [
    ['studio_code_search', 'search', 'q', 'Exact literal search over current files. Smart case; regex:true and wholeWord:true optional. Labeled hits with symbol and context. Prefer over shell grep when structure is needed in one call; shell grep is fine otherwise.'],
    ['studio_code_symbols', 'symbols', 'symbol', 'Exact fresh references plus definitions for a symbol. Labels: definition, reference, import, test, doc, UI-string, comment. Prefer over shell grep when structure is needed in one call.'],
    ['studio_code_map', 'map', 'path', 'Imports, definitions, references and recent changes for a path. If stale:true, re-read source.'],
  ]) pi.registerTool({
    name, label: name, description, executionMode: 'parallel',
    parameters: Type.Object({
      [key]: action === 'map' ? Type.Optional(Type.String({ maxLength: 500 })) : Type.String({ minLength: 1, maxLength: 500 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      ...(action === 'search' ? { regex: Type.Optional(Type.Boolean()), wholeWord: Type.Optional(Type.Boolean()) } : {}),
      ...(action === 'symbols' ? {} : { includeGenerated: Type.Optional(Type.Boolean()) }),
    }, { additionalProperties: false }),
    execute: async (_id, params, signal, _update, ctx) => {
      if (!scoped(ctx)) throw new Error('Code index belongs to a different project.');
      const result = await requestCode({ ...config, sessionId: config.sessionId || ctx.sessionManager.getSessionId() }, action, params, signal, ctx);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: { action } };
    },
  });
}
