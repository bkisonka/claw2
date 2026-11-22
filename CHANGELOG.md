# Changelog

All notable changes to claw2 are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
