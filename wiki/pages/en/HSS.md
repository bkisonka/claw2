# HSS — dialogue stabilizer

**HSS** (HyperSemantic Stabilizer) is the claw2 layer **between you and the model**. It keeps the line of the current chat, maintains a semantic chronicle, and adjusts the reply mode when the discussion starts to drift.

The model still writes the text and the meaning of the answer. HSS does **not** replace it and does not “think instead” of it — it is the in-app orchestrator of **coherence**.

## Why it exists

In a typical chat client, context is mostly the message window (sometimes a compressed summary). Staying on topic is almost entirely up to the LLM provider: change the model or go deep, and the line is easy to lose.

In claw2, stability is an **application property**: on every turn HSS updates the session contour and, via system context, tells the model how to answer (normally / more structured / only from dialogue facts).

## What it does

1. **Stabilization** — watches how far a reply drifts from the chat line and sets the reply mode.
2. **Chronicle** — stores *what the thread was about* (meaning, conclusions, terms) and mixes relevant fragments back into context.
3. **Activation-cache bridge** — the starter chain of context vectors from `.claw-cache` is seeded into this contour of a new chat.

Nearby, but separate:

| Contour | Question |
|---------|----------|
| **Chronicle (HSS)** | What was the line of this chat about? |
| **Transcript** | What was said verbatim? |
| **Cross-chat memory** | What is saved “for the long term”? |
| **Projects** | What shared context does a group of chats have? |

## How it differs from typical products

| Typical chat / API wrapper | claw2 + HSS |
|----------------------------|-------------|
| Context ≈ feed (+ sometimes summarize) | A separate **session semantic contour** |
| Topic held “as the model manages” | The app **corrects reply mode** from outside |
| New chat almost from scratch | You can carry over a **context trajectory** ([activation cache](Activation-Cache.md)) |
| Often one pile of “memory” | Separated: chronicle / verbatim / cross-chat / [projects](Projects.md) |

The uniqueness is not “magical intelligence”, but that **stability orchestration is a claw2 product**, not a bet on one LLM provider. A weak or swappable model still runs inside your contour.

## What HSS is not

- Not the agent’s consciousness and not access “inside” a cloud model.
- Not an infinite context window (long context is still compressed; verbatim lives in the transcript and UI feed).
- Not a truth guarantee and not a replacement for skills, tools, or memory.
- Not API-model hidden states (cache vectors are a local rebuild from text; see [Activation cache](Activation-Cache.md)).

## What you notice as a user

Most of the time HSS works **quietly**: a long, topical dialogue is less likely to collapse into “how can I help?”, and session agreements hold better. Visible traces are the activation cache in the cabinet and a new chat with a selected cache starting already inside a shaped topic contour.

## See also

- [Activation cache](Activation-Cache.md)
- [Projects](Projects.md)
- [Product](Product.md)
- [FAQ](FAQ.md)
