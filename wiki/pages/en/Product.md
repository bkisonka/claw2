# About the product

## What it is

**claw2** is a personal chat agent on your computer: model + **HSS** (dialogue stabilization) + skills. You write in plain language; the agent replies, runs tools, and can **extend itself with new skills** when needed — still under your control.

This is not a multi-tenant cloud SaaS. It is **one owner — one instance**.

The [HSS](HSS.md) layer is what sets claw2 apart from a plain API wrapper: long-dialogue stability is an application property, not only a property of the chosen model.

## Main flow

1. Open the app (or the PWA on your phone).
2. Describe a task in chat.
3. The agent replies with text, files, or media; when useful it updates the **dynamic sidebar** with next-step buttons.
4. On desktop: the globe opens an **embedded browser** (tabs, search, ask about a selection) without leaving for an external Chrome.
5. Closing the desktop window can leave the runtime in the tray — handy for remote access.
6. When a topic repeats (and Insights are on), the agent may **ask** whether to link the turn to a past chat — without inventing “we discussed…”.

## Interfaces

| Interface | Purpose |
|-----------|---------|
| **Desktop** | Primary client: chat, cabinet, settings, tray; **globe** — [embedded browser](How-To/Browser.md) |
| **PWA** (`/pwa/`) | Mobile access to the same chats over HTTPS (no embedded browser) |
| **Telegram / VK** | Optional channels (configured in the cabinet) |

### Embedded browser (desktop)

**W** mode in the sidebar footer: the page fills the main area; chat stays at the bottom and in an overlay. The model does not scan the DOM by itself — only an explicit selection (“Ask assistant”) or your composer text. Address-bar search lands in the browser chat with links (or DuckDuckGo if search is unset). Details: [How-To: browser](How-To/Browser.md).

## What claw2 is not

- A universal “all messengers at once” platform — channels are added as needed.
- A public site with no protection: remote PWA requires an **access token**.
- A full Chrome replacement (no separate claw2 password manager, no browser inside the PWA, etc.).

## See also

- [Settings](Settings.md)
- [Embedded browser](How-To/Browser.md)
- [HSS](HSS.md) — dialogue stabilizer
- [Dynamic sidebar](Dynamic-Sidebar.md)
- [Projects](Projects.md)
- [Getting started](How-To/Getting-Started.md)
