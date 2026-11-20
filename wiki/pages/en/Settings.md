---
title: Settings
---

# Settings

Open in desktop: **Cabinet → Settings** (or `Cmd/Ctrl+,`).

Settings save to disk. Some need **Save and restart**. **Check connections** shows whether LLM, voice, search, images, and vision are reachable.

Without an LLM, claw2 is an empty chat screen. The sections below turn it into an **agent**: skills on disk, memory, search, pages, images, channels, phone.

## Configure first

| Goal | Section | Minimum |
|------|---------|---------|
| Chat replies | **LLM** | base URL + API key + model |
| Skills read/write your folders | **Sandbox → Host FS** | allowlist paths or deliberate full |
| Remember across chats | **Memory** | enable (default sqlite + local ONNX) |
| Web search | **Tools → search** | Tavily key **or** SearXNG URL |
| Open URLs on request | **Web Fetch** | defaults are usually fine |
| Generate images | **Tools → image generation** | URL + model + enable |
| Voice in chat / channels | **Voice** | local voice service or remote STT/TTS |
| Telegram / VK | **Channels** | token + enable |
| Calls | **SIP** | PBX + optional Realtime |
| Phone from outside | **Remote access** | PWA token + HTTPS |

First-run onboarding configures the LLM. Persona and skill list live on **other cabinet tabs** (not this page).

### Privacy (separate tab)

A cloud API without protection leaks machine data, including personal data. Open **Cabinet → Privacy**:

1. Enable **Mask PII before cloud API**.
2. Optionally add **custom rules** (keyword / regex).
3. Use preview: plain text → placeholders like `[PII_EMAIL_1]`.

Chat UI still shows your original text; the cloud receives masked payloads. For local models (localhost), masking is off by default — data never leaves the machine.

**Images & PDF (phase 2):** optional native `privacy-ocr-sidecar`. In Cabinet → Privacy you can see sidecar status, choose `multimodalBackend` (`auto` / `sidecar` / `off`), max size and OCR timeout. With privacy on and no sidecar (`auto`), attachments are **blocked** before the remote LLM; text masking still applies. Details: `docs/privacy-multimodal.md`.

---

## Language

UI language for the cabinet. Does not change the model’s reply language.

---

## LLM

Without a working model, chat does not answer.

| Field | Purpose |
|-------|---------|
| Provider | Logical id (`openai`, `ollama`, …) — defaults and compatibility |
| Model | Name at the provider (`gpt-4o-mini`, `llama3.2`, …) |
| Base URL | OpenAI-compatible API root (`https://api.openai.com/v1`, `http://127.0.0.1:11434/v1`) |
| API Key | Secret; stored values show as `***` |
| Thinking | Reasoning blocks when the model supports them |
| System prompt mode | `full` — full prompt; `compact` — shorter, saves context |
| Max response tokens | Cap on reply length |

After changing key/URL — save and restart if needed; **Check connections** → LLM green.

---

## Voice

Needed for push-to-talk in chat, spoken replies, and (often) SIP pipeline / channels.

### STT and TTS

Two independent blocks: **local** voice service or **remote** OpenAI-compatible API.

| Mode | STT | TTS |
|------|-----|-----|
| Local | URL like `http://127.0.0.1:9000/stt` | `…/tts`; Silero engine (CPU/Mac) or MOSS (NVIDIA) |
| Remote | Base URL + model (`whisper-1`) + API key | Base URL + model (`tts-1`) + voice id + API key |

Without CUDA, choosing MOSS automatically falls back to Silero. How-To: [Voice](How-To/Voice.md).

---

## Phone (SIP / PBX)

Enables the **`phone_call`** tool: register on a virtual PBX, place calls, transfer to an operator. Not required for ordinary text chat.

### SIP basics

1. Enable SIP / `phone_call`.
2. Server, port (often 5060), login, password; domain — if different from the server.
3. Display name, local UDP port, public IP (NAT) — as needed.
4. Operator URI — where to transfer a human.
5. Auto-answer — inbound without manual “answer”.

For pipeline mode (`listen`/`say`) you also need working **Voice → STT/TTS**.

### Realtime (speech-to-speech)

Duplex on the line **without** the STT → LLM → TTS chain. Provider:

| Value | Behavior |
|-------|----------|
| **Off / Pipeline** | Legacy `listen` / `say` + batch voice |
| **Yandex** | Prefer for Russia: API key + **folder ID** (IAM optional) |
| **OpenAI** | Realtime API — often better outside RU |
| **xAI** | Grok Voice — outside RU |

Realtime keys are **separate** from the LLM. “Use LLM key” only via the explicit toggle (usually for OpenAI).

Also: model, voice (`alena`, `alloy`, …), sample rate (often 24000), optional WebSocket URL.

Details: [telephony-realtime.md](../../telephony-realtime.md) in the repository.

### SIP media backend

| Mode | Meaning |
|------|---------|
| **Node** | Built-in SIP/RTP in-process |
| **Sidecar** | Separate native RTP (often linux/amd64); binary path or `~/.claw2/sip-media-sidecar` |
| **Auto** | Sidecar if the binary is found, otherwise Node **without error** |

UI status: running / not found / fallback. Realtime does **not** require sidecar; sidecar is about RTP quality.

Runbook: [telephony-lab-runbook.md](../../telephony-lab-runbook.md).

---

## Memory

Long-term facts across sessions (embeddings + chunk recall).

1. **Enable memory.**
2. Desktop happy path: backend **sqlite**, embeddings **local** (ONNX downloads into `~/.claw2/models` on first recall).
3. Limits: max chunks in storage and how many to inject into the prompt per turn.

**Advanced:** Chroma URL/collection, HTTP embeddings (Ollama, etc.). Changing the embedding model usually requires wiping the memory DB.

Without memory the agent “forgets” between chats everything outside the current window and persona.

---

## Dialogue Insights

A moderate Linker: offers a link from the current turn to a **specific** past chat (or an unfinished thread), without inventing “we discussed…”.

1. Mode: **Off** / **Ask first** (default) / **Auto**.
2. Works best with **Memory** and/or **Projects** (sibling digests).
3. In ask: compact offer Show / Hide; after accept — short text (cheap pass) and optional inject into the next model turn.
4. “Open chat” switches to that sessionId.

See `docs/plans/dialogue-insights.md`.

---

## Tools

This section combines **search** and **image generation**. If nothing is configured, the corresponding tools are unavailable to the model.

### Web search (`search`)

The model sends a query; claw2 picks a backend and returns titles, links, and snippets.

#### Provider (selector)

| Value | Behavior |
|-------|----------|
| **auto** | Tavily → SearXNG → Other; skips empty/disabled |
| **Tavily only** | Tavily only |
| **SearXNG only** | SearXNG only |
| **Other…** | Only your SearXNG-compatible endpoint |

With **auto**, one backend failing moves to the next; with a hard choice — it does not.

#### LLM search in the browser address bar

Toggle `tools.search.useLlmInWeb` (default off):

- **On** — non-URL address-bar text runs a browser-chat turn (model + `search` tool; uses tokens); link list in the overlay.
- **Off** — call Tavily/SearXNG/Other directly (no LLM); results with links in the same browser chat.
- If search is unset or fails — DuckDuckGo page fallback.

More on browse mode: [How-To: embedded browser](How-To/Browser.md).

#### Tavily

Cloud Search API: key `tvly-…` (or `env:TAVILY_API_KEY`), depth `basic` / `advanced` / `fast` / `ultra-fast`. Some networks return **403** even with a valid key — then use SearXNG / Other.

#### SearXNG

Self-hosted or any JSON API: `GET {url}/search?q=…&format=json`. URL + optional API key.

#### Other…

Same protocol as SearXNG, but a **separate** config block — a second instance or “always only my URL”.

**Enable** toggles on each block decide participation in **auto**.

### Image generation (`generate_image`)

Without this block the model does not draw images in chat.

| Field | Meaning |
|-------|---------|
| Base URL | Images API (Ollama/OpenAI) or local SD service |
| Model | e.g. `x/z-image-turbo` |
| API key | Often `ollama` for local Ollama |
| API mode | **auto** / **openai** (Images API) / **txt2img** (local SD) |
| Enable | Without the toggle the tool is hidden |

After setup — **Check connections** for images.

---

## Web Fetch

Tool **`web_fetch`**: download a page by URL and put text into context (not the same as search).

| Field | Meaning (typical defaults) |
|-------|----------------------------|
| Timeout (ms) | How long to wait for HTTP (~15000) |
| Max body bytes | How much to download (~1e6) |
| Max context chars | How much text reaches the model (~8000) |

Worth tuning for large pages or slow networks. Without this section search can still return links, but “open and read” is weaker.

---

## Vision

Camera face recognition for per-user memory isolation.

1. Enable recognition.
2. Service URL `/recognize` (often on the same voice host).

Without URL and service the toggle does nothing.

---

## Telegram

1. Enable the bot, paste the token from @BotFather.
2. Optional proxy for Bot API only.
3. Optional channel-specific STT/TTS URLs; empty — shared **Voice** settings.
4. “Reply with voice” + max characters for TTS.

Message the bot — the same agent as desktop chat replies (with memory/skills).

---

## VK

1. Enable the bot.
2. Community access token + numeric `group_id`.
3. Channel voice — same pattern as Telegram (URLs / reply with voice / max chars).

---

## Skill sandbox

How skill code runs (`run_agent`).

### Docker vs host

| Mode | When |
|------|------|
| **useDocker = false** (typical desktop) | Node `--permission` on the host; needs **Host FS** |
| **useDocker = true** | Container; needs Docker Desktop and an image |
| **elevated** | Sensitive flag to run on the host outside the usual scheme |

Timeout (ms) — force-stop a hung skill.

### Host FS access

Controlled **by you**. Relevant when `useDocker=false`.

| Mode | What a skill can do |
|------|---------------------|
| **Default** | Read `agents/` (+ uploads); write only `agents/output` |
| **Allowlist** | Same + your read/write paths (one per line; `~/…` allowed) |
| **Full filesystem (*)** | Whole FS via `--allow-fs-*`; still **no** `child_process` |

Broader access is a risk. Without allowlist/full the agent does **not** see arbitrary Documents/Desktop folders: you get “chat + whatever is in agents/”.

---

## Gateway

Local HTTP API for the runtime (chat, tools).

| Field | Meaning |
|-------|---------|
| Port | Change if busy |
| API auth | Token for requests; important when access is not only loopback |

Desktop Electron talks to its own runtime. From a phone — see remote access, not “open the port to the world without a token”.

---

## Coding (skill authoring)

Max parallel subagents when generating a skill via the coding pipeline. Safe to ignore for everyday chat; more candidates — more tokens.

---

## Remote access (PWA / HTTPS)

To use from a phone over HTTPS:

1. **PWA access token** — internet login secret (generate / copy).
2. DuckDNS: domain + token, IP refresh interval.
3. Let's Encrypt (DNS-01), email; staging — test only.
4. Listen on HTTPS port (443 or 8443), UPnP when needed.
5. “Open HTTPS” from settings or tray; option to open when hiding to tray.

Status at the bottom: DDNS, certificate, HTTPS, UPnP.

Step by step: [Remote PWA](How-To/Remote-PWA.md).

---

## Logs and paths (desktop)

Where config, logs, and workspace live; copy/open path.

**Background mode:** launch at OS login, “Hide to tray”. How-To: [Tray and background](How-To/Tray-and-Background.md).

---

## Other cabinet tabs (not this page)

- **Persona** — assistant tone (`assistant.md`).
- **Skills** — what lives in `agents/` and is available via `run_agent`.
- **Activation cache** — `.claw-cache` into a new chat via [HSS](HSS.md). More: [Activation cache](Activation-Cache.md).

Without skills and Host FS the product feels like a “smart chat”. With them — an agent that can actually touch your tasks on disk and outside.

---

## See also

- [About the product](Product.md)
- [FAQ](FAQ.md)
- [Getting started](How-To/Getting-Started.md)
