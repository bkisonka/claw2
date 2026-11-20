# How-To: tray and background

## Why

Closing the window **does not stop** the agent: the app moves to the menu bar / notification area. The gateway keeps running — chats and remote PWA stay available.

## How to use it

1. Close the window with the close button or choose **Hide to tray** — the app stays in the tray with an icon.
2. **Minimize** keeps claw2 on the taskbar as usual.
3. On **Windows**: left-click the clock-area icon to open the window; right-click for the menu. The icon may sit in the overflow tray (`^`).
4. On **macOS / Linux**: a click opens the **menu**; use **Open claw2** for the window.
5. Full exit — only **Quit** in the tray menu (or the matching app menu item).

## Launch at login

In **Settings → Logs and paths** (or the tray menu) enable launch at login. On autostart claw2 usually comes up hidden (tray + runtime).

## Cold start after Quit

**Quit** stops the gateway. The next launch waits again for a separate Node runtime and may warm the local embedder — see [Getting started](Getting-Started.md#first--cold-start-can-take-a-while). Prefer hide-to-tray when you only want the window gone.

## See also

- [Remote PWA](Remote-PWA.md)
- [FAQ](../FAQ.md)
