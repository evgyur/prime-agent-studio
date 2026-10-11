// Windows upgrade contract: autostart choice + taskbar pin survive in-app updates.
// Pinned sources only; no target/ artifacts, registry, shortcuts, or installer runs.
// Generated-installer guard checks live in scripts/verify-windows-upgrade-installer.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const tauriConf = JSON.parse(read('src-tauri/tauri.conf.json'));
const packageJson = JSON.parse(read('package.json'));
const mainRs = read('src-tauri/src/main.rs');
const cargoField = (f) => read('src-tauri/Cargo.toml').match(new RegExp(`^${f} = "([^"]+)"`, 'm'))[1];
const lockVersion = (n) =>
  read('src-tauri/Cargo.lock').match(new RegExp(`name = "${n}"\r?\nversion = "([^"]+)"`))[1];

test('upgrade identity is frozen', () => {
  assert.equal(tauriConf.productName, 'Prime Agent Studio');
  assert.equal(tauriConf.identifier, 'com.primeagent.studio');
  const nsis = tauriConf.bundle.windows.nsis;
  assert.ok(tauriConf.bundle.targets.includes('nsis'));
  assert.equal(nsis.installMode, 'currentUser');
  assert.equal(nsis.startMenuFolder, 'Prime Agent Studio');
  assert.ok(!nsis.installerHooks, 'stock NSIS template guards apply');
  assert.ok(!nsis.template, 'stock NSIS template guards apply');
  if (tauriConf.mainBinaryName) assert.equal(tauriConf.mainBinaryName, 'prime-agent-studio');
  assert.equal(cargoField('name'), 'prime-agent-studio');
  assert.equal(cargoField('version'), packageJson.version);
  assert.equal(tauriConf.version, '../package.json');
});

test('updater stays on the passive in-app path', () => {
  assert.equal(tauriConf.plugins.updater.windows.installMode, 'passive');
  assert.deepEqual(tauriConf.plugins.updater.endpoints, [
    'https://github.com/zerr0o/prime-agent-studio/releases/latest/download/latest.json',
  ]);
  assert.ok(tauriConf.plugins.updater.pubkey.length > 0);
  assert.equal(lockVersion('tauri-plugin-updater'), '2.11.0');
  assert.equal(lockVersion('tauri-plugin-autostart'), '2.5.1');
  assert.equal(lockVersion('auto-launch'), '0.5.0');
});

test('autostart stays wired to the live registry entry', () => {
  assert.match(
    mainRs,
    /tauri_plugin_autostart::init\(\s*tauri_plugin_autostart::MacosLauncher::LaunchAgent,\s*Some\(vec!\["--background"\]\)/,
  );
  assert.ok(!mainRs.includes('.app_name('));
  const stateCommand = mainRs.slice(
    mainRs.indexOf('fn desktop_state('),
    mainRs.indexOf('fn desktop_autostart('),
  );
  assert.match(stateCommand, /autolaunch\(\)\.is_enabled\(\)\.ok\(\)/);
  assert.match(mainRs, /fn desktop_autostart[\s\S]{0,400}?\.enable\(\)/);
  assert.match(mainRs, /fn desktop_autostart[\s\S]{0,400}?\.disable\(\)/);
});

test('both autostart consumers apply boolean-only state', () => {
  assert.match(read('public/settings.js'), /typeof state\?\.autostart === 'boolean'/);
  assert.match(read('desktop/desktop.js'), /typeof state.autostart === 'boolean'/);
});

test('generated-installer guard checks stay out of npm test', () => {
  const verifier = read('scripts/verify-windows-upgrade-installer.mjs');
  assert.match(verifier, /installer\.nsi/);
  assert.match(verifier, /UpdateMode/);
});
