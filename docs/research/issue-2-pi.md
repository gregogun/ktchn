# Issue #2: What can pi do for an unattended, contained run?

Source issue: gregogun/ktchn#2 (open, label `wayfinder:research`, 0 comments).
Pi version studied: `@earendil-works/pi-coding-agent` 0.74.0 (`pi --version`), installed under `/Users/gregogun/.nvm/versions/node/v23.8.0/lib/node_modules/@earendil-works/pi-coding-agent`. Shorthand below: `PI/` means that directory.

Method: read the bundled docs (`PI/docs/*.md`, `PI/README.md`) and the compiled source (`PI/dist/...`), and cross-checked docs against code. Web docs at pi.dev and the upstream repo were not fetched. Anything resting only on the docs or on inference is labeled.

## Short answer

1. **Sessions** are append-only JSONL trees written under `~/.pi/agent/sessions/--<cwd>--/` by default. They are resumed with `--continue`, `--session <path|id>`, `--resume`, or `--fork`, or driven in RPC with `switch_session`, `fork`, and `clone`. Caveat: the session file is created lazily, only after the first assistant message.
2. **Custom base URL: yes.** A custom provider in `models.json` takes `baseUrl`, `api`, `apiKey`, `headers`, and `compat`. The Anthropic client is built with `baseURL: model.baseUrl`. Keys can be a `!command`, an env var name, or a literal.
3. **Output stream:** `--mode json` writes one header line, then every session event as JSON lines on stdout. `--mode rpc` speaks LF-delimited JSONL over stdin/stdout with command responses, events, and extension UI requests.
4. **Telemetry** covers one install/changelog ping to pi.dev, sent only from interactive mode. Separately there is a version check to pi.dev, and an attribution-header path for OpenRouter and Cloudflare hosts. Both can be disabled. A GitHub download of `fd`/`rg` also exists, separate from telemetry.
5. **Skills:** pi discovers skills from several roots and injects them into the system prompt as an `<available_skills>` XML block. `--no-skills` turns off discovery from settings and default roots, while explicit `--skill` paths still load. Context files (`AGENTS.md`, `CLAUDE.md`) and `SYSTEM.md`/`APPEND_SYSTEM.md` are discovered by a separate path, so `--no-skills` alone does not make the context clean. `--no-context-files` covers the context files. `--system-prompt` replaces the base prompt. Full isolation needs several flags together. Exact coverage must be confirmed by a test run (see Gaps).

---

## 1. Where sessions are written and how a session is resumed

**Storage location.**
- Agent dir: `PI_CODING_AGENT_DIR` if set, else `~/.pi/agent` (`PI/dist/config.js` 359-372, `getAgentDir`).
- Session dir: `getDefaultSessionDir(cwd)` returns `<agentDir>/sessions/--<cwd with leading slash stripped and / \ : replaced by ->--`, creating the directory if missing (`PI/dist/core/session-manager.js` 212-219).
- Override: `--session-dir` flag, and `sessionDir` in settings. Precedence is in `PI/dist/main.js` (around 154-217). The env var name is `ENV_SESSION_DIR` (`PI/dist/config.js` 337-341). Docs: `PI/docs/settings.md` 164-170, 200-203; `PI/docs/sessions.md`.
- Local state observed: `~/.pi/agent/sessions/` contains per-cwd directories (ls only).

**Format.** JSONL tree where each entry has `id` and `parentId`. Session format version 3. Writes are append-only (`PI/docs/session-format.md`). Deletion is via `trash` according to the docs (`PI/docs/sessions.md`).

**Lazy creation.** The file is not written until the first assistant message: `PI/dist/core/session-manager.js` 264-276 (persistence) and 549-568 (lazy). Consequence: a run that is killed before its first assistant turn leaves no resumable session, and a resume target may not exist yet.

**Resume and selection flags.** Documented in `PI/docs/sessions.md` and `PI/dist/cli/args.js` (around 110-132, help text 214-232):
- `--continue` / `-c`: resume the most recent session. Selection is by mtime via `findMostRecentSession` (`session-manager.js` 994-1002). Sharp edge: when `--session-dir` is shared across cwds, this is not filtered by cwd (from reading the code, not run-tested).
- `--session <path|id>`: open a specific session.
- `--resume`: interactive picker.
- `--fork <...>`: branch from an existing session into a new file.
- `--no-session`: ephemeral, nothing written.
- `--session-dir <dir>`: custom store.

Selection and missing-cwd handling are in `PI/dist/main.js` 344 and 383-400. In non-interactive modes a session whose recorded cwd is missing is fatal.

**RPC session commands.** `switch_session`, `fork`, `clone`, and `get_state` are documented in `PI/docs/rpc.md` 161-190 (get_state) and 401-520 (session commands).

## 2. Custom base URL for a model proxy

**Yes, via `models.json`.** Path: `getModelsPath()` in `PI/dist/config.js` (around 359-372), i.e. `~/.pi/agent/models.json` by default. Docs: `PI/docs/models.md` (minimal and full examples, supported `api` values, `compat` flags, reload on `/model`); `PI/docs/custom-provider.md` (override a built-in provider's `baseUrl` through `pi.registerProvider`).

Supported `api` values per `PI/docs/models.md`: `openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai`.

Validation (`PI/dist/core/model-registry.js` 380-396):
- A non-built-in provider that defines models must set `baseUrl` and `apiKey`.
- A built-in provider with custom models may leave `baseUrl`/`apiKey`/`api` optional.
- An override-only config needs at least one of `baseUrl`, `headers`, `compat`, `modelOverrides`, or `models`.

**API key resolution.** `PI/dist/core/resolve-config-value.js` 1-14:
- Value starting with `!` runs the rest as a shell command and uses stdout (cached for the process lifetime).
- Otherwise an environment variable with that name is used if set, else the string is taken as a literal (not cached).
- Credential order is documented in `PI/docs/providers.md`: CLI `--api-key`, then `auth.json`, then env var, then `models.json` custom key. `auth.json` is mode 0600. This review did not read `~/.pi/agent/auth.json`.
- Headers and `authHeader` handling: `PI/dist/core/model-registry.js` 512-540.

**Anthropic client.** `PI/node_modules/@earendil-works/pi-ai/dist/providers/anthropic.js` 614-650 constructs the client with `baseURL: model.baseUrl` and the resolved `apiKey`. Built-in Anthropic default is `https://api.anthropic.com` (`pi-ai/dist/models.generated.js` 1602, 1619).

**Not confirmed:** whether `ANTHROPIC_BASE_URL` is honored anywhere. Only the explicit `baseURL` path was verified in code. Treat env-var base URL as unconfirmed.

**Local config observed.** `~/.pi/agent/models.json` contains an Ollama provider at `http://127.0.0.1:11434/v1` (inspected with a redacted grep; no secret values were printed).

## 3. What pi emits on its JSON / RPC output stream

**`--mode json`** (`PI/dist/modes/print-mode.js` 14-130; `PI/docs/json.md` 7-76):
- First line: the session header (`session.sessionManager.getHeader()`, lines 79-91).
- Then every session event via `session.subscribe`, one `JSON.stringify(event)` per line on stdout (lines 79-91). Event types are `AgentSessionEvent`s as listed in `PI/docs/json.md`.
- Stdout is protected by `takeOverStdout` (`PI/dist/core/output-guard.js` 1-20), which redirects stray writes to stderr.

**`--mode text`/print** (`print-mode.js` 99-115): prints the final assistant text. Exits 1 on error or abort.

**Mode selection** (`PI/dist/main.js` 75-85): `--mode rpc` and `--mode json` win. Otherwise print mode is used if `-p`/`--print` is given **or stdin is not a TTY**. A non-TTY stdin silently forces print mode.

**`--mode rpc`** (`PI/docs/rpc.md`; `PI/dist/modes/rpc/rpc-mode.js`):
- Framing: LF-only JSONL in both directions (`PI/dist/modes/rpc/jsonl.js` 8-48; `rpc.md` 27-36). Stdin reader is a line reader (rpc-mode.js around 257).
- Stdin: commands. Stdout: command responses plus events. Streaming behaviour for messages sent during a run is governed by `streamingBehavior` (`rpc.md` 55-64).
- Extension UI: `extension_ui_request` events (rpc-mode.js 27, 588-595). Dialog timeout is applied only if the request supplies one, so a dialog with no timeout can block an unattended run indefinitely (from code reading; not run-tested).
- Session commands: `switch_session`, `fork`, `clone`, `get_state` (`rpc.md` 161-190, 401-520).

## 4. What the telemetry module covers

Gate function, `PI/dist/core/telemetry.js` 1-8: `isInstallTelemetryEnabled(settingsManager)`. If `PI_TELEMETRY` is set, its truthiness decides (`1`, `true`, `yes`). Otherwise the `enableInstallTelemetry` setting decides. Documented in `PI/docs/settings.md` 44, 51-55 and `PI/README.md` 283-290, 629-631; flag in `PI/dist/cli/args.js` 326-327.

Items that can reach the network:

| Item | Where | Gate | Target |
|---|---|---|---|
| Install / changelog ping | `PI/dist/modes/interactive/interactive-mode.js` 615-651 | Interactive mode only; fresh install or changelog-detected update; skipped if `PI_OFFLINE` set; also gated by telemetry flag | `https://pi.dev/api/report-install?version=...` |
| Version check | `PI/dist/utils/version-check.js` 2, 43-46 | Skipped if `PI_SKIP_VERSION_CHECK` or `PI_OFFLINE` is set | `https://pi.dev/api/latest-version` |
| Attribution headers | `PI/dist/core/sdk.js` 27-40, 195-210 | Gated by telemetry flag; only added for OpenRouter and Cloudflare hosts | Headers on model requests to those providers |
| `fd` / `rg` binary download | `PI/dist/utils/tools-manager.js` 20-40, 98-110 | Used only when `fd`/`rg` are not on PATH | GitHub releases |

Notes:
- The install ping is not sent from print, JSON, or RPC modes (interactive-only per interactive-mode.js 615-651). Unattended runs in json/rpc therefore do not emit it, per code.
- `tools-manager` runs for `fd`/`rg` through `ensureTool` (`find.js` 158, `grep.js` 95, `interactive-mode.js` 389). Whether it runs in non-interactive modes via `find`/`grep` tool calls is by code reading; a network download can happen during a tool call. Whether `--offline` (if it exists) covers it is **unconfirmed**.
- Telemetry flag does not cover `fd`/`rg` downloads or the version check.

## 5. How skills are loaded, and whether discovery can be turned off

**Discovery roots.** `PI/docs/skills.md` 20-41 lists the locations; the `.agents/skills` walk is in `PI/dist/core/package-manager.js` 262-270 (walks from cwd up to git root). Agent Skills standard frontmatter, including `disable-model-invocation` (`skills.md` 137-149). Settings: `PI/docs/settings.md` (skills setting, `enableSkillCommands` at line 203).

**Injection.** `formatSkillsForPrompt` (`PI/dist/core/skills.js` 261-282) emits an `<available_skills>` XML block. `loadSkills` (skills.js 305-404) handles `includeDefaults`; explicit `--skill` paths are loaded. The system prompt builder (`PI/dist/core/system-prompt.js` 19-41, 111-115) appends skills and context files to a custom prompt, and has a default branch.

**Flags:**
- `--no-skills`: `PI/dist/core/resource-loader.js` 292-294. When `noSkills` is true, skill paths are the CLI-enabled skills plus `additionalSkillPaths`; settings and default-root skills (`enabledSkills`) are dropped. So `--no-skills` removes pi's own discovery, while `--skill <path>` still adds explicit skills. Verified by reading the ternary only.
- `--skill <path>`: explicit load (`skills.js` 305-404; `args.js` 62-63).
- `updateSkillsFromPaths` with `includeDefaults` false: `resource-loader.js` 231-294, 323, 344-360.
- Context files (`AGENTS.md`, `CLAUDE.md`): `--no-context-files` (`args.js` 110-132); discovery in `resource-loader.js` 661-685. These are separate from skills, so `--no-skills` does not remove them.
- `SYSTEM.md` and `APPEND_SYSTEM.md` are discovered in `resource-loader.js` (around 661-685), independent of `--no-skills`. Replacement and append: `--system-prompt`, `--append-system-prompt`.
- Extensions: `--no-extensions`. Tools: `--tools` and `--no-builtin-tools`.

**Result for ktchn.** Likely recipe for "only what ktchn injects": `--no-skills --no-context-files --no-extensions --system-prompt <file>` (or `--append-system-prompt` if built-in base prompt is wanted), plus `--skill <kitchen-skill-path>` for each injected skill, and `--no-session` or an explicit `--session-dir`. **Not run-tested.** Whether `SYSTEM.md`/`APPEND_SYSTEM.md` in `~/.pi/agent` or the project still get picked up under these flags needs a test with a fixture home.

## Gaps and risks for ktchn

1. **Lazy session files.** No file until the first assistant message. A park (ADR 0007) before the first turn produces nothing to resume. Ktchn should either force an initial write or treat "no session file" as a restart, not a resume.
2. **`--continue` is not cwd-scoped when `--session-dir` is shared.** Use one session dir per sandbox/run, or pass `--session` explicitly.
3. **Non-TTY stdin forces print mode.** A launcher that does not allocate a TTY will not get interactive mode; use `--mode json` or `--mode rpc` explicitly so behaviour does not depend on the TTY.
4. **Env var fallback is a literal.** `resolveConfigValue` treats an unset env var name as a literal string, so a typo in an `apiKey` env name becomes the key value sent to the proxy. Ktchn should use `!command` or verify the variable is set (ADR 0005: keys stay on the host, so the sandbox should never hold the key at all; the proxy should inject it).
5. **Base URL env var unconfirmed.** Use `models.json` `baseUrl` explicitly; do not rely on `ANTHROPIC_BASE_URL`.
6. **Stdout hygiene.** JSON stream relies on `takeOverStdout`. Ktchn's parser should tolerate non-JSON lines on stdout as a defensive measure and treat stderr as log.
7. **RPC dialogs can block.** Extension UI requests may wait indefinitely if no timeout is supplied. Run with `--no-extensions` so none exist, or have the host answer every `extension_ui_request`.
8. **Install ping and version check go to pi.dev.** Set `PI_TELEMETRY=0`, `PI_SKIP_VERSION_CHECK=1`, and `PI_OFFLINE=1` in the sandbox. Note `PI_OFFLINE` may not cover the `fd`/`rg` GitHub download (unconfirmed). Pre-install `fd` and `rg` in the sandbox image to avoid it.
9. **Skill discovery roots, including `.agents/skills` walking up to git root,** are a leak path if the sandbox mounts a repo containing `.agents/skills`. `--no-skills` should cover it; verify.
10. **Context-file and SYSTEM.md discovery is separate from skills.** Forgetting `--no-context-files` lets project `AGENTS.md`/`CLAUDE.md` into context (ADR 0006 risk).
11. **Which agent CLI Sandcastle invokes is not stated in this repo.** This report assumes pi, as implied by ADR 0004. Confirm before relying on any flag here.
12. **Web-only and unverified items:** pi.dev docs and upstream repo were not fetched; the behaviour of `--offline`, `ANTHROPIC_BASE_URL`, and `--continue` under shared session dirs is inferred from code and not run.

Suggested next checks (not done here): a fixture-home run with `PI_CODING_AGENT_DIR` pointed at a temp dir, `--mode json --no-session`, and a network-blocked sandbox to see which pi.dev calls actually fire.
