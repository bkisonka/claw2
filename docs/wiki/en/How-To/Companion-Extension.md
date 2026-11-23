# Companion extension

The browser deployment has no embedded engine — and does not need one. The
**claw2 companion** is a small browser extension (Chromium, Manifest V3) that
puts claw2 onto the real web: a pill on every page, a chat panel as an
overlay, the composer pinned to the bottom, and the page's text/selection
attached to every question.

## Install (once)

```bash
cd extension
npm install
npm run build      # → extension/dist/
```

Then in the browser: `chrome://extensions` → enable **Developer mode** →
**Load unpacked** → select `extension/dist`.

## Connect

Open the extension's settings (puzzle-piece menu → claw2 companion, or the
toolbar icon):

- **Gateway URL** — where your claw2 runs, e.g. `http://127.0.0.1:8080`;
- **Gateway API key** — the same key the web UI uses (`CLAW2_GATEWAY_API_KEY`
  from `.env`).

**Test connection** should answer `Connected (claw2 <version>)`. The key
lives in the extension's local storage and is sent only to the gateway; page
scripts never see it.

## Use

- The **claw2 pill** appears on every http(s) page. Click it — the panel
  opens: history of this tab's chat on top, composer at the bottom.
- Ask anything: the model receives the page (url, title, up to 16k of text)
  plus your selection as untrusted external context — the same `<<<EXT>>>`
  isolation the desktop browser mode uses.
- Select text on the page → right-click → **Ask claw2 about "…"** — the
  panel opens with the quote.
- When the model answers with `open_browser`, the tab navigates; the chat
  continues (the session is remembered per tab).
- The chat shows up in the claw2 sidebar bound to the page (browser_page_key),
  like desktop browser chats.

## Notes

- The extension talks to the gateway directly; enable `gateway.auth` (API
  key) so the connection is authenticated, as with the web UI.
- Firefox and store packaging are on the roadmap; today: Chromium, load
  unpacked.
