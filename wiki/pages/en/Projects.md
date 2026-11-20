# Projects

A **project** is a set of chats around one task (or several related ones). The model treats the project as **shared context**: the project goal plus short digests of sibling chats — not as a separate knowledge base and not as the full history of every dialogue.

Priority always stays with the **current** chat; the project only helps keep a shared line across related discussions.

## How it works

1. In the sidebar you create a project: a **name** and optionally a **goal** (task description).
2. You attach chats to the project (new chat inside the project, or move an existing one).
3. While you are in a project chat, every model request gets in system context:
   - the project name;
   - the project goal (if set);
   - a list of **other** chats in this project with a short digest (prompt summary or the tail of the last message).

The model is told: a project is a **collection of chats for solving a problem**; use the goal and related chats (structure, tasks, notes), but do not invent details beyond the digest and do not replace the ongoing dialogue with them.

A chat **outside** a project is treated in isolation: only that chat’s history, with no mixing from other projects.

## What it is and is not

| It is | It is not |
|-------|-----------|
| Shared context for related chats | The full message feed of sibling chats |
| Goal + short sibling digests | Long-term memory “forever” outside chats |
| Grouping in the sidebar | A separate model mode or another provider |

Each chat still keeps its own history. Sibling chats appear to the model in **compressed** form — as logical links inside one task contour.

## How to use it

1. In the left panel open **Projects** → create a project and set a goal if it matters.
2. You can open a **new chat** directly inside a project.
3. An existing chat can be **attached** to a project or detached via the chat menu.
4. A project can be deleted only if it has **no** chats (move or delete chats first).

The chat header shows the project name — the same shared-context marker the model sees.

## What you should expect

- Replies take into account the project goal and neighboring discussions (plans, agreements, terms from digests).
- Details that are neither in the current chat nor in digests should **not** be invented as facts.
- The clearer the project **goal**, the more stable the shared contour across chats.

## What not to expect

- It is not search across all chats and not the activation cache.
- It does not merge histories into one UI transcript.
- An empty project with no goal and no sibling chats barely changes behavior — it stays an ordinary chat.

## See also

- [HSS](HSS.md)
- [Dynamic sidebar](Dynamic-Sidebar.md)
- [Activation cache](Activation-Cache.md)
- [FAQ](FAQ.md)
