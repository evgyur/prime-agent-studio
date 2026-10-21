# Prime Agent engine v0.9.8 — redistribution research (read-only)

Date: 2026-10-21. Scope: can Prime Agent engine v0.9.8 be legally bundled inside Prime Agent Studio?
Method: read-only inspection of this repo, upstream GitHub source at tag `v0.9.8` and `main`,
the versioned R2 release artifacts Studio actually downloads, and the release metadata.
This is research, not legal advice. No legal certainty is claimed.

## 1. Short answer

- **MIT permission (established by evidence):** the v0.9.8 source and the four
  distribution tarballs are MIT-licensed (`package.json` `license: MIT`, MIT source text
  at tag `v0.9.8`). The MIT text permits redistribution subject to one condition:
  keep the copyright notice and permission notice in all copies or substantial portions.
- **Transitive audit (NOT completed):** the installed dependency closure
  (`node_modules` materialized by `npm install` at setup time) was not license-scanned.
  Its obligations are therefore unknown, and a compliant bundle checklist is incomplete
  until that scan exists. This gap does not revoke the MIT permission above; it scopes
  what is still missing before shipping engine bytes.

## 2. Studio does NOT bundle the engine today (pre-fix snapshot)

Snapshot at research date 2026-10-21 — an engine-pin worker is replacing this flow,
so re-validate paths, URLs, and receipts before relying on the details below.
At snapshot time, Studio downloads the engine on first run ("Repair");
it does not ship it in the installer:

- `scripts/build-desktop-resources.mjs` stages only `server.mjs`, `index.html`, `package.json`,
  `package-lock.json`, `LICENSE`, `lib`, `public`, `assets`, `runtime`, allowlisted scripts,
  then `npm ci`, `node.exe`, and a fetched `NODE-LICENSE`. No `prime-agent*.tgz` is staged.
- `src-tauri/tauri.conf.json` bundles `../.desktop-build/` as `backend/`. Same content, no engine.
- `lib/desktop-components.mjs` (`COMPONENT_POLICY.engine = '0.9.8'`) downloads at runtime:
  reads origin contract from `https://app.primeintellect.ai/prime-agent/install.sh`,
  resolves `https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev`,
  verifies `releases/v0.9.8/SHA256SUMS`, then fetches and verifies the four tarballs.
- `docs/desktop.md` and `docs/en/desktop.md` describe this "Repair downloads" flow.

So "bundling the engine" would be a **new distribution act**, not a description of today.

## 3. Public GitHub source license (do not confuse with the bundle)

- Repo: `https://github.com/PrimeIntellect-ai/prime-agent` — README states
  "Prime Agent is fully open source and released under the [MIT License](LICENSE)".
- Raw license (`main`, fetched 2026-10-21):
  `https://raw.githubusercontent.com/PrimeIntellect-ai/prime-agent/main/LICENSE`
  = MIT text, `Copyright (c) 2025-2026 Prime Intellect Ltd.`, plus a port note:
  "originally Copyright (c) 2025 Mario Zechner, used under the MIT License."
- License at the pinned tag (this is the version that matters for v0.9.8):
  `https://raw.githubusercontent.com/PrimeIntellect-ai/prime-agent/v0.9.8/LICENSE`
  = MIT text, `Copyright (c) 2025 Mario Zechner` + `Copyright (c) 2026 Prime Intellect`.
- GitHub License API (`/repos/PrimeIntellect-ai/prime-agent/license`) returns
  `spdx_id: NOASSERTION` / `key: other` even though the text is MIT — tooling quirk,
  read the text, not the API label.
- Source package identity at tag: `packages/coding-agent/package.json` is
  `"name": "@earendil-works/pi-coding-agent", "license": "MIT", "author": "Mario Zechner"`.
  Release packaging renames it to `prime-agent` (see bundle README "hard fork of pi-mono" note).

## 4. Distributed v0.9.8 bundle licenses (what Studio downloads)

Release: `https://github.com/PrimeIntellect-ai/prime-agent/releases/tag/v0.9.8`
(published 2026-09-29, `target_commitish 7d442aafa985f9342134fac16c2ef41f03fb45c1`).
R2 inventory verified 2026-10-21
(`https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/releases/v0.9.8/SHA256SUMS`):

| Artifact | SHA256 (full) | `package.json` license |
|---|---|---|
| `prime-agent-0.9.8.tgz` (11,337,226 B) | `d7b72785119efc28bfbca8ec4a7f47a1fcdcf47fcd8cebdb60bffaa79e3e1274` | `MIT`, author Mario Zechner |
| `prime-agent-ai-0.9.8.tgz` (532,602 B) | `3efd07d12eafa4c3f1a9fdb16420c276f9162482498ef29e07de4704c2c5c669` | `MIT`, author Mario Zechner |
| `prime-agent-core-0.9.8.tgz` (62,441 B) | `301b7c0c2598fce5378ac26063c531b22424e44e3e8dbc2f179e796cfa1928b4` | `MIT`, author Mario Zechner |
| `prime-agent-tui-0.9.8.tgz` (452,664 B) | `fd161813688e5e4bea0ae6847779e0e4d33525e8145380979119229dd27165d4` | `MIT`, author Mario Zechner |

Verified by downloading each tarball and comparing hashes (all match).
Findings inside the tarballs:

- **No `LICENSE`, `NOTICE`, `THIRD-PARTY`, or `EULA` file** in any of the four tarballs
  (searched all member names; only `package.json` files matched license-like names).
- `prime-agent-0.9.8.tgz` top level is only
  `package/{package.json, CHANGELOG.md, README.md, postinstall.cjs}` + `dist/docs/examples/skills`.
- `package.json` dependencies of the main tarball pin the other three by exact R2 URL plus
  public npm deps (`@agentclientprotocol/sdk`, `@modelcontextprotocol/sdk`,
  `@silvia-odwyer/photon-node`, `chalk`, `diff`, `undici`, `yaml`, etc.,
  `optionalDependencies @mariozechner/clipboard`). Transitive `node_modules` are
  **not** in the tarball — Studio's `desktop-components.mjs` runs `npm install`
  (`--ignore-scripts`, `--install-strategy=nested`) which materializes them at setup time.
- `registry.npmjs.org/prime-agent` (and `/prime-agent/0.9.8`) returns **404**:
  there is no public npm-registry license record; the R2 tarballs + GitHub release
  are the canonical distribution evidence for v0.9.8.
- No click-through EULA or redistribution prohibition was found in the release body,
  the `SHA256SUMS` file, or the tarball README. The tarball README documents
  `curl .../install.sh | sh` installation, not license terms.

## 5. Third-party requirements

- Engine tarballs themselves: MIT (per `package.json`), but with **no bundled notice text**.
  Anyone redistributing should include the MIT copyright + permission text for:
  `prime-agent`, `prime-agent-ai`, `prime-agent-core`, `prime-agent-tui`
  (v0.9.8 copyright: Mario Zechner + Prime Intellect), and preserve the upstream
  port/attribution note from `main` where applicable.
- Transitive dependencies: the main tarball's `package.json` names direct dependencies
  (e.g. `@agentclientprotocol/sdk`, `@modelcontextprotocol/sdk`,
  `@silvia-odwyer/photon-node`, `chalk`, `diff`, `undici`, `yaml`,
  `optionalDependencies @mariozechner/clipboard`), but their licenses were **not audited
  here and no spread is claimed**. The installed `node_modules` closure was not scanned,
  so its license obligations are unknown. A shipped `node_modules` tree would need
  a generated third-party notice/SBOM from the actual installed tree; Studio has no such
  generator for the engine tree today (contrast: Studio already fetches `NODE-LICENSE`
  for its bundled Node, and pins `LICENSE.cua-driver.md` for the CUA driver — follow that pattern).
- Other bundled runtimes stay separate: Node (its own license, already fetched),
  npm 10.9.4 (registry tarball + SHA-512 integrity), uv 0.8.22 (`.sha256`),
  Python 3.11 via uv, Git Bash (not bundled — user installs separately),
  Segoe UI font (system font, must not ship — see `SKILLS/README.md`).
- Services and trademarks are outside the MIT grant: model providers/subscriptions,
  Prime Inference, and provider ToS (API keys, subscription auth) still apply at use time;
  MIT does not grant the "Prime Agent" / "Prime Intellect" marks and does not imply endorsement.

## 6. Obligations if Studio bundles v0.9.8 (MIT conditions)

1. Include the MIT copyright notice + permission notice for each bundled MIT component
   in all copies / substantial portions (a `LICENSES/` dir + About/Settings notice is the clean way).
2. Do not strip existing `package.json` license/author fields or upstream attribution notes.
3. Add a third-party notices file covering the full installed dependency closure
   (generate from the installed engine `node_modules`, not just the four top-level tarballs).
4. Keep the existing integrity story: pinned version + `SHA256SUMS` verification + fixed
   `ALLOWED_ENGINE_ORIGINS`, and record provenance (`provenance`, `sha256`, `installer`)
   as `installation.json` already does.
5. Mark the engine as vendored Studio content (version, source URL, SHA256, license file path)
   in receipts/About, following the `VERSION` + `SHA256SUMS` + `source.json` pattern used for CUA.
6. surface that the engine is MIT "AS IS" without warranty, and that providers/services
   have separate terms.

## 7. Uncertainty and limits

- MIT interpretation, "substantial portion" scope, and trademark limits were not
  legally reviewed; this report states what the evidence shows, not a legal conclusion.
- Upstream `main` has since moved (Rust builds; current `install.sh` is a Rust installer).
  This note covers **only the TS v0.9.8 tarball line** Studio pins. Later versions need re-validation.
- The installer-flow description in §2 is a pre-fix snapshot (engine-pin worker in progress).
- Transitive closure: dependency names were read from `package.json`, but no
  installed-tree license scan was performed, so per-dependency obligations
  (including any `NOTICE` files) remain unverified.
- No contributor-license / patent-grant review beyond the MIT text itself.

## 8. Options (product decision)

1. **Option A — keep Repair-time download with explicit user consent.**
   Effect: no redistribution of engine bytes; only the MIT permission question is avoided
   because no copy is shipped. Trade-off: requires network at first run.
2. **Option B — bundle engine bytes.**
   Prerequisites before release: (a) vendor the four pinned tarballs byte-identical
   (verify against full SHAs in §4); (b) add `LICENSE.prime-agent-0.9.8.md` (MIT text with both
   copyright lines); (c) complete the transitive license scan and ship the generated
   `THIRD-PARTY-NOTICES` for the installed closure; (d) add `source.json`
   (URLs, tag `v0.9.8`, commit `7d442aa`, SHAs) next to the payload;
   (e) surface notices in-app (Settings → Components / About) and in the installer bundle.
3. Either way, re-run this check for every engine version bump.

## 9. Key sources (all fetched 2026-10-21 unless noted)

- `https://github.com/PrimeIntellect-ai/prime-agent` (README: MIT claim)
- `https://raw.githubusercontent.com/PrimeIntellect-ai/prime-agent/v0.9.8/LICENSE` (MIT, Zechner + Prime Intellect)
- `https://raw.githubusercontent.com/PrimeIntellect-ai/prime-agent/main/LICENSE` (MIT, Prime Intellect Ltd. + port note)
- `https://api.github.com/repos/PrimeIntellect-ai/prime-agent/license` (quirk: `NOASSERTION`)
- `https://github.com/PrimeIntellect-ai/prime-agent/releases/tag/v0.9.8` + `.../releases/tags/v0.9.8` API (assets, SHAs, dates)
- `https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/releases/v0.9.8/SHA256SUMS` (hash table §4)
- `https://app.primeintellect.ai/prime-agent/install.sh` (origin contract; current copy is Rust-era — channel only)
- This repo: `lib/desktop-components.mjs`, `scripts/build-desktop-resources.mjs`,
  `src-tauri/tauri.conf.json`, `docs/desktop.md`, `README.md` (§ License and attribution).
