# Computer autonomy is an environment ceiling over each thread's mode

The environment's Computer autonomy setting lives in Settings and acts as a ceiling. Each thread's existing composer runtime mode applies to Computer Use through a one-to-one mapping, and the thread gets whichever is stricter. No Computer-specific control is added to the composer.

| Composer mode     | Computer level | Task approval  | Extra-app approval | Foreground       | Clipboard reads | Scheduled tasks and subagents |
| ----------------- | -------------- | -------------- | ------------------ | ---------------- | --------------- | ----------------------------- |
| Supervised        | Supervised     | Every mutation | Yes                | Explicit request | Ask each time   | No                            |
| Auto-accept edits | Per task       | Once per task  | Once per app       | Explicit request | Ask each time   | No                            |
| Auto              | Auto           | None           | None               | Explicit request | Ask each time   | No                            |
| Full access       | Full access    | None           | None               | Allowed          | Allowed         | Yes                           |

The environment ceiling defaults to **Per task**, which is Synara's behavior. New threads default to Full access, so the ceiling is what normally applies, and a thread only tightens it deliberately. When the ceiling caps a thread, the composer shows a one-line hint naming the environment limit. Supervised is Pathway's addition: Synara has nothing stricter than one approval per task.

A composer-only model would let any paired client escalate per thread, and it would leave scheduled tasks and subagents without an owner. A Settings-only model would prevent supervising a single thread. Scheduled tasks and subagents have no composer mode, so the ceiling alone governs them.
