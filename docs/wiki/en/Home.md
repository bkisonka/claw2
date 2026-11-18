# Claw2 — User Guide

A personal agent you control from chat. This wiki is for the app owner, not platform developers.

**Site:** [https://claw2.online/wiki/](https://claw2.online/wiki/) · [Русский](../ru/Home.md)

> **⚠️ Models and billing:** claw2 does **not** provide neural-network access by itself and does **not** include a bundled cloud chat. For the agent to reply, you connect **your own** local models (Ollama, etc.) **or** **your own** provider API keys (OpenAI, Claude, and others) under [Settings → LLM](Settings.md#llm). API costs and quotas are **yours**; the app does not pay for or subsidize them.

> **File access:** claw2 does **not** open arbitrary folders by default. Which host paths skills may use is decided **by you** via **Host FS access** in [Settings](Settings.md#host-fs-access).



## Sections

- [About the product](Product.md) — what claw2 is and why
- [HSS](HSS.md) — dialogue stabilizer between you and the model
- [Settings](Settings.md) — cabinet: what to enable so it is an agent, not only chat
- [Dynamic sidebar](Dynamic-Sidebar.md) — contextual action menu in chat
- [Activation cache](Activation-Cache.md) — context-vector trajectory into a new chat’s structure
- [Projects](Projects.md) — related chats as shared context for the model
- [FAQ](FAQ.md)



## How-To

- [Getting started](How-To/Getting-Started.md)
- [Embedded browser](How-To/Browser.md)
- [Tray and background](How-To/Tray-and-Background.md)
- [Remote PWA (phone)](How-To/Remote-PWA.md)
- [Voice](How-To/Voice.md)



## Quick start

1. Install the desktop app and configure a model (API key / base URL).
2. Write what you need in chat — the agent may call a skill or suggest next steps in the sidebar.
3. Globe in the sidebar footer — [embedded browser](How-To/Browser.md) (desktop): page beside chat, ask about a selection.
4. For phone access: set up remote HTTPS and a **PWA access token**, then open `/pwa/` in Safari.

