# How-To: getting started

## Desktop

1. Install claw2 (dmg / AppImage / installer) from **[https://claw2.online/download/](https://claw2.online/download/)**, or build from the repo (`desktop` → `npm run app`).
2. On first launch, complete the LLM screen: API key and, if needed, base URL / model.
3. Chat opens. Try a simple request — e.g. “what time is it” or “what can you do”.
4. Default config: `~/.claw2/claw2.desktop.yaml` (on Windows — under the user profile `.claw2`).

### First / cold start can take a while

Desktop does **not** open the chat until the local runtime is fully ready. On first launch after install, after **Quit**, or after a reboot you may see the splash for **tens of seconds** (often ~10–15 s on a cold Windows disk). That is expected:

1. **Separate Node process** — the gateway is not inside the Electron UI process; it is started and waited on (`/health`) before the main window is shown.
2. **Local embedder warm-up** — with sqlite memory the app loads the on-disk ONNX model (`~/.claw2/models`, ~130 MB) so memory/search are ready when you start chatting.

Later opens are usually much faster while the OS keeps files in cache, and while the app stays in the [tray](Tray-and-Background.md) the gateway is already running.

On unsigned macOS builds Gatekeeper may prompt — **Open Anyway** in Privacy & Security.

## Cabinet

- `Cmd/Ctrl+,` or the **Settings (cabinet)** menu item.
- Tabs: settings, persona, skills, activation cache.

Online guide: [https://claw2.online/wiki/](https://claw2.online/wiki/). Downloads: [https://claw2.online/download/](https://claw2.online/download/).

## Next

- [Settings](../Settings.md) — what to enable so it is an agent, not only chat
- [Embedded browser](Browser.md) — globe, tabs, search, ask about a selection
- [Tray and background](Tray-and-Background.md)
- [Remote PWA](Remote-PWA.md)
