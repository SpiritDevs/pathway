# Conversation controls review evidence

These existing captures were collected during the accepted implementation, before PR preparation. They are not a new authenticated end-to-end run.

- [Thinking badge before](thinking-badge-before.png) and [after](thinking-badge-after.png): actual composer with sample activity; only its small activity avatar badge changes. This capture predates the later inline recipient and Typing updates.
- [Human recipient picker](human-mention-full.png): actual shared composer with sample recipients and captured requests, without backend dispatch.
- [Floating Typing control](scroll-typing-floating.png): actual conversation components with sample messages/activity.
- [Conversation menu](full-menu.png) and [deletion confirmation](delete-confirmation.png): actual sidebar/menu components with sample state and mocked mutation responses. Backend lifecycle and persistence are verified independently by tests.
- [Earlier conversation recording](reply-demo.mp4): historical baseline for the existing reply/message interaction; it predates the final sidebar, recipient and Typing changes and is not evidence of their final animation or live delivery.

The implementation's earlier browser checks covered both full and floating modes, compact/wide sidebar controls, selection persistence, keyboard recipient selection, row menus and confirmation dismissal. No real conversations were archived or deleted for testing. No live-provider termination or full authenticated E2E validation is claimed.
