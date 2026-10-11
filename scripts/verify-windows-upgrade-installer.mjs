// Guarded per-build check of the generated Windows installer (manual step).
// Reads the generated installer.nsi + utils.nsh for THIS build plus pinned sources.
// Exit 0: generated guards checked. Exit 2: bundle not built. Exit 1: mismatch.
// String checks cover generated guards only; they do not prove pins always survive.
// No registry, shortcut, installer-run, or installed-app contact.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NSI = join(ROOT, 'src-tauri/target/release/nsis/x64/installer.nsi');
const UTILS = join(ROOT, 'src-tauri/target/release/nsis/x64/utils.nsh');
const failures = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}${cond || !detail ? '' : ` (${detail})`}`);
  if (!cond) failures.push(name);
};

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const conf = JSON.parse(readFileSync(join(ROOT, 'src-tauri/tauri.conf.json'), 'utf8'));
if (!existsSync(NSI) || !existsSync(UTILS)) {
  console.log('SKIP - generated NSIS not present; build the Tauri release bundle first, then re-run.');
  process.exit(2);
}
const nsi = readFileSync(NSI, 'utf8');
const utils = readFileSync(UTILS, 'utf8');
const binary = (conf.bundle?.windows?.nsis?.mainBinaryName ?? 'prime-agent-studio').replace(/\.exe$/, '');

// Exact nesting scan: removal lines must sit inside an UpdateMode<>1 ${If} block.
const section = nsi.slice(
  nsi.indexOf('Section Uninstall'),
  nsi.indexOf('\nSectionEnd', nsi.indexOf('Section Uninstall')),
);
const stack = [];
const guarded = { unpin: false, jumpList: false, run: false };
for (const line of section.split('\n')) {
  if (line.includes('${EndIf}')) stack.pop();
  else if (line.includes('${If}') || line.includes('${IfNot}')) stack.push(line);
  const insideUpdateGuard = stack.some((s) => s.includes('$UpdateMode <> 1'));
  if (line.includes('!insertmacro UnpinShortcut')) guarded.unpin ||= insideUpdateGuard;
  if (line.includes('!insertmacro DeleteAppUserModelId')) guarded.jumpList ||= insideUpdateGuard;
  if (line.includes('DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run"'))
    guarded.run ||= insideUpdateGuard;
}

check(
  'NSIS generated for this package version',
  nsi.includes(`!define VERSION "${pkg.version}"`),
  pkg.version,
);
check('main binary name stable', nsi.includes(`!define MAINBINARYNAME "${binary}"`), binary);
check('bundle id stable', nsi.includes(`!define BUNDLEID "${conf.identifier}"`), conf.identifier);
check('updater /UPDATE flag parsed', /\$\{GetOptions\} \$CMDLINE "\/UPDATE" \$UpdateMode/.test(nsi));
check('unpin stays inside update guard', guarded.unpin);
check('jump-list wipe stays inside update guard', guarded.jumpList);
check('HKCU Run removal stays inside update guard', guarded.run);
check(
  'shortcut create/update fns return early on update',
  (nsi.match(/\$\{If\} \$UpdateMode = 1[\s\S]{0,120}?Return/g) || []).length >= 2,
);
check('passive relaunch keeps prior exe args (/R /ARGS)', /\/R[\s\S]{0,400}?\/ARGS/.test(nsi));
check(
  'shortcuts stamped with bundle AppUserModelID',
  nsi.includes('!insertmacro SetLnkAppUserModelId') && utils.includes('PKEY_AppUserModel_ID'),
);
check(
  'no custom NSIS hooks',
  !nsi.includes('!define NSIS_HOOK') && nsi.includes('!ifmacrodef NSIS_HOOK_PREINSTALL'),
);

if (failures.length > 0) {
  console.error(`\nverify-windows-upgrade-installer: ${failures.length} mismatch(es) in generated guards.`);
  process.exit(1);
}
console.log(`\nverify-windows-upgrade-installer: generated guards checked for ${pkg.version}.`);
