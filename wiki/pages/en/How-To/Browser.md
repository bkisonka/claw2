# How-To: Built-in browser

Available **only in desktop**. In PWA and a regular browser the globe control is unavailable or shows a stub.

## Enter and leave

At the bottom of the sidebar:


| Control | Meaning |
| ------- | ------- |
| Letter on the avatar | **C** — chat mode; **W** — browser mode |
| Globe | Toggle chat ↔ browser |
| Gear | Settings |


In browser mode the main area is the page; the model input stays at the bottom. The full chat transcript is hidden: model replies go into an **overlay** over the page.

**W is an auxiliary mode** for the current chat. Messages from all tabs of the current chat go into **one** CHATID (same as mode C). Each chat still has **its own tab set**: New chat starts an empty browse workspace; selecting a chat in the sidebar restores its tabs. A new chat is created only via **New chat** (and equivalents), not by closing tabs or changing the URL.

## Overlay and history

- The overlay shows the **full** history of the current chat, regardless of tab.
- A compact round button in the **bottom-right** of the page opens the overlay when the chat already has messages (not only via the context menu).
- Between browsing segments the transcript shows **time + site title** markers so you can orient in the dialogue.

## Chrome features

- **Tabs** — new, close, switch; `target=_blank` links and search results open in a new tab
- Back / forward / reload / **stop** (while loading)
- **Home** — empty new tab
- Address bar: URL, visit history suggestions, search (see below)
- ★ in the address bar — bookmark / unbookmark the **current** page; ribbon icon — bookmark list
- Find in page (⌘/Ctrl+F), zoom (± and reset), print
- Lock — site info (HTTPS, permissions, clear site data)
- **Downloads** bar when files are saved

Page context menu: ask the assistant about the selection, open link / in new tab, save, Inspect.

## Ask the model about the page

The model does **not** see the whole page by itself. Only what you explicitly send enters context:

1. Select text on the page.
2. Right-click → **Ask assistant**.
3. The fragment goes into the current chat wrapped as external content; the reply appears in the overlay.

You can also type your own question at the bottom (including after a selection).

## Search from the address bar

If you type **not a URL** but text:

1. With search configured (Tavily / SearXNG / Other), results appear in the **current chat** (overlay) with links.
2. Click a link → **new tab**.
3. If search is not configured or fails — DuckDuckGo opens.

Checkbox **“LLM search in the address bar”** in [Settings → Search](../Settings.md#internet-search-search):

- **Off** (default) — direct search API call, no model tokens
- **On** — short chat turn (model + `search` tool, uses tokens)



## Intentionally not included

- A separate chat per tab / URL
- A dedicated homepage URL from settings
- A full claw2 password manager (passwords — system Chromium/OS)
- Built-in browser in PWA



## See also

- [Product](../Product.md)
- [Settings — search](../Settings.md#internet-search-search)
- [Getting started](Getting-Started.md)
