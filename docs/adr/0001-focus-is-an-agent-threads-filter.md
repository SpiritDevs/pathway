# A Focus is an Agent Threads filter, not an app-wide partition

Focuses (user-defined project sets like Work/Personal) scope only the Agent Threads view — thread list, shelves, project dropdown, and search. They deliberately do not partition the rest of the app: that axis already exists as the active-company scope, which filters everything and composes upstream of Focuses (a Focus tab with no visible projects under the current company scope is hidden). A project belongs to at most one Focus; pinned/snoozed/settled remain thread-level states that a Focus merely filters, so no per-Focus copies of any thread state exist.

Projectless conversations add an independent `includeConversations` flag to each Focus. Multiple
Focuses can enable it. Company scope still applies first, using the company selected when the
conversation was created. A Focus that includes conversations remains available without visible
projects. Once a conversation attaches a project, ordinary project membership applies.
