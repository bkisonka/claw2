# claw2

[English](README.md) · [Русский](README.ru.md)

claw2 is a personal, chat-driven AI agent. It talks to the language-model
provider of your choice, keeps conversations, files and long-term memory on
your own machine, and extends itself with small skills — plain Node.js
scripts that it can write and then run when a task calls for one. Security
restrictions are enabled by default: the agent works inside a limited
sandbox, touches only the directories you allow, and records its actions in
an audit log.

The software is distributed as source code for self-hosting. A Linux machine
with Docker is all that is required; the distribution format is a single
container that serves both the web interface and the API.

## What it offers

- **A conversational agent with tools.** Beyond answering questions, claw2
  can read and write files in its workspace, fetch web pages, search the
  web, run calculations and call its skills — choosing a tool on its own
  from the description of your request.
- **Skills.** Anything the built-in tools cannot do is delegated to a skill:
  a small Node.js script in the `agents/` directory. Standard skills cover
  downloading files, reading PDF and DOCX documents, charts, weather and
  more. When no suitable skill exists, the agent can write a new one and
  start using it after your confirmation.
- **Long-term memory.** The agent remembers facts between conversations and
  recalls the relevant ones before each answer. Memory is stored locally.
- **Scheduler and reminders.** Skills can run on a schedule, in the classic
  crontab notation.
- **Web interface.** A full chat front-end with sessions, settings and
  attachments, served by the same container.
- **A mobile web client.** A standalone installable web application (under
  `/pwa/`) that runs entirely in the browser and talks to the model provider
  directly — handy on a phone, at home or over the network.
- **Messengers.** A Telegram bot can serve as another door into the same
  agent; voices messages are understood and answered with speech when a
  speech service is configured.
- **Honest accounting of the surroundings.** Every request the agent makes
  to the outside world passes through allow-lists and is written to the
  audit log.

## How it is put together

| Part | Where | Role |
|------|-------|------|
| Gateway | `src/gateway/` | The heart: HTTP API, chat sessions, tools, skills, memory, channels. Serves the web interface and the mobile client. |
| Web interface | `web/` | The browser front-end (React). |
| Mobile web client | `pwa/` | A self-contained web app; the agent logic runs inside the browser, data stays on the device. |
| Skills | `agents/` | Small Node.js scripts, editable on the host — the container picks them up in place. |
| Assistant persona | `prompts/` | The tone and manner of the assistant, separated from the machinery. |
| Configuration | `.claw2/claw2.yaml` | One YAML file for everything: model, gateway, memory, tools, channels. |

Conversations live in a local SQLite database; no cloud service receives
them. The only outbound traffic is the traffic you configure: calls to the
model provider and whatever the agent fetches on your behalf.

## Requirements

- Linux x86-64 or arm64 (Debian, Ubuntu, Fedora, Alpine and other common
  distributions work).
- Docker Engine 24 or newer with the Compose plugin.
- An API key for any OpenAI-compatible provider — a cloud service or a
  local server such as LM Studio or Ollama.

Building from source without Docker requires Node.js 20 or newer.

## Quick start

```bash
git clone <repository-url> claw2
cd claw2

# 1. Environment: the model API key and the gateway access key.
cp .env.example .env
openssl rand -hex 24   # → CLAW2_GATEWAY_API_KEY
nano .env

# 2. Configuration: create the agent config from the example.
cp .claw2/claw2.gateway.yaml.example .claw2/claw2.yaml
nano .claw2/claw2.yaml

# 3. Build and start.
docker compose up -d --build
```

Open **http://localhost:8080** — the web interface of the agent; it asks
for the gateway key on entry. Health state is reported at `GET /health`.

By default the port is published on the loopback interface only. To reach
the agent from other devices, change `127.0.0.1:8080:3000` in `compose.yml`
to `8080:3000` — gateway authentication (on in the example config) is what
protects the service once the port is reachable.

If you use a local model server on the host (for example Ollama on port
11434), the container reaches it at `http://host.docker.internal:11434/v1`
— put that address into `llm.baseURL` in the config.

## Configuration

Everything is configured in a single YAML file, `.claw2/claw2.yaml`. The
examples in `.claw2/` cover the typical setups; secrets are never written
into the file itself — write `env:OPENAI_API_KEY` and the value is taken
from the environment (from `.env`).

The most common settings:

```yaml
llm:
  provider: openai        # any OpenAI-compatible endpoint
  model: gpt-4o-mini
  baseURL: https://api.openai.com/v1   # or a local server
  apiKey: env:OPENAI_API_KEY

gateway:
  port: 3000
  auth:
    enabled: true
    apiKey: env:CLAW2_GATEWAY_API_KEY

memory:
  enabled: true

sandbox:
  useDocker: false        # inside the container, skills run in a node sandbox
  timeoutMs: 60000
```

The web interface has its own settings screen that edits the same file;
changes take effect after you press *Save and restart*.

Environment variables (`cp .env.example .env`):

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | The model provider key, referenced from the config as `env:OPENAI_API_KEY`. |
| `CLAW2_GATEWAY_API_KEY` | The key for the HTTP API and the web interface (required by the example config). |
| `TZ` | Time zone; the agent keeps track of the current date and time, reminders and schedules follow it. |

## Running it as a system service

The compose file already declares `restart: unless-stopped`, so the agent
survives host reboots wherever the Docker daemon is enabled at boot. To
treat the stack as a first-class systemd service — with dependency ordering
and a single `systemctl` entry point — see [docs/systemd.md](docs/systemd.md).

## Updating

```bash
git pull
docker compose up -d --build
```

Your configuration, conversations and memory live in mounted volumes
(`.claw2/`, `data/`) and are never touched by an update.

## Skills

Skills live in `agents/` as ordinary JavaScript files. The container mounts
this directory, so you can add or edit skills on the host with any editor —
the agent sees the changes on the next turn. Inside the container skills
run in a hardened sandbox: a plain Node.js process with the
`--permission` flag, restricted environment and no network access to your
private subnets.

The list of permitted file paths, webhooks and skills is also in the
config; anything outside the lists is refused. Libraries used by the
bundled skills are preinstalled in the image; if you replace the mounted
`agents/` directory with your own, its local `node_modules` (if present)
takes precedence.

## Security

- **Sandbox.** Skills execute in isolation, without access to the host
  filesystem beyond the workspace.
- **Allow-lists.** File access, outgoing webhooks and loadable skills are
  enumerated in the config; everything else is denied.
- **Gateway authentication.** The example config ships with
  `gateway.auth.enabled: true`: the API and the web interface require a key
  (`X-API-Key` header or `Authorization: Bearer`). Keep it on whenever the
  port is reachable beyond your own machine — and do not turn it off on a
  shared network: the gateway also answers requests made by other websites
  open in your browser, and the key is what keeps them out.
- **Audit log.** Chat turns, tool calls, file operations and security
  refusals are appended to the log; format and location are set in the
  config.
- **Prompt-injection containment.** Content fetched from the web is marked
  as data, never as instructions; combinations of access that make an
  injection dangerous are detected and blocked.

## Optional: an extended stack

The single-container setup covers a personal installation. For heavier
use — many years of conversations, semantic search over memory — the
gateway can offload storage to PostgreSQL and the vector index to a Chroma
server; a SearXNG instance can serve as the search backend. These are
ordinary external services: add them to `compose.yml`, point
`gateway.databaseUrl` and `memory.chroma.url` at them, and restart. The
reference deployment in the author's repository runs exactly this way.

## Source layout

```
src/       gateway, tools, memory, security, scheduler, channels
web/       browser front-end (React)
pwa/       mobile web client and Android application (Capacitor)
agents/    skills — small Node.js scripts
prompts/   assistant persona
docs/      supplementary guides (systemd, user guide)
```

## Android application

The `pwa/` directory also contains the Android application: the same agent
in a native shell built with Capacitor. The Gradle project lives in
`pwa/android/`; building it requires Android Studio (or its JDK and the
Android SDK). The step-by-step guide — architecture, on-device storage,
build commands, release signing — is [pwa/ANDROID.md](pwa/ANDROID.md).

The release signing key is deliberately not part of the sources: generate
your own keystore and put its path and passwords into
`pwa/android/keystore.properties` — the release build picks it up
automatically. Generated web assets and build outputs are gitignored and
reproduced with `npx cap sync` before the first build.

## License

claw2 is proprietary software, available free of charge for personal,
non-commercial use and modification for one's own needs. Redistribution and
commercial use are not permitted without a separate written agreement with
the copyright holder. See [LICENSE](LICENSE) (English, canonical) and
[LICENSE.ru.md](LICENSE.ru.md) (Russian translation), applied together with
the end-user agreement [EULA.txt](EULA.txt). Third-party open-source
components keep their own licenses — see [NOTICE](NOTICE).
