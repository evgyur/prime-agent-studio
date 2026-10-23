// Commit message worker: native credentials stay in this child process.
// Reads one JSON request on stdin, resolves the model exactly like agents do
// (AuthStorage + ModelRegistry), calls pi-ai completeSimple once, prints one
// JSON reply. No tools, no session file, nothing persisted.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
};

const fail = (error, code) => {
  process.stdout.write(JSON.stringify({ ok: false, error, code: code || 'FAILED' }));
  process.exit(0);
};

try {
  const raw = await readStdin();
  const input = JSON.parse(raw || '{}');
  const { packageDir, agentHome, defaultModel, system, user } = input;
  if (!packageDir || !agentHome || !user) fail('Invalid request.', 'BAD_REQUEST');
  const toUrl = (path) => pathToFileURL(join(packageDir, path)).href;
  const [{ AuthStorage, ModelRegistry }, { completeSimple }, defaultCatalog] = await Promise.all([
    Promise.all([import(toUrl('dist/core/auth-storage.js')), import(toUrl('dist/core/model-registry.js'))]).then(
      ([auth, models]) => ({ ...auth, ...models }),
    ),
    import(toUrl('node_modules/@earendil-works/pi-ai/dist/stream.js')),
    import(toUrl('dist/core/default-model-catalog.js')).catch(() => ({})),
  ]);
  if (typeof AuthStorage?.create !== 'function' || typeof ModelRegistry?.create !== 'function')
    fail('Engine incompatible.', 'NO_ENGINE');
  if (typeof completeSimple !== 'function') fail('Engine completion API missing.', 'NO_ENGINE');
  const auth = AuthStorage.create(join(agentHome, 'auth.json'), { usePrimeCliConfig: false });
  const registry = ModelRegistry.create(auth, join(agentHome, 'models.json'));
  const available = registry.getAvailable();
  const match = (selector) => {
    if (!selector || typeof selector !== 'string') return null;
    const needle = selector.trim().toLowerCase();
    if (!needle || !needle.includes('/')) return null;
    return available.find((m) => `${m.provider}/${m.id}`.toLowerCase() === needle) || null;
  };
  // Removed auxiliaryModel is never read: suggestions use the normal default model path.
  let model = match(defaultModel);
  if (!model && typeof defaultCatalog.getPreferredDefaultModelId === 'function') {
    try {
      const preferred = defaultCatalog.getPreferredDefaultModelId();
      if (preferred && typeof defaultCatalog.resolvePreferredDefaultModel === 'function') {
        model = defaultCatalog.resolvePreferredDefaultModel(preferred, available) || null;
      } else if (preferred) model = match(preferred);
    } catch {}
  }
  if (!model) model = available[0] || null;
  if (!model) fail('No usable model. Connect a provider or set a default model.', 'NO_MODEL');
  const resolved = await registry.getApiKeyAndHeaders(model);
  if (!resolved?.ok || !resolved.apiKey) fail('No usable model. Connect a provider or set a default model.', 'NO_MODEL');
  const requestModel = resolved.requestModel || model;
  const response = await completeSimple(
    requestModel,
    {
      systemPrompt: String(system || ''),
      messages: [{ role: 'user', content: [{ type: 'text', text: String(user) }], timestamp: Date.now() }],
    },
    { maxTokens: 512, apiKey: resolved.apiKey, headers: resolved.headers },
  );
  if (!response || response.stopReason === 'error')
    fail(String(response?.errorMessage || 'Model request failed.'), 'PROVIDER');
  const text = (response.content || [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
  if (!text) fail('Empty model reply.', 'EMPTY');
  process.stdout.write(JSON.stringify({ ok: true, text, model: `${model.provider}/${model.id}` }));
} catch (error) {
  fail(String(error?.message || 'Worker failed.'), 'FAILED');
}
