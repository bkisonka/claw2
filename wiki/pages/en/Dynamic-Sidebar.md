# Dynamic sidebar

In the left chat panel, next to chats and projects, there is a **contextual action menu** — the model fills it for the current task.

## Why

So next steps are buttons, not only text in the reply: “continue”, “open gallery”, “run a check”, an external link, and so on.

## What you see

- A block title (context theme).
- Items (usually few, short labels).
- Statuses such as open / in progress / done — matching the task.

Fixed UI chrome (new chat, skills, search, projects, chat list) is **not** rewritten by the model.

## What a click does

Each item has an action type:

| Action | Behavior |
|--------|----------|
| **prompt** | Sends a prepared text into chat as your next message |
| **navigate** | Goes somewhere inside the app (cabinet, gallery, …) |
| **url** | Opens an external https link |

After a click the agent may refresh the menu for the next stage of work.

## How to use it

1. State the task in chat.
2. Check the contextual actions block — sensible next steps are often already there.
3. Click items instead of retyping long phrases.
4. If the menu is stale, just write a new intent; the model usually rebuilds the items.

## What not to expect

- It is not an “app store” and not a replacement for the settings cabinet.
- Items live in the current chat/session (while the runtime is up).
- The model decides when to clear or replace the menu; you can ask to “clear the sidebar” or “suggest next steps”.

## See also

- [About the product](Product.md)
- [Settings](Settings.md)
