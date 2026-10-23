import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAgentRuntime } from '../../lib/agent.mjs';
import { createApp } from '../../server.mjs';

// Isolated real Prime Agent + deterministic loopback provider. No user account,
// production server, real project, or paid model is involved.
export async function interactiveStudio({ beforeQuestion, questions } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'prime-interactive-'));
  const cwd = join(root, 'Atelier visuel'),
    agentHome = join(root, 'agent'),
    sessionDir = join(agentHome, 'sessions');
  await Promise.all([
    mkdir(join(cwd, 'captures'), { recursive: true }),
    mkdir(sessionDir, { recursive: true }),
  ]);
  await cp(resolve('assets/prime-agent-512.png'), join(cwd, 'captures/apercu.png'));
  const requests = [];
  const provider = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      requests.push(body);
      const hasQuestion = body.tools?.some((tool) => tool.function.name === 'question');
      const lastUser = body.messages.findLastIndex((item) => item.role === 'user');
      const result =
        body.messages.slice(lastUser).findLast((item) => item.role === 'tool' && item.name === 'question') ||
        body.messages.slice(lastUser).findLast((item) => item.role === 'tool');
      const prompt = JSON.stringify(body.messages[lastUser]?.content || '');
      const ask = hasQuestion && !result && !prompt.includes('Sans question');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const frame = (delta, finish_reason = null) =>
        res.write(
          `data: ${JSON.stringify({ id: `fixture-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      frame({ role: 'assistant' });
      if (ask) {
        frame({
          content:
            'L’aperçu est prêt. Il reste un choix à préciser.\n\n![Aperçu du projet](captures/apercu.png)\n\n',
        });
        await beforeQuestion?.();
        frame({
          tool_calls: [
            {
              index: 0,
              id: `question-${requests.length}`,
              type: 'function',
              function: {
                name: 'question',
                arguments: JSON.stringify({ questions: questions || [{
                  question: 'Quelle présentation préférez-vous pour la page d’accueil ?',
                  options: [
                    {
                      label: 'Vue compacte',
                      description: 'Les informations essentielles, visibles immédiatement.',
                    },
                    { label: 'Vue détaillée', description: 'Davantage de contexte pour chaque élément.' },
                    { label: 'Vue en liste', description: 'Une lecture simple, ligne par ligne.' },
                  ],
                }] }),
              },
            },
          ],
        });
        frame({}, 'tool_calls');
      } else {
        frame({
          content: result
            ? `Merci, votre réponse a bien été reçue.\n\nRésultat natif : ${result.content}\n\n![Aperçu du projet](captures/apercu.png)`
            : 'Voici l’aperçu du projet.\n\n![Aperçu du projet](captures/apercu.png)',
        });
        frame({}, 'stop');
      }
      res.end('data: [DONE]\n\n');
    } catch (error) {
      res.writeHead(500);
      res.end(error.message);
    }
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  await writeFile(join(agentHome, 'auth.json'), '{}');
  await writeFile(
    join(agentHome, 'settings.json'),
    JSON.stringify({
      defaultProvider: 'fixture',
      defaultModel: 'demo',
      autoRefine: { enabled: false },
      compaction: { enabled: false },
      retry: { enabled: false },
      telemetry: { enabled: false, noticeShown: true },
    }),
  );
  await writeFile(
    join(agentHome, 'models.json'),
    JSON.stringify({
      providers: {
        fixture: {
          api: 'openai-completions',
          baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
          apiKey: 'fixture-only',
          models: [
            {
              id: 'demo',
              name: 'Agent de démonstration',
              reasoning: true,
              input: ['text', 'image'],
              contextWindow: 131072,
              maxTokens: 4096,
            },
          ],
        },
      },
    }),
  );
  const runtime = createAgentRuntime({
    agentHome,
    sessionDir,
    env: { ...process.env, PRIME_AGENT_TELEMETRY: '0' },
  });
  // Complete first-message setup: provider, main and subagent default models.
  await mkdir(join(root, 'studio'), { recursive: true });
  await writeFile(
    join(root, 'studio', 'subagent-defaults.json'),
    JSON.stringify({
      version: 1,
      revision: 'fixture',
      global: { model: 'fixture/demo', thinking: '' },
      projects: {},
    }),
  );
  const app = createApp({ initialCwd: cwd, agentHome, sessionDir, dataDir: join(root, 'studio'), runtime });
  await app.store.project({ cwd });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  return {
    root,
    cwd,
    agentHome,
    sessionDir,
    app,
    runtime,
    requests,
    url,
    async close() {
      await app.close();
      await new Promise((resolve) => provider.close(resolve));
    },
  };
}
