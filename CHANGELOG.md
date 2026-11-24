# Changelog

All notable changes to claw2 are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **A running turn survives a gateway restart.** `SIGTERM`/`SIGINT`
  (`docker stop`, systemd, Ctrl+C) stop every running turn the way the Stop
  button does — the turn is stored with its message, the text printed so far
  and its tool steps — before the process exits, and the chat is there when
  the gateway is back. Until then a new message is refused with
  `503 {"code":"shutting_down"}`. `gateway.shutdownGraceMs` (default 8000,
  inside the grace period `docker stop` gives by default) bounds the wait; a
  turn that needs longer is named in the log. A `SIGKILL`, an OOM kill or a
  power cut still lose the running turns. The gateway is PID 1 of its
  container, and Node ignores `SIGTERM` as PID 1 unless a handler is
  installed: `docker stop` used to wait out the whole grace period and then
  kill it.
- **`gateway.maxConcurrentChatRuns`** (default 8, 0 = off): how many turns
  may run at once. It was a constant of the code.
- **`gateway.chatRunSettleWaitMs`** (default 15000): how long a new turn
  waits for the turn it superseded to be stored.

### Changed

- **The steps fold stays closed.** While a turn runs, its header shows the
  steps one line at a time, advancing as they arrive: each new step slides
  up from below while the previous one slides out above, and between steps
  the line stands still. Once the turn is over, the header keeps the last
  step's content beside the count and the total time. The fold is there to
  read the whole list on click; with reduced motion requested, the line
  swaps without animation. The fold used to open on its own while the turn
  ran and grow with every step.
- **The model is not limited to 30 tool steps per turn anymore.** Nothing in
  the code counts its steps now: a turn is bounded by `gateway.chatRunMaxMs`
  and its tool results by the context budget. `orchestrator.maxToolIterations`
  still sets a ceiling for whoever wants one. A model that keeps repeating a
  failing call is told so — see below.
- **A model that keeps failing is told to stop.** Two counts, each said once
  per streak, so that notes do not pile up in the prompt. From the third
  failure in a row of one call — same tool, same arguments in any order; a
  success or other arguments start the count over, another call in between
  does not — a note asks it to change the approach or to answer with what it
  has. When step after step not one tool call succeeds, though no call
  repeats, it is told so on the fifth step and again every ten further ones,
  and asked to stop calling tools and answer; after ten further failures
  of the same call the note is said again — one note may be ignored. A
  fresh note replaces the previous one instead of piling up in the prompt
  for the rest of the turn, and it names every call in a live failing
  streak, each with its own count. The turn goes on;
  `tool_repeated_failure` and `tool_fruitless_steps` go to the audit log.
  The notes — and the step-budget note — come as user messages: providers
  are not required to accept a system message in the middle of a dialogue,
  and the fruitless-steps note offers a change of approach instead of
  commanding to stop.
- **Attach asks again for what the turn is still waiting for.** `GET
  /chat/attach` replays the page-text requests (`readBrowserPage`,
  `headlessPageText`) that no client has answered yet, and a page the turn
  opened while no client was listening. A reloaded tab used to lose both and
  the tool waited 18–20 s for its fallback.
- **Stopping a skill no longer holds the gateway.** `docker kill` is issued
  without blocking the event loop, which a slow daemon could freeze for up to
  10 s — on every Stop. A shutdown waits for the kills to reach the daemon.
- **The model is told what it no longer sees.** A compacted tool result says
  that `read(path, offset, limit)` returns the missing lines, and a trace
  block of the history names the steps it leaves out for size.
- **The model is told to look before it reads.** To find something among
  files — a local directory, a repository, a documentation site — it is to
  get the listing first and read only the files the task needs, with
  independent `read`/`web_fetch` calls in one response, instead of pulling
  files one by one.

### Fixed

- **A shutdown during the setup of a turn reaches its client.** While a turn
  was being prepared — above all, while it waited for the turn it superseded
  to be stored — a stop ended its response as an empty `200`: no frame, no
  code, and the question vanished from the history. Now the stream client
  gets a `gateway_restart` terminal, a client without a stream gets `200`
  with the code, and the question is stored with an empty answer marked as
  cut short. A Stop during the setup ends the stream with `chat_cancelled`
  instead of nothing.
- **A message that supersedes a running turn gets its stream headers at
  once.** They used to arrive only after the superseded turn was stored —
  up to `gateway.chatRunSettleWaitMs` (default 15000) with no byte sent.
- **`POST /api/restart` stops the running turns first.** It used to spawn
  its replacement and `process.exit(0)` directly, past the graceful stop;
  now the turns are stopped and stored, and the replacement starts only
  after the port is free.
- **The container kills keep their reserve even when the event loop ran
  late.** The reserve is a floor again: lateness while the turns were
  stopping used to take it away second for second.
- **`tool_iteration` in the audit does not log a ceiling that is not set**,
  and logs the set one. Since the step limit was removed it logged
  `"maxIterations":null` on every iteration.
- **A restart does not read as a Stop.** A turn stopped by the gateway going
  down ends with `code: "gateway_restart"` and its stored answer carries
  `interruptedBy: "gateway_restart"`, which `/chat/history` returns; the web
  client says that the gateway was restarting. It used to end as
  `chat_cancelled`, and the web client showed “Chat cancelled” as an error.
  A client without a stream gets 200 with the code instead of a failed
  request. A turn cut short before its first word keeps its question: it is
  stored as an empty answer with the mark, and the model gets
  `[no answer: the gateway was restarting]` for it in the turns that follow.
  The audit has its own event for it, `chat_gateway_restart`.
- **A shutdown keeps time for the container kills.** 1.5 seconds of
  `gateway.shutdownGraceMs` are the kills' even when the running turns use
  all the rest: turns that spent the whole grace period used to leave none,
  and the skill containers could outlive the gateway. A grace period shorter
  than 3 seconds is split in halves.
- **A superseded turn that stops late is not stored after its replacement.**
  A superseded turn that stopped only after the new turn was already stored
  was written behind it and read as the chat's latest exchange, in the
  history and for the model. It is not stored now; the wait that ran out is
  logged.
- **The question of a turn is visible from its first moment.** A client that
  attached while the turn was still being set up — it can wait up to
  `chatRunSettleWaitMs` for the turn it superseded — got neither a snapshot
  nor the question later.
- **`read` past the end of a file says so**: `[no lines at offset 99: the
  file has 12]` instead of the last line again, which read as "there is more".
- **The compact prompt no longer offers the transcript tools while they are
  switched off.** With `gateway.transcriptTools: false` its one tools line
  still named `transcript_*`, a tool the schema does not have to call.

## [0.3.0] - 2026-11-24

### Added

- **Long agent turns survive a closed tab.** A chat turn now runs on the
  gateway instead of inside the HTTP request that started it: a dropped
  connection or a reloaded page no longer cancels it, and the web client
  re-attaches to a running turn when its chat is opened (`GET /chat/attach`
  replays the question, the text and the steps so far). The Stop button
  stops it (`POST /chat/cancel`) and the turn keeps what it had done: its
  message, the text printed so far and its tool steps.
  `gateway.backgroundChatRuns: false` restores the previous behavior, where
  a dropped connection cancels the turn. Streams send keepalive comments
  (`gateway.chatKeepaliveMs`, default 15000) and a turn is cut off after
  `gateway.chatRunMaxMs` (default 30 minutes).
- **Tool steps are visible and remembered.** The reply lists the steps as they
  happen — tool, main argument, outcome, duration — instead of a bare
  "thinking" label. The steps are stored in the chats database (new
  `tool_calls` table: arguments up to 2 KB, results up to 4 KB; `read_secret`
  values are never stored) and returned by `/chat/history` as `tools`. The
  last `orchestrator.toolTraceHistoryTurns` turns (default 3) get their steps
  back in the prompt, so the model knows what was already tried; results that
  came from the web, search or skills are not repeated there.
- **`read` pages through large files** with `offset` (first line, 1-based)
  and `limit` (lines), so a clipped result can be read to the end.

### Changed

- **Tool results stay inside a context budget.** Every result is clipped to
  `orchestrator.toolResultMaxChars` (default 24000) and older results are
  compacted once the turn's tool context exceeds
  `orchestrator.toolContextMaxChars` (default 160000).
- **The step limit ends with an answer.** When `maxToolIterations` is spent,
  the model gets one last call without tools; the reply is marked
  `toolLimitReached` instead of the turn failing with "Max tool iterations
  reached".
- **Stop really stops.** Cancelling a turn now kills a running skill (process
  or container) and interrupts `code_skill` sub-agents and image generation,
  instead of waiting for their timeout. The Stop button of the browser
  extension cancels the turn on the gateway as well; closing its overlay only
  detaches from the stream.
- **A tool that crashes no longer fails the whole turn**: the model receives
  the error and goes on. Tool execution moved from `runOrchestrator` into
  `src/core/tool-dispatcher.ts`.

### Fixed

- **Stream headers are sent at once.** `writeHead` alone kept them until the
  first frame, so a client saw no response while the model was thinking or a
  tool was running.

## [0.2.17] - 2026-11-24

### Added

- **FreeBSD packaging lives in its own repository**,
  [bkisonka/claw2-freebsd](https://github.com/bkisonka/claw2-freebsd): a jail
  template, a `pkg` package and an installer that builds from source. The
  gateway, the web interface, the mobile web client and the skills in the
  soft sandbox build and run natively (verified on FreeBSD 15.1-RELEASE:
  build, the whole test suite and a live skill run).

### Fixed

- **npm 12 no longer installs the gateway without its native modules.**
  npm 12 blocks the install scripts of dependencies unless the project
  lists them in `allowScripts`; without the list `npm ci` succeeds and the
  gateway dies on its first `require("better-sqlite3")`. The three packages
  of the project now name `better-sqlite3`, `bcrypt` and `esbuild` — by
  name, so a version bump does not silently re-block them. Older npm
  ignores the field and behaves as before.
- **sqlite-vec can be loaded from an explicit path** (`CLAW2_SQLITE_VEC_PATH`)
  on platforms the npm package ships no binary for, instead of failing
  with "Unsupported platform".

- **web-search.js searches from datacenter IPs**: Bing's RSS output is the
  first engine of the chain (`format=rss` — structural XML, no map and no
  bot-check from datacenter IPs); apiclick wrappers are unwrapped to direct
  URLs, CDATA is cleaned, and a feed padded with unrelated "popular" items
  on a no-hit query is rejected honestly — at least one query token must
  appear in the results. The ddg-html engine actually sends its POST body
  now: it was built but dropped from the request, so every call went out
  empty and parsed nothing. `--engine=<unknown>` fails with the list of
  valid engine names instead of silently falling back to the auto chain.

## [0.2.16] - 2026-11-23

### Fixed

- **Skills no longer depend on the directory compose is launched from.** The
  compose file baked `${PWD}` — the caller's directory, not the project's —
  into the sandbox bind roots, while the volumes themselves followed
  `compose.yml`. Launched from anywhere else (`docker compose -f
  <repo>/compose.yml up -d`, which is how the update watcher ran it), the
  gateway asked for host paths that did not exist: the daemon created empty
  root-owned directories in their place and every skill died before its
  first line on `Cannot find module '/app/.claw2-egress-preload.cjs'`. The
  gateway and the docker guard now read the host paths from the gateway
  container's own `/app/agents` and `/app/data` mounts on the daemon, so
  they cannot drift from the volumes. The update watcher runs compose from
  the project directory as well.

## [0.2.15] - 2026-11-23

### Fixed

- **Companion extension install/connect fixes**: `default_locale` dropped
  from the manifest (browsers refuse it without a `_locales` tree — the
  Yandex.Browser report), the connection test sends
  `Accept: application/json` (`/health` answers plain `ok` otherwise and
  the JSON parse blew up), and the chat port connects via
  `runtime.connect({ name })` — a bare string is parsed as an extension id
  ("Invalid extension id: claw2-chat").

- **The built-in wiki no longer renders itself inside itself**: a deep link
  like `/wiki/ru/How-To/Page` (path form, no hash) made the shell fetch
  pages relative to the deep path — the gateway's unknown-subpath fallback
  answered with the shell HTML and HTTP 200, so the shell parsed ITSELF as
  the page (nested shell, eternal "Loading…", mixed EN/RU from the inner
  shell's language detection). The shell now resolves page fetches from the
  wiki root and routes deep links into the hash; the gateway answers a miss
  under `/wiki/pages/**` with a plain 404.
- **docs/wiki now syncs into the shipped wiki**: `scripts/sync-wiki.mjs`
  (wired into `npm run build`) copies docs/wiki/{en,ru} → wiki/pages — the
  0.2.14 companion guide had silently never reached the deployment.

## [0.2.14] - 2026-11-23

### Added

- **Browser companion extension (Chromium, MV3)**: the web deployment gets
  its "open web" story without shipping an engine — a tiny extension
  (`extension/`, load-unpacked) puts a claw2 pill on every page: a chat
  panel as an overlay with the composer pinned to the bottom, page text and
  selection attached to every turn (the server's existing `<<<EXT>>>`
  untrusted-content isolation applies), "Ask claw2 about selection" context
  menu, `open_browser` navigates the tab, and the chat continues across
  navigation (session per tab) and shows up in the sidebar bound to the
  page. Networking lives only in the background service worker (page CSP
  cannot block it); the API key is stored in the extension's local storage.
  The W-mode stub in the browser deployment now shows the companion
  onboarding instead of "desktop only". Wiki guides (en/ru); gateway
  unchanged.

## [0.2.13] - 2026-11-23

### Fixed

- **web-search.js keeps its diagnostics**: the auto chain collected engine
  failures silently, so the model saw a bare "All engines failed" and had
  to re-run each engine by hand to learn which one hit the bot-check. The
  final error now carries every engine's reason
  ("ddg-lite: bot-check page; ddg-html: No results parsed; …") plus the
  pointer to the configured gateway search tool.

## [0.2.13] - 2026-11-23

### Fixed

- **ocr.js — the browser worker was the real problem**: the pinned
  dist/worker.min.js is the BROWSER build (expects DOM globals) and dies in
  Node worker_threads even from a local path ("addEventListener is not a
  function"). The script no longer passes workerPath/corePath at all: in
  Node, tesseract.js resolves its own node worker and the local core from
  node_modules; only the pinned language data downloads, cached once via
  cachePath in the persistent output volume.
- **The image ships tzdata**: debian-slim has no /usr/share/zoneinfo, so a
  TZ env like Europe/Moscow silently resolved to UTC inside the container —
  save-docx file names and model-visible dates read a day off around
  midnight regardless of the .env setting.

## [0.2.12] - 2026-11-23

### Removed

- **save-article.js, rename-output.js**: the first was hardcoded to one
  read-only path (EROFS, arguments ignored), the second looked for
  `agents/output/output.docx` that nothing ever creates. Both superseded by
  save-docx.js; allowlist and the config example updated.

### Fixed

- **ocr.js works again**: Node's Worker requires a local script path, so the
  CDN worker URL failed on every image. Pinned tesseract assets (worker,
  core wasm, lang data) now download once into a persistent cache under the
  output volume (with retries) and load as local files.
- **The search skill tells the truth and searches**: ya-search.js is now
  web-search.js — a keyless fallback chain (DDG lite → DDG POST → Wikipedia
  API) with bot-check detection, the used engine reported on stderr, and an
  honest header pointing production setups to the gateway `search` tool
  (Tavily/SearXNG).
- **Contract fixes**: download-file.js derives the file name from the URL
  (no more extension-less `download`) with a timeout; weather.js prints the
  forecast as text per its header and its HTTP layer gained a timeout and
  status check; surf.js dropped the fake Firefox User-Agent (HTTP 419 from
  news.ycombinator.com — the default UA passes); save-docx.js names files
  with the local timestamp instead of UTC.

### Fixed

- **Dates in memory and chronicle follow the deployment timezone**: both
  renderings used toISOString() — always UTC — so a fact saved just after
  Moscow midnight was dated "yesterday" even with TZ=Europe/Moscow in .env.
  A shared formatDayLocal (TZ env / system localtime) now feeds the memory
  hits, the chronicle recall block and chronicle_search results
  (which also gained the date line). TZ=UTC on the same instant renders the
  old value — covered by tests.

## [0.2.11] - 2026-11-22

### Added

- **Fact verification is a system property**: new `memory_touch(id)` tool
  stamps `verified_at`; recall renders `проверено ДАТА` and marks facts that
  were never verified or went stale (>30 days) with an explicit re-check
  demand (`не проверено с … — перепроверь`). Forgetting to re-verify a fact
  is now visible in every recall instead of relying on typing dates into
  the text. Chroma parity; existing databases get the column via ALTER.

### Fixed

- **Bundled skills match their headers again**: `time.js` prints ISO 8601
  (the promised format; `args:["ru"]` gives the localized ru-RU form);
  `system-stats.js` runs without arguments as documented (live /proc +
  `df -h`), and its dead `util.format` import and unused `parsePercentage`
  are gone.

## [0.2.10] - 2026-11-22

### Fixed

- **"Embedding dim mismatch: got 96, expected 384" — root cause found and
  removed**: the OpenAI SDK silently sends `encoding_format=base64` when an
  embeddings call omits it, then base64-decodes the response. Servers that
  answer with a plain JSON array (our local daemon, Ollama, vLLM, LM Studio)
  got their JSON string run through the base64 decoder — garbage floats of a
  wrong, content-dependent length (96 for bge-small's 384). Local embeddings
  now use a plain fetch against the daemon (no SDK in the path), and the
  HTTP provider passes `encoding_format: "float"` explicitly so the SDK
  returns the response as-is.

## [0.2.9] - 2026-11-22

### Fixed

- **Embedding dim mismatches now name their source**: on any dimension
  mismatch the log prints the provider (local/http), the baseURL the vector
  came from (embedding endpoint or the main LLM client), the model name,
  the `CLAW2_MEMORY_EMBEDDING_PROVIDER` env override and the loaded config
  path — no more guessing which layer produced a wrong-dim vector.
- **The zombie `memory.chroma` section no longer persists**: GET /api/config
  serves it filled with defaults, so every UI save round-tripped the section
  into sqlite/memory configs. Saving now drops `memory.chroma` when the
  backend is not chroma (covered by config-merge.test.ts).

## [0.2.8] - 2026-11-22

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
