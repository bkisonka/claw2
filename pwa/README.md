# Claw2 mobile (standalone)

> Полное описание Android-приложения — устройство, данные, сборка:
> [`ANDROID.md`](ANDROID.md).

Self-contained Android app + installable web client. **No claw2 backend involved**: the agent runs inside the
app (TypeScript in the WebView) and talks to the LLM API directly — cloud or a local OpenAI-compatible server
on the LAN (LM Studio, Ollama, llama.cpp). Chats, attachments and long-term memory are stored on-device
(IndexedDB).

## Onboarding (first run)

1. The wizard runs **once**. It asks for the model endpoint: **Base URL → API key → model** (e.g.
   any OpenAI-compatible endpoint such as `https://api.openai.com/v1`, or local `http://192.168.x.x:1234/v1`
   for LM Studio, `http://…:11434/v1` for Ollama with `OLLAMA_ORIGINS=*`). The model field is a combobox:
   on focus it fetches `/models`
   from the API and opens a searchable dropdown; manual model ids still type fine.
2. No accounts, no passwords, no pairing — the key you enter is used as `Authorization: Bearer` directly.
   Everything can be changed later in **Настройки** (same Base URL → key → model-combobox form). Breaking
   the connection later never throws you back into the wizard — the app shows a "модель не настроена"
   banner and links to Настройки instead.

## Multiple providers and the router

Настройки → Провайдеры (LLM) holds a registry of providers (name, Base URL, API key, an answering
model, an optional **router model** — cheap, fast, preferably non-reasoning — and a short
**capability note** for the dispatcher; each with its own searchable /models combobox). One provider
is active. With **router mode** enabled (≥2 providers):

- once per turn the active provider's router model reads the dialogue tail and the candidate list
  (models + capability notes + an image-count vision hint) and decides who answers. It may answer
  with `{"id":…}` JSON or a `ВЫБОР=<id>` marker — reasoning providers that dump the answer into a
  `reasoning` field are handled too (20 s timeout, max_tokens 300);
- the routed request goes to the chosen provider/model; a provider that fails before its first
  token — network error, HTTP error, or **no first token within 45 s** — is skipped down the list;
  a stream that already produced tokens is never retried;
- each routed reply shows a `→ model · provider` meta line: tap it to **pin that provider to the
  chat** (the router is skipped while pinned) or unpin. Routing costs one small dispatcher call
  per turn (router mode only) and nothing otherwise.

## Features

- **Chat** — streaming (SSE straight from the provider), cancel, markdown + sanitization, inline cells
  (protocol ported from the desktop `[CELL type="html|chart|image|audio|video"]…[/CELL]` → notebook-style
  blocks: calendars/tables/SVG, interactive charts, media), attachments: images go as vision parts
  (MIME recovered from the extension when Android pickers report none), text documents are inlined,
  **pdf/xlsx/docx are parsed to text on-device** (lazy-loaded readers; scanned PDFs are reported honestly
  instead of being silently ignored). The chat follows the desktop design language: a floating frosted-glass
  composer dock (works in the fold two-pane layout too), plain-text assistant replies, quiet glass chips
  for user messages — same grayscale palette. Messages have the desktop context menu: long-press
  (or right-click) offers copy message/selection, select-all-of-message and quote-into-composer.
- **Context retention** (ported from orchestrator + prompt-history): when the tape grows past
  `summarizeWhenMessagesAbove`, the old head is compressed by the LLM into a recap injected into the
  **system prompt only** (never echoed as assistant speech), cached per chat (`promptContext`), recent
  tail stays verbatim; the UI tape is never rewritten. Tunable in Настройки → Контекст.
- **Session files (virtual FS)** — IndexedDB store replacing `agents/output` + `/files/`:
  `save_document` (docx via the same `docx` library as the desktop agent, plus md/html/txt/csv),
  `list_files`, `read_file`; generated images auto-persist and appear in the Картинки tab;
  files are shareable/savable via the system sheet.
- **Agent tools** (model-callable, all in-app): `calculate` (mathjs), `web_search` (Tavily / SearxNG /
  other API), `fetch_url` (desktop web-fetch counterpart: direct fetch, CORS-proxy fallback),
  search fallback without any API (DuckDuckGo via the proxy), `generate_image` (OpenAI-compatible or A1111),
  `remember`/`recall` (long-term memory), `save_document`/`list_files`/`read_file`.
- **Memory** — chunks in IndexedDB; semantic search via an optional embeddings endpoint
  (OpenAI-compatible `/embeddings`), keyword fallback without one.
- **Persona** — full/compact system prompt, assistant name.
- **PTT voice** — hold-to-talk → WAV → your STT: standard OpenAI-compatible settings
  (**Base URL + API key + model**, e.g. `whisper-1`; request goes to `{base}/audio/transcriptions`;
  a full legacy `/stt` URL also works).
- **Sessions** — list, history, delete (inline confirm), **markdown export** (per-chat button in the
  list, desktop-compatible format, saved via the system share sheet); everything persists across restarts.

## Parity map vs desktop (honest status)

| Desktop mechanism | Mobile status |
|---|---|
| Inline cells `[CELL …]` | ✅ ported (parser + prompt protocol) |
| Context retention (summarize + prompt window + coveredCount) | ✅ ported |
| Session files `/files/output`, docx/calendar/chart agents | ✅ as native tools + virtual FS (docx via same `docx` lib; calendar/chart via inline cells — interactive, better than PNG) |
| web-fetch fallback for search | ✅ `fetch_url` + DDG-via-proxy fallback (CORS proxy configurable in settings) |
| Script-agent sandbox (`run_agent`, node in container) | ❌ not portable to WebView (needs a JS sandbox runtime); the useful agents' outcomes are covered by native tools above |
| HSS (hss.cjs + hss-* middleware, LGPL math core) | ❌ not ported yet — pure math, technically portable, but a separate project (2.5k lines + wiring) |
| Sandbox code execution, in-app browser tabs, SIP calls, Telegram/VK bots, multi-user auth, remote access | ❌ server/desktop-only by design |
| pdf/xlsx/mammoth readers | ✅ inbound-attachment readers ported (`pdf.js` + SheetJS + mammoth, lazy chunks) |
| mermaid cells, ocr | ❌ candidates for future native tools (browser builds exist) |
- **Foldables / tablets** — viewport ≥ 640 dp: permanent two-pane layout (list + detail); folded/phone:
  single-column stack. Hardware/gesture back walks the stack and minimizes at the root.
- **Native niceties** — Capacitor shell (system WebView, ~5 MB APK, no Electron), status bar theming,
  mic permission for PTT, files saved via the system share sheet.

## Build

```bash
cd pwa
npm install
npm run dev            # web dev at http://localhost:5174/pwa/
npm run build          # web build (served anywhere, still fully standalone)
npm run android:apk    # APK: android/app/build/outputs/apk/debug/app-debug.apk
npm run android:open   # open in Android Studio
```

`JAVA_HOME` falls back to the Android Studio JBR inside `android:apk`. Requires the Android SDK.

## Intentionally out of scope

Server-side desktop features: sandboxed code execution, in-app browser tabs, SIP calls, Telegram/VK bots,
multi-user auth, remote access. The mobile app is a single-user assistant with direct API access.

## Privacy note

The API key and all chats live in the app's local storage on the device. Local LLM endpoints keep data on
your network; cloud endpoints send conversation content to the provider you configure.
