# Activation cache (`.claw-cache`)

Importing a cache raises the **saved context-activation trajectory** of a past deep dialogue and, from it, **builds the deep structure of the current chat** — so a new discussion does not start on an empty field, but inside an already shaped topic contour.

It runs **once**: on the **first message of a new chat**, if a `.claw-cache` is selected in the cabinet.

## What import actually does

A `.claw-cache` file is a snapshot of a strong dialogue. On the first turn of a new session the runtime:

1. **Raises the chain of context vectors** from the past dialogue in `activation/vector.npy` and seeds it into the [HSS](HSS.md) chronicle / contour of the **current** chat — the contour the discussion then continues on.
2. **Prepends a dialogue fragment** up to peak depth (`activation/dialogue.jsonl`) as starting context for the first request — so the model enters the same reasoning flow immediately.

These are **not** hidden states / activations of an API model. On export the chain is rebuilt from **message text** via the local ContextEncoder (part of HSS) and stored in the cache; on import that trajectory is seeded into the new chat’s structure.

Result: the new chat inherits not a “list of facts”, but the **starting thinking contour** of the earlier conversation, and deepens the topic in its own session.

## What it is not

| It is | It is not |
|-------|-----------|
| Context-vector chain → [HSS](HSS.md) contour of the **new** chat | Hidden states / activations of a cloud LLM |
| A `.claw-cache` file (ZIP): export / import / pick in the cabinet | Extra model weights or fine-tuning |
| Once at the start of a **new** session | Re-injected on every message |
| A deep start for the discussion | Long-term memory of your facts |

Facts still come from the current chat, tools, and memory. The cache sets the **deep start of the discussion**, not an archive of answers.

## How to use it

### 1. Cabinet → Activation cache

1. Open **Cabinet → Activation cache**.
2. Set a **cache directory** (folder for `*.claw-cache` files) and save.
3. **Import** a `.claw-cache` file, or put files into that folder yourself.
4. **Select** one cache from the list (or “No cache”).

The selection is stored in config. Without a directory / selection, new chats start with no activation.

### 2. Export from a chat

From a good, deep dialogue:

1. Open the chat menu in the sidebar (⋯ on a chat).
2. Choose **Export to .claw-cache**.
3. Save the file, then import it under Activation cache (or place it in the cache directory).

That turns a past dialogue into a source of context trajectory and structure for later discussions.

## What you should expect

- On the **first** message in a **new** chat with a cache selected, the past dialogue’s context-vector chain is raised and the deep structure of **this** chat is formed; a short starter dialogue may be prepended to the first request.
- From the **second** message in the same chat, the cache file is **not** re-read — the live structure of the current chat takes over.
- On a casual “hi”, the effect may be almost invisible; on a topic close to the export, depth usually shows up sooner.
- A new chat or switching chats starts a new session — activation can apply again on that first turn.

## What not to expect

- It will not replace Settings, Skills, or memory.
- It is not a search index over old chats and does not paste the full history into the UI transcript.
- A poor or off-topic export will not magically make the model an expert.

## See also

- [HSS](HSS.md) — dialogue stabilizer
- [Settings](Settings.md) — cabinet overview
- [Getting started](How-To/Getting-Started.md)
- [FAQ](FAQ.md)
