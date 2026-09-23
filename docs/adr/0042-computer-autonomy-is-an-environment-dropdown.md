# Computer autonomy is one environment-wide dropdown

Each environment has one Computer autonomy setting. It is shown as a dropdown styled like the composer's runtime-mode menu. It applies to every project and thread in that environment. A per-project setting would be illusory: an agent in one project can reach any app on the controlled computer.

The most permissive level turns off Synara's task approval, additional-app approval, foreground-use gating and clipboard-read approval. It also lets scheduled tasks and delegated subagents use the computer. Only admin clients (`access:write`) can raise the level. Settings and every Computer transcript row show when an environment is running with reduced oversight.

Three safeguards hold at every level and cannot be configured away:

- The denylist: password managers, Keychain Access, Passwords, System Settings and SecurityAgent.
- Stop and the physical Escape kill switch.
- The local audit log.

The levels between these extremes are recorded in the follow-up decision.
