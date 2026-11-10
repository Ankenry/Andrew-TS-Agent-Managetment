# Candidate-only build recipe

**DO NOT RUN full compilation in the current RAM window.** This bundle is source/evidence, not a binary and not deployment approval. No uploads or remote-host access have been performed. A different host needs explicit authorization/access first. Commands below describe the next approved build window; they were NOT run in the source-patch phase.

## Exact input

Official repository https://github.com/openai/codex.git, tag `rust-v0.166.0`, commit `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`, Apache-2.0. Start a NEW independent checkout/copy; never reset/checkout over the existing pristine/candidate. Verify original lock SHA256 `22bd51f50864ce40f6686f3350c0547fdd50a8213240f54435ed394f68bf08e6`.

1. In the fresh checkout, `git apply --check /absolute/bundle/approved-lock.patch`, then apply that patch. Verify lock `360ea1e0ec391255ffc153a73548be524aa5d50c3476f247631cec184c21d4cb`.
2. First build this **unpatched UI, normalized-lock** source. It is not the pristine original-lock build. Keep its successful binary/log/hash separately before applying the UI patch.
3. Then `git apply --check /absolute/bundle/tui-context.patch`, apply it, verify every path/hash/mode in `candidate-manifest.json`, and build with the same profile/env/features. `source.patch` combines both steps for source reconstruction only; applying it immediately does not supply unpatched smoke evidence.

`patch-apply-verification.json` proves that applying the combined patch to NEW copies of the original files reproduces all18 candidate file bytes exactly (17 TUI + approved lock). It does not typecheck or build them.

## Isolated prerequisites and build environment

Rust/Cargo1.95.0, host x86_64-unknown-linux-gnu, target x86_64-unknown-linux-musl, Zig0.14.0. Reuse the verified task-local installations/cache; no global install, source/lock/feature edits, `cargo update`, or security bypass. If recreating prerequisites on an authorized host, use the exact official URLs/checksums in `tool-download-manifest.json`, `release-deps-download.json`, `native-packages.json`, `v8-download.json`. Existing task native libraries are enumerated by `native-libs-manifest.json`.

The source/lock pins V8 crate152.2.0 and git350c5a859a9b3c84ab8701b3ad51e3b7699b30c0; use verified ptrcomp+sandbox musl archive/binding. Static libcap2.75 and OpenSSL3.6.4 are required; keep official sandbox/features. No global cc agent wrapper. Recreate reviewed task-local gcc/musl/Zig wrappers and native discovery paths; a different OS/toolchain layout needs review, not guessing.

`build-env.template.json` is the earlier reviewed build-only environment allowlist. Replace literal `${TASK_ROOT}` in VALUES with the absolute task root using Python string replacement (not shell eval). It contains no auth env. Preserve HOME/CODEX_HOME; never copy the full current environment into artifacts. The template retains Linux host paths such as libclang21; verify them on an authorized different host. Toolchain/cache directories must remain inside the task. No-space task alias may be needed for native scripts; do not change workspace identity.

`low-memory-profile.toml` is explicitly supplied with Cargo `--config`; it does not edit Cargo.toml or global config. Whole release lto=false, CGU64, debug0; only codex-core opt1; other packages opt3. Release assertions/overflow/panic/features remain unchanged. This is a custom profile, not an official/reproducible release claim. Runtime speed/size are unbenchmarked; source-line debug info is absent.

Before every authorized compilation, check free disk and current memory once; require headroom and enforce hardcap40GiB. Use jobs1/nice10 and the owning `task-build-guard.py` with RSS budget and proactive MemAvailable threshold approved for that window. Current settings are RSS3GiB, available2.25GiB, footprint39.5GiB, sample0.25s. Do not wait/poll for memory, stop unrelated processes, add swap or reuse an old attempt marker. Guard owns Popen through wait and records actual exit/guard reason; it monitors only the command it starts.

## Commands inside codex-rs (ONLY after resource-window approval)

Absolute task Cargo, with the reviewed env loaded:

```text
cargo --config /absolute/bundle/low-memory-profile.toml build --locked --offline --release --target x86_64-unknown-linux-musl --bin bwrap
```

Keep a copy/hash of the produced bwrap, strip that NEW artifact with the reviewed strip tool (`--strip-debug --strip-unneeded`) as in the official release prep, and set `CODEX_BWRAP_SHA256` to its actual SHA256 before CLI compilation. Do not assume a checksum from a different build. The earlier successful task bwrap hash is recorded in `bwrap-digest.json`.

```text
cargo --config /absolute/bundle/low-memory-profile.toml build --locked --offline --release --target x86_64-unknown-linux-musl -p codex-cli --bin codex
```

Run this once for normalized unpatched source, then after applying UI patch with the SAME env/profile. Stop on errors/guard; no retry loop, lock edits or sandbox/feature disabling. Missing cached pinned artifacts are an access/preparation issue, not authority to upgrade dependencies.

On a sufficiently provisioned approved window, compile/run focused integration tests:

```text
cargo --config /absolute/bundle/low-memory-profile.toml test --locked --offline --release --target x86_64-unknown-linux-musl -p codex-tui --lib context_progress -- --nocapture
```

This command DOES pull the full TUI/core/app-server test graph. It was deliberately not run now. Review regression suites for status, compaction, review/model/session, composer cursor/height/popups/voice/images. Native one-row changes affect existing ChatWidget snapshots; inspect each intended delta, do not bulk accept. Run VT100 matrix, and an isolated real-PTY fixture once the binary exists; neither is proven by pure text tests.

## Startup, resources and remaining gates

After successful builds, use only pure diagnostics: local binary `--version`, `--help`, and `app-server generate-json-schema --out <NEW task directory>`. Compare schema/protocol to installed0.166.0 and normalized-unpatched build. No inference, account changes, new live thread, MCP bootstrap or service start for this check. Version alone is insufficient.

Assemble a NEW local package layout matching `codex-package.json` layoutVersion1: bin/codex, matching code-mode-host and required companion binaries, codex-path/rg, codex-resources/bwrap plus official voice resources/manifests/licenses. Build required companions with the same approved graph/security features or explicitly record verified official resource copies; hash every file. Verify bwrap digest/discovery and V8 resources. Do not claim parity before these checks.

Only after all gates pass, present a separate rollout plan for graceful exit/resume of the exact existing Hanlead thread/tab/cwd, with current model/auth/permissions and context override872000 preserved. No rollout is included here. Rollback live uses the original installed binary with the same UUID/config; it never resets/deletes session data. Code rollback before rollout is the byte/mode snapshot or a NEW original+approved-lock tree, preserving candidate/evidence instead of overwriting unrelated changes.

## Tests already completed

- Pure production token/helper/state/row harness:7/7; actual modules included by path, existing cached rlibs, direct rustc only. Exact native formatter function fragment extracted with source hash, no reimplementation.
- Guard fake-process suite:7/7; includes nonzero exit, vanished files, scan failure, slow scans, RSS/memory/footprint stop receipts.
- rustfmt stable1.95 --check and diff whitespace checks pass; unstable imports_granularity setting is ignored with recorded warning.
- Patch apply/hash reconstruction PASS.

Missing: whole-TUI typecheck and integration tests, full CLI smoke, binary/companion/startup/schema parity, isolated real-PTY and live rollout. Original guard gap/unknown exit from the failed build remains in evidence and is not retroactively repaired by new guard tests.
