# Project alert policy follows the logical project

A project-level Alert Policy is edited from the logical project shown in the sidebar and Project
Settings. It covers matching physical checkouts and environments, so users do not repeat the same
policy for each worktree or connected machine. The UI grouping is not its persisted identity because
grouping can differ by client. Repository-backed policy uses stable repository identity, and
non-repository policy uses environment-scoped project identity, as recorded in ADR 0019. Thread-level
choices remain the narrower exception for work that should behave differently.
