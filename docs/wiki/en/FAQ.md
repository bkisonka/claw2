# FAQ

## Why is the first launch (or launch after Quit) so slow?

The UI waits until a **separate Node gateway** answers `/health`, then may **warm the local ONNX embedder** (~130 MB under `~/.claw2/models`) so memory is ready. On a cold disk that often takes **~10–15 seconds**; later starts are usually faster. See [Getting started](How-To/Getting-Started.md#first--cold-start-can-take-a-while).

## Where did the window go when I closed it?

To the tray. The agent can keep running. Full quit is **Quit** in the tray menu. See [Tray](How-To/Tray-and-Background.md).

## Why can “anyone” read from my phone / why ask for a token?

Public HTTPS without a **PWA access token** is locked on purpose. Set the token in desktop settings and enter it in the PWA. See [Remote PWA](How-To/Remote-PWA.md).

## Where is the config?

Usually `~/.claw2/claw2.desktop.yaml`. Paths are also listed under Cabinet → Logs and paths.

## Why doesn’t the model “see” skills?

Check the **Skills** tab and the agents directory. Some skills need Docker/sandbox. Ask in chat “what skills are available”.

## Why can’t a skill see my files / Documents?

By default on the host only `agents/` is readable and only `agents/output` is writable. Other folders need **Settings → Skill sandbox → Host FS access** (allowlist or full). See [Settings](Settings.md#host-fs-access).

## What are the buttons on the left under chat/context?

That is the [dynamic sidebar](Dynamic-Sidebar.md) — next steps from the model.

## What is HSS?

The claw2 layer between you and the model: keeps the chat line, maintains a semantic chronicle, and adjusts reply mode. Stability is an application property, not only the chosen LLM. See [HSS](HSS.md).

## What is “Activation cache” / `.claw-cache`?

On the first turn of a **new** chat it raises the past dialogue’s context-vector chain and seeds it into the [HSS](HSS.md) contour of the current discussion — not memory of facts and not API-model hidden states. See [Activation cache](Activation-Cache.md).

## What are projects for?

A group of related chats with a shared goal. The model treats the project as **shared context** (goal + short digests of sibling chats); priority stays with the current dialogue. See [Projects](Projects.md).

## What does the globe in the sidebar do?

On **desktop** it toggles chat and the [embedded browser](How-To/Browser.md): tabs, address bar, search into the browser chat, ask the model about a selection. Each tab has its own context; revisiting the same page continues the **same** chat with time markers. The PWA has no embedded browser.

## Voice sends text but the mic stays “on”

It should turn off after release. Update PWA/desktop. If the indicator sticks — restart the app and check OS permissions.

## Guide is outdated / missing a section

File an issue or edit `docs/wiki/` in the repo. Published at [https://claw2.online/wiki/](https://claw2.online/wiki/).

## Is this developer documentation?

No. Roadmaps, specs, and architecture live in other `docs/` files, not in this wiki.
