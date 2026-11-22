# Changelog

All notable changes to claw2 are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- **API-style embedding model names no longer reach the local daemon**: with
  `backend: sqlite` the provider resolves to local, and a config still
  carrying `embeddingModel: text-embedding-3-small` (the HTTP default from
  the shipped example) would make the daemon try to download a nonexistent
  HuggingFace repo. Non-repo ids (no "/") are now ignored with a warning and
  the default bge-small model is used.
- **The compose volume pre-creates `.claw2/models`**: the embedding model
  cache directory is visible and node-writable from boot, not only after
  the daemon's lazy first start.

## [0.2.7] - 2026-11-22

### Added

- **Fact lifecycle in vector memory — the latest version is chosen
  mechanically**: every recalled record now carries a date and id, and only
  ACTIVE facts surface (recall filters status=retired). Changing a fact is
  `remember(text, replaces=id)` — the old version is retired in the same
  transaction with a supersede link; cancelling one is the new
  `memory_forget(id)` tool. The model is taught the convention in the
  system prompt: never keep two versions of one fact (the
  moved-Wednesday-meeting case). The prune order drops retired records
  first; the Chroma backend gets parity plus a one-time status backfill;
  existing memory.sqlite databases are upgraded via ALTER (old records
  stay active). Chronicle recall entries now show their date too.

### Fixed

- **Local embeddings no longer break with a stale daemon**: the shared ONNX
  embed daemon is now validated on reuse — its model and dimension must match
  the current config, otherwise it is stopped and respawned (a leftover
  daemon from another model silently fed the store wrong-dim vectors:
  "Embedding dim mismatch: got N, expected 384"). `memory.embeddingModel`
  from the config now reaches the spawned daemon. In compose the model cache
  lives in the mounted `.claw2/models` volume — no re-download from
  HuggingFace after every rebuild.

## [0.2.6] - 2026-11-22

### Added

- **Composer message queue and force-send**: the composer stays usable while
  a reply is streaming — submitting puts the message into a visible numbered
  queue above the input. Rows can be dragged to reorder, edited back into
  the composer, removed, or sent immediately with ⚡ (interrupting the
  running reply; the partial answer stays in the tape). When a turn ends,
  the head of the queue sends itself. Attachments are not queued — they wait
  in the composer with a hint. The queue is per chat and does not survive a
  page reload. Web (full) and PWA (without drag reorder).

## [0.2.5] - 2026-11-22

### Fixed

- **Sidebar attachment indicators never showed (web)**: the server computed
  `hasImages`/`hasDocs` and the sidebar rendered them, but the chat-list
  merge into the local store dropped both fields — a chat could carry
  documents (the chat's documents panel listed them) with no icon in front
  of it. The merge now lives in one tested helper (`serverChatToItem`).
- **Attachment flags missed two document sources the chat panel counts**:
  messages referencing files by bare relative paths (`uploads/notes.txt`
  without the `/files/` prefix) were filtered out by the SQL prefilter, and
  forked chats did not inherit their ancestors' session-prefixed files from
  the disk scan. Both now light the icon, matching the documents panel.

## [0.2.4] - 2026-11-22

### Fixed

- **Upgrading from 0.2.2 no longer breaks the chat list**: 0.2.3 shipped the
  `title_manual` column in schema.sql but forgot the ALTER migration, so an
  existing database made the gateway fail with
  `SqliteError: no such column: title_manual` on the first chat-list query.
  `initDb` now adds the column on upgrade.

### Added

- **Schema-upgrade guard**: a convergence test upgrades a database built from
  `schema.baseline.sql` (the oldest supported schema, currently 0.2.2) through
  `initDb` and compares every table's shape with a fresh install. Adding a
  column to schema.sql without the matching ALTER in `init.ts` now fails the
  test with the exact table.column — the 0.2.3 class of bug can no longer
  ship silently.

## [0.2.3] - 2026-11-22

### Added

- **In-app update flow**: the gateway periodically checks the latest GitHub
  release (`updates.check: false` disables it) and the cabinet shows a toast
  when a newer version is available; an **Update** link next to *Help* opens
  a dialog that runs the update with a progress bar when the host-side
  watcher (`scripts/update.sh --install`) is installed, and otherwise shows
  the copy-paste command and watches the restart.
- **Rename a chat**: a "Rename" item in the sidebar chat menu (web) and a
  pencil action in the mobile chat list (PWA). Enter saves, Escape cancels.

### Added

- **Add a fork tree to a project in one action**: when the chat being added
  belongs to a fork tree, the sidebar asks whether to add the whole tree or
  only the selected chat.
- **Attachment indicators in the chat list**: chats carrying images and/or
  documents show small image/document icons next to the title (web sidebar
  and the mobile chat list). Flags come from stored messages and the
  session-prefixed files on disk.

### Fixed

- New chats showed the "New chat" placeholder in the sidebar instead of the
  derived title when a per-chat model override had created the row first; the
  placeholder now gives way to the derived/loaded title.
- **Updates no longer leave a stale egress sidecar**: a container keeps the
  image it was created from, so after `docker compose up -d --build` the
  running sidecar kept executing the old code. A skill run now recreates the
  sidecar when its image no longer matches the current tag. The README
  "Updating" section documents the full procedure (stash tracked-file edits,
  optional image prune, automatic schema migrations).
- **The sidebar fork tree stays still during generation**: stream progress
  used to re-sort the chat list on every chunk (updatedAt ticks), visibly
  reshuffling the tree and moving the selected chat around. Progress now
  updates the row in place; the final order lands once when the reply
  completes.
- **A manually renamed chat keeps its name**: the rename is recorded as
  manual (new `title_manual` flag) and automatic titling — including the
  browser page title a web-surface chat sends with every message — can no
  longer overwrite it.

### Docs

- Quick start now says explicitly to paste the generated key into `.env` as
  `CLAW2_GATEWAY_API_KEY`.

## [0.2.2] - 2026-11-22

Follow-up to the 0.2.1 audit pass: personal-deployment hardening, chat-state
integrity fixes, and a compatibility pass that makes the validating docker
guard pass the stock docker CLI lifecycle — verified end to end on a live
daemon, including the full compose stack (networks, healthy egress sidecar,
foreground skill run with streamed output and auto-removal).

### Security

- **Skill drafts are never executed.** `code_skill` candidates now live in
  memory only and are checked statically (canonical Agent/Call/In/Out header +
  syntax parse without imports); `accept_skill` installs reviewed code without
  running it. The smoke-run path — which executed model-written code before
  confirmation, including freshly rewritten bodies under an already-allowed
  filename — is gone. `coding.smokeArgs` is retained for compatibility and
  ignored.
- **File grants are bound to the exact file.** `GET /api/files-token` issues a
  short-lived grant for one decoded `/files` path; `GET /files` accepts the
  gateway key or that path-bound grant, and grants expire. Hosted JWT and
  companion gates are not bypassed; auth-off single-owner setups are unchanged.
- **The web client no longer attaches its file credential to third-party
  URLs** (any URL containing `/files/`); only same-origin gateway file URLs
  are signed. The grant cache is dropped on login/logout/password change and
  in-flight responses from a previous session can no longer repopulate it.
- **Stored HTML cells are re-sanitized at both web render boundaries** with
  the gateway's allowlist sanitizer (shared module), so cells stored before a
  sanitizer fix cannot bypass the current rules.
- **PWA embeddings follow the selected endpoint.** An explicitly configured
  embedding URL gets only its own key (or an explicit no-auth request), and
  the fallback uses the active provider from the registry; the chat key can
  no longer ride to a different origin in either transport.
- **Docker guard hardening.** Bind mounts must carry an explicit read-only
  mode outside `/app/output` (Docker mounts optionless binds read-write); the
  create-query name is validated, container network roles are enforced, and
  network properties (bridge driver, internal flag) are verified from the
  daemon's own inspect response.

### Fixed

- **The docker guard now supports the stock docker CLI lifecycle** — this was
  broken in 0.2.1, so every docker-sandbox skill run failed. The guard now:
  registers the hex IDs it created and allows lifecycle calls by them (foreign
  containers remain unreachable); relays the hijacked `attach` stream
  (HTTP Upgrade) for `docker run -i`; flushes long-poll (`wait`) response
  headers so the CLI proceeds to `start`; answers the CLI's pre-flight
  `GET /containers/json` with only claw2 containers; accepts the CLI's default
  `LogConfig` marker; and parses the daemon's array-shaped network inspect
  responses.
- Partial forks no longer inherit a prompt recap that covers messages beyond
  the fork point (gateway and PWA).
- Reminder delivery: scheduler ticks no longer overlap within one gateway
  process, and a stale acknowledgement cannot advance a recurrence twice. New
  reminders store UTC timestamps; legacy rows keep their previous
  interpretation.
- The web client treats a chat stream that ends without the terminal JSON
  event as interrupted instead of success, and the full turn (both messages,
  transcript rows, chat timestamp and recap) is committed in a single SQLite
  transaction.
- LLM-bridge replies are anchored to the exact polled message by ID; a newer
  room message no longer hijacks the turn.

### Changed

- **Node 22 is the supported runtime**: `engines` requires `>=22.13.0` for
  source builds, CI runs on Node 22 and now builds and tests the web and PWA
  clients too, and the Docker image is rebuilt on `node:22` (Debian) with the
  native build toolchain kept out of the runtime layer. A `.dockerignore`
  keeps local dependencies and secrets out of the build context.
- Gateway `/files` responses set `Cache-Control: private, no-store` and
  `Referrer-Policy: no-referrer`, and serve audio/video with inline content
  types (they previously downloaded as octet-stream).

## [0.2.1] - 2026-11-22

Everything below ships in one cut: the fork/duplicate-chats feature and a
security remediation pass (external audit + follow-up code audit).

### Added

- **Fork and duplicate chats.** Two entry points: "Duplicate chat" in the
  sidebar chat menu (full copy) and a per-message "Fork from here" button
  next to the copy button (branch cut at that message, after a confirm).
  The copy carries the history, project, per-chat model and prompt-summary
  context; pin/favorite are reset. Generated files stay shared between the
  original and its forks (media and documents surface in both), and a
  "Forked from chat …" banner above the log opens the original. (web,
  gateway, PWA)
- **Fork tree in the sidebar.** Forked chats render nested under their
  parent in chain order with a connector line, collapse/expand and a
  "forked from …" tooltip; the same tree exists in the mobile client's
  chat list. Deleting a chat re-attaches its forks to the parent (graft) —
  the chain of reasoning stays connected.
- **Validating docker API guard** (`src/sandbox/docker-guard.ts`).
  Replaces the generic docker-socket-proxy in the compose delivery: an
  endpoint allowlist (container/network lifecycle, image pull, health —
  no exec/build/volumes/swarm) plus structural validation of every
  container creation — mandatory hardening profile (cap-drop ALL,
  no-new-privileges, read-only rootfs), privilege widening rejected,
  bind sources restricted to the declared sandbox roots, containers and
  networks must be claw2-named, published ports / devices / host
  namespaces / restart policies / docker load refused. The guard also
  refuses operations targeting its own container.
- **Hosted (multi-user) isolation.** Per-user config is default-deny
  filtered (only `llm` / `assistant` / `voice` / `insights` are
  user-settable — sandbox, fs allowlist, skills, channels, gateway policy
  stay operator-owned); an empty `skills.allowlist` is deny-by-default in
  hosted mode; skill authoring (`POST /api/agents`), `/allow`, gateway
  restart and remote-access control require the new
  `gateway.auth.admins` list; tenant-overridden `llm.baseURL` is
  DNS-validated (SSRF gate) and never inherits the operator's API keys.
- **Per-user file access token.** `GET /api/files-token` issues a
  10-minute HMAC token; `GET /files` requires it whenever gateway
  authentication is on. This also fixes media (images/audio/video)
  failing with 401 under auth-on. Auth-off single-owner setups keep
  header-less `/files` as before.
- **Account hardening.** Login/token verification enforce account status;
  JWTs carry a token version (password change invalidates outstanding
  tokens); brute-force limiter on login/register/password-change.
- **Symlink-safe filesystem layer** (`src/security/safe-fs.ts`): every
  path component is verified (walk + realpath + `O_NOFOLLOW` opens) for
  the fs tools and `/files` serving; component identity re-checks detect
  mid-operation swaps. Planted symlinks in skill-writable mounts can no
  longer redirect reads/writes outside the sandbox roots.
- **Startup configuration-conflict warnings** for the two compose sandbox
  conflicts that used to fail silently per skill run: `uploads.hostPath`
  outside the sandbox bind roots, and remote `DOCKER_HOST` without
  `CLAW2_SIBLING_HOST_ROOT`.

### Changed

- **Chat attachment composer** accepts up to 10 files (was 20); the
  gateway chat body limit is 224 MiB (was 512 MiB). The LLM-room body
  parser gained a 2 MiB streaming limit (was unbounded).
- `web_fetch` streams the response with a byte counter and aborts at the
  limit instead of buffering the whole body first.
- Registration (hosted) mode fails **closed** when `sessionSecret` is
  missing or shorter than 32 characters — the JWT gate no longer
  silently disappears.
- `GET /api/config` tenant responses are policy-filtered and mask
  `vision.recognizeSecret`.

### Security

- Method-aware authentication: UI pages are public for GET/HEAD only;
  state-changing requests (including `POST /chat`) always require a
  verified identity in registration mode. `/allow` (skill approval) and
  skill authoring are admin-gated there.
- Cross-site guard for auth-off deployments: requests marked cross-site
  by `Origin` / `Sec-Fetch-Site` are refused for state-changing routes
  (simple `text/plain` bodies used to reach the JSON parser).
- Remote-access boundary: the HTTPS proxy stamps a per-process secret;
  the companion-auth path requires it, so the `X-Claw2-Via` header cannot
  be spoofed through the plain listener. A warning fires when remote
  HTTPS is open while the gateway binds non-loopback.
- HTML-cell sanitizer hardened: entity/whitespace-encoded `javascript:`
  schemes (`&#106;avascript:`), `data:` navigations, CSS `url()`/`@import`
  exfiltration and `<style>` payloads are now stripped (vectors were
  model-output injectable; the PWA port already had the fix).
- Cross-tenant file surface in hosted mode: `/chat/session-files` is
  scoped to the caller's own sessions; `/chat/documents`,
  `/chat/assets-summary` disk scans and `DELETE /files` require an owned
  session.
- `web_fetch`, `web.md` hardening of unbounded reads; raw DB error text
  no longer reaches register clients; `X-User-Id` removed from CORS
  allow-headers; chat titles are capped server-side.
