import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createServer } from 'node:http';
import { archivePath, extractTgz, extractZip } from '../lib/component-archives.mjs';
import {
  ALLOWED_ENGINE_ORIGINS,
  COMPONENT_POLICY,
  selectedEnvironment,
  diagnoseComponents,
  prepareComponents,
  atomicJson,
  download,
  checksum,
  verifyDigest,
  releaseOrigin,
  checkNode,
  inspectEngineStatic,
  quickComponentReceipt,
} from '../lib/desktop-components.mjs';
import { acquireLock } from '../scripts/launcher-common.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'studio composants é '));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 4 });
  });
  return root;
}
function tar(entries) {
  const blocks = [];
  for (const { name, type = '0', text = '' } of entries) {
    const data = Buffer.from(text),
      h = Buffer.alloc(512);
    h.write(name);
    h.write('0000644\0', 100);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    h.fill(32, 148, 156);
    h.write(type, 156);
    h.write('ustar\0', 257);
    h.write(
      h
        .reduce((a, b) => a + b, 0)
        .toString(8)
        .padStart(6, '0') + '\0 ',
      148,
    );
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
test('policy pins an exact tested engine; unsupported architectures and Node lines fail closed', () => {
  assert.equal(COMPONENT_POLICY.engine, '0.9.8');
  checkNode('24.19.0', 'win32', 'x64');
  for (const args of [
    ['24.19.0', 'win32', 'arm64'],
    ['24.19.0', 'linux', 'x64'],
    ['20.6.0', 'win32', 'x64'],
    ['26.0.0', 'win32', 'x64'],
  ])
    assert.throws(() => checkNode(...args));
});
test('0.9.8 requires the complete bundle with the direct Node entry; a missing cli-node.js fails closed', async (t) => {
  const root = await fixture(t);
  const packageDir = join(root, 'package');
  await mkdir(join(packageDir, 'dist/bundle'), { recursive: true });
  await writeFile(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: 'prime-agent',
      version: COMPONENT_POLICY.engine,
      engines: { node: '>=22.8.0' },
      bin: { 'prime-agent': 'dist/bundle/cli.js' },
    }),
  );
  await writeFile(join(packageDir, 'dist/bundle/cli.js'), '#!/usr/bin/env node\n');
  const cliPath = join(packageDir, 'dist/bundle/cli.js');
  await assert.rejects(inspectEngineStatic(cliPath), /engine_incompatible/);
  await writeFile(join(packageDir, 'dist/bundle/cli-node.js'), '#!/usr/bin/env node\n');
  const ok = await inspectEngineStatic(cliPath);
  assert.equal(ok.cli.path, cliPath);
  assert.equal(ok.cli.packageDir, packageDir);
});
test('explicit environment beats saved selection, which beats the managed manifest; no PATH mutation', async (t) => {
  const root = await fixture(t);
  await atomicJson(join(root, 'engine/installation.json'), {
    components: { engine: { path: 'managed' }, uv: { path: 'managed-uv' } },
  });
  await atomicJson(join(root, 'engine/selection.json'), { engine: 'saved', python: 'external-python' });
  const env = await selectedEnvironment(root, { PRIME_AGENT_CLI: 'explicit', PATH: 'unchanged' });
  assert.equal(env.PRIME_AGENT_CLI, 'explicit');
  assert.equal(env.PRIME_GUI_UV, 'managed-uv');
  assert.equal(env.PRIME_AGENT_KERNEL_PYTHON, 'external-python');
  assert.equal(env.PATH, 'unchanged');
  assert.equal((await selectedEnvironment(root, {})).PRIME_AGENT_CLI, 'saved');
  assert.equal(env.UV_PYTHON_DOWNLOADS, 'automatic');
  assert.equal(env.UV_PYTHON_PREFERENCE, 'only-managed');
});
test('invalid explicit CLI is reported and never replaced or downloaded', async (t) => {
  const dataRoot = await fixture(t);
  let inspected;
  const deps = {
    checkNode() {},
    validateEngine(path) {
      inspected = path;
      throw new Error('engine_incompatible');
    },
    validateUv() {
      throw new Error('missing');
    },
  };
  const options = {
    dataRoot,
    env: { PRIME_AGENT_CLI: 'bad-explicit', PRIME_AGENT_KERNEL_PYTHON: 'external' },
  };
  const status = await diagnoseComponents(options, deps);
  assert.equal(inspected, 'bad-explicit');
  assert.equal(status.components.engine.explicit, true);
  await assert.rejects(
    prepareComponents(options, {
      ...deps,
      download() {
        throw new Error('must_not_download');
      },
    }),
    /explicit_invalid/,
  );
  await assert.rejects(stat(join(dataRoot, 'engine/installation.json')), { code: 'ENOENT' });
});
test('external Python validates read-only and does not require uv; valid engine is reused', async (t) => {
  const dataRoot = await fixture(t);
  const options = {
    dataRoot,
    env: { PRIME_AGENT_CLI: 'external-engine', PRIME_AGENT_KERNEL_PYTHON: 'external-python' },
  };
  const deps = {
    checkNode() {},
    validateEngine: async () => ({
      path: 'external-engine',
      packageDir: 'package',
      version: COMPONENT_POLICY.engine,
      bash: 'bash',
    }),
    validateUv: async () => {
      throw new Error('must_not_probe_uv');
    },
    execute: async () => 'studio-shell-ok',
    ensureKernel: async ({ readOnly, env }) => {
      assert.equal(readOnly, true);
      assert.equal(env.PRIME_AGENT_KERNEL_PYTHON, 'external-python');
      return 'external-python';
    },
  };
  const status = await diagnoseComponents(options, deps);
  assert.equal(status.ready, true);
  assert.equal(status.components.uv.status, 'not_required');
  assert.deepEqual(await readdir(dataRoot), []);
});
test('tar validates all paths and types before extraction, rejects Windows aliases, links and duplicate paths', async (t) => {
  const root = await fixture(t);
  for (const name of [
    '../outside',
    '/root',
    'C:/x',
    'package/../../escape',
    'package\\x',
    'package/a:stream',
    'package/NUL.txt',
    'package/a.',
    'package/a /x',
  ])
    assert.throws(() => archivePath(root, name), /unsafe_archive/);
  for (const entries of [
    [{ name: '../outside' }],
    [{ name: 'link', type: '2' }],
    [{ name: 'link', type: '1' }],
    [{ name: 'package/x' }, { name: 'package/X' }],
    [{ name: 'safe' }, { name: '../bad' }],
  ]) {
    await assert.rejects(extractTgz(tar(entries), join(root, 'bad')), /unsafe_archive/);
    await assert.rejects(stat(join(root, 'bad')), { code: 'ENOENT' });
  }
  await extractTgz(tar([{ name: 'package/été/file.txt', text: 'verified' }]), join(root, 'good'));
  assert.equal(await readFile(join(root, 'good/package/été/file.txt'), 'utf8'), 'verified');
  await assert.rejects(extractTgz(tar([{ name: 'x' }]), join(root, 'good')), { code: 'EEXIST' });
  await assert.rejects(extractZip(Buffer.from('not a zip'), join(root, 'zip')));
  await assert.rejects(extractTgz(Buffer.from('not gzip'), join(root, 'tgz')));
});
test('official installer origin contract, exact inventory match and corrupt digests fail closed', () => {
  assert.equal(
    releaseOrigin('prime_agent_base_url="${PRIME_AGENT_DOWNLOAD_BASE_URL:-https://official.example}"'),
    'https://official.example',
  );
  for (const text of [
    'changed',
    'prime_agent_base_url="${PRIME_AGENT_DOWNLOAD_BASE_URL:-http://example.com}"',
  ])
    assert.throws(() => releaseOrigin(text));
  assert.equal(checksum('a'.repeat(64) + '  engine.tgz\n', 'engine.tgz'), 'a'.repeat(64));
  assert.throws(() => checksum('a'.repeat(64) + '  other.tgz', 'engine.tgz'), /checksum_missing/);
  assert.throws(
    () => checksum(('a'.repeat(64) + '  engine.tgz\n').repeat(2), 'engine.tgz'),
    /checksum_missing/,
  );
  assert.throws(() => verifyDigest(Buffer.from('corrupt'), '0'.repeat(64)), /checksum_mismatch/);
});
test('engine 0.9.8 release source and SHA-256 are pinned; rotated inventory fails closed', () => {
  // Short-term issue #10 fix: engine downloads never parse the mutable install.sh.
  assert.deepEqual([...ALLOWED_ENGINE_ORIGINS], [
    'https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev',
  ]);
  const releaseUrl = `${ALLOWED_ENGINE_ORIGINS[0]}/releases/v${COMPONENT_POLICY.engine}`;
  assert.equal(releaseUrl, 'https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/releases/v0.9.8');
  assert.match(COMPONENT_POLICY.engineSha256, /^[a-f0-9]{64}$/);
  // Exact official SHA256SUMS entries captured 2026-10-21; all four artifacts verified byte-for-byte.
  const inventory = [
    'd7b72785119efc28bfbca8ec4a7f47a1fcdcf47fcd8cebdb60bffaa79e3e1274  prime-agent-0.9.8.tgz',
    '3efd07d12eafa4c3f1a9fdb16420c276f9162482498ef29e07de4704c2c5c669  prime-agent-ai-0.9.8.tgz',
    '301b7c0c2598fce5378ac26063c531b22424e44e3e8dbc2f179e796cfa1928b4  prime-agent-core-0.9.8.tgz',
    'fd161813688e5e4bea0ae6847779e0e4d33525e8145380979119229dd27165d4  prime-agent-tui-0.9.8.tgz',
  ].join('\n') + '\n';
  assert.equal(checksum(inventory, 'prime-agent-0.9.8.tgz'), COMPONENT_POLICY.engineSha256);
  for (const [name, sha] of Object.entries(COMPONENT_POLICY.engineDeps))
    assert.equal(checksum(inventory, name), sha);
  assert.equal(Object.keys(COMPONENT_POLICY.engineDeps).length, 3);
  const rotated = `e${inventory.slice(1)}`;
  assert.notEqual(checksum(rotated, 'prime-agent-0.9.8.tgz'), COMPONENT_POLICY.engineSha256);
  assert.throws(() => checksum(inventory, 'prime-agent-0.9.8-windows-x64.zip'), /checksum_missing/);
});
test('prepareComponents never fetches install.sh and fails closed on rotated engine inventory', async (t) => {
  const dataRoot = await fixture(t);
  const fetched = [];
  const npmTar = tar([{ name: 'package/bin/npm-cli.js', text: 'console.log("10.9.4")\n' }]);
  const { createHash } = await import('node:crypto');
  const integrity = `sha512-${createHash('sha512').update(npmTar).digest('base64')}`;
  assert.match(integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
  const releaseUrl = `${ALLOWED_ENGINE_ORIGINS[0]}/releases/v${COMPONENT_POLICY.engine}`;
  const rotatedInventory = [
    'e7b72785119efc28bfbca8ec4a7f47a1fcdcf47fcd8cebdb60bffaa79e3e1274  prime-agent-0.9.8.tgz',
    '3efd07d12eafa4c3f1a9fdb16420c276f9162482498ef29e07de4704c2c5c669  prime-agent-ai-0.9.8.tgz',
    '301b7c0c2598fce5378ac26063c531b22424e44e3e8dbc2f179e796cfa1928b4  prime-agent-core-0.9.8.tgz',
    'fd161813688e5e4bea0ae6847779e0e4d33525e8145380979119229dd27165d4  prime-agent-tui-0.9.8.tgz',
  ].join('\n') + '\n';
  const download = async (url) => {
    fetched.push(url);
    if (url.includes('install.sh')) throw new Error('must_not_fetch_installer');
    if (url === `https://registry.npmjs.org/npm/${COMPONENT_POLICY.npm}`)
      return Buffer.from(
        JSON.stringify({
          version: COMPONENT_POLICY.npm,
          dist: {
            tarball: `https://registry.npmjs.org/npm/-/npm-${COMPONENT_POLICY.npm}.tgz`,
            integrity,
          },
        }),
      );
    if (url === `https://registry.npmjs.org/npm/-/npm-${COMPONENT_POLICY.npm}.tgz`) return npmTar;
    if (url === `${releaseUrl}/SHA256SUMS`) return Buffer.from(rotatedInventory);
    throw new Error(`unexpected_download:${url}`);
  };
  const deps = {
    checkNode() {},
    download,
    execute: async (path, args) => (args.includes('--version') ? COMPONENT_POLICY.npm : 'studio-shell-ok'),
    validateEngine: async () => {
      throw new Error('must_not_validate_rotated_engine');
    },
  };
  const error = await prepareComponents(
    { dataRoot, env: { PRIME_AGENT_KERNEL_PYTHON: 'external-python' } },
    deps,
  ).then(
    () => null,
    (failure) => failure,
  );
  assert.equal(error?.message, 'source_contract_changed');
  assert.equal(error?.component, 'engine');
  assert.ok(fetched.includes(`${releaseUrl}/SHA256SUMS`));
  assert.ok(!fetched.some((url) => url.includes('install.sh')), 'engine downloads never parse install.sh');
});
test('local network fixtures cover byte progress, size limits, redirect downgrade and cancellation', async (t) => {
  const server = createServer((req, res) => {
    if (req.url === '/large') {
      res.writeHead(200, { 'content-length': 1000 }).end('x');
      return;
    }
    if (req.url === '/slow') {
      res.writeHead(200);
      res.write('start');
      return;
    }
    res.writeHead(200, { 'content-length': 4 }).end('done');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const progress = [];
  assert.equal(
    (await download(url, { allowLocal: true, onProgress: (p) => progress.push(p) })).toString(),
    'done',
  );
  assert.equal(progress.at(-1).received, 4);
  assert.equal(progress.at(-1).total, 4);
  await assert.rejects(download(url), /source_invalid/);
  await assert.rejects(download(url + '/large', { allowLocal: true, limit: 10 }), /download_too_large/);
  await assert.rejects(
    download('https://official.test', {
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: url } }),
    }),
    /source_invalid/,
  );
  const abort = new AbortController();
  await assert.rejects(
    download(url + '/slow', { allowLocal: true, signal: abort.signal, onProgress: () => abort.abort() }),
  );
});
test('a living installation lock cannot expire; an abandoned lock is recovered', async (t) => {
  const root = await fixture(t),
    lock = join(root, 'install.lock');
  await writeFile(lock, JSON.stringify({ pid: process.pid, createdAt: Date.now() - 999999 }));
  await assert.rejects(acquireLock({ lock }, { timeout: 150 }), /cours/);
  assert.equal(JSON.parse(await readFile(lock)).pid, process.pid);
  await writeFile(lock, JSON.stringify({ pid: 2147483647, createdAt: Date.now() - 999999 }));
  const release = await acquireLock({ lock }, { timeout: 1000 });
  await release();
  await assert.rejects(stat(lock), { code: 'ENOENT' });
});

test(
  'fully validated explicit engine/uv can activate without fabricated archive receipts',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = await fixture(t),
      packageDir = join(root, 'external');
    await mkdir(join(packageDir, 'dist/bundle'), { recursive: true });
    await writeFile(
      join(packageDir, 'package.json'),
      JSON.stringify({
        name: 'prime-agent',
        version: COMPONENT_POLICY.engine,
        engines: { node: '>=22.8.0' },
        bin: { 'prime-agent': 'dist/bundle/cli.js' },
      }),
    );
    const cli = join(packageDir, 'dist/bundle/cli.js'),
      python = join(root, 'python.exe'),
      uv = join(root, 'uv.exe');
    await writeFile(cli, '#!/usr/bin/env node\n');
    await writeFile(join(packageDir, 'dist/bundle/cli-node.js'), '#!/usr/bin/env node\n');
    await writeFile(python, 'external validated interpreter fixture');
    const pe = Buffer.alloc(96);
    pe.writeUInt32LE(64, 60);
    pe.writeUInt32LE(0x4550, 64);
    pe.writeUInt16LE(0x8664, 68);
    await writeFile(uv, pe);
    const receipt = {
      schema: 1,
      validatedAt: new Date().toISOString(),
      shellValidated: true,
      components: {
        engine: { path: cli, version: COMPONENT_POLICY.engine, source: 'explicit' },
        python: { path: python, source: 'explicit' },
        uv: { path: uv, version: COMPONENT_POLICY.uv, source: 'explicit' },
      },
    };
    const env = { PRIME_AGENT_CLI: cli, PRIME_AGENT_KERNEL_PYTHON: python, PRIME_GUI_UV: uv };
    await atomicJson(join(root, 'engine/installation.json'), receipt);
    assert.equal((await quickComponentReceipt({ dataRoot: root, env })).ok, true);
    assert.equal(
      (
        await quickComponentReceipt({
          dataRoot: root,
          env: { ...env, PRIME_AGENT_CLI: join(root, 'other.js') },
        })
      ).reason,
      'explicit_changed',
    );
    // Never infer user consent merely from an old explicit source marker.
    assert.equal(
      (await quickComponentReceipt({ dataRoot: root, env: { PRIME_AGENT_KERNEL_PYTHON: python } })).reason,
      'receipt_changed',
    );
    receipt.components.engine.source = 'managed';
    await atomicJson(join(root, 'engine/installation.json'), receipt);
    assert.equal((await quickComponentReceipt({ dataRoot: root, env })).reason, 'receipt_changed');
    receipt.components.engine.source = 'explicit';
    receipt.components.uv.source = 'managed';
    await atomicJson(join(root, 'engine/installation.json'), receipt);
    assert.equal((await quickComponentReceipt({ dataRoot: root, env })).reason, 'receipt_changed');
    receipt.components.uv.source = 'explicit';
    receipt.shellValidated = false;
    await atomicJson(join(root, 'engine/installation.json'), receipt);
    assert.equal((await quickComponentReceipt({ dataRoot: root, env })).reason, 'not_validated');
  },
);
