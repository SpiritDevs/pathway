# Company assets implementation status

Work is on `feat/company-assets`, based on TestFlight 19 source `3e42a644c` and the approved asset design. The existing compact composer layout changes are retained.

## Review evidence

- [iPhone screenshots and video](https://planlink.spiritdevs.com/d/uplyayaaknnj)
- [Desktop screenshots and video](https://planlink.spiritdevs.com/d/p925pmc5f6nm)

The recordings use local sample files with the production media/library components. They demonstrate playback, gallery navigation and file management UI. They do not demonstrate a production upload or a second device reading production storage. The desktop recording was verified to retain its embedded video after publication.

## Implemented behavior

Company-owned private originals and compatible representations have stable IDs. New composer uploads survive disconnects through the account-owned outbox, retain originals, and bind to the queued message atomically. User and agent assets render in conversations. Settings and thread Assets expose file management, sharing, Trash, usage and migration controls.

Storage delivery checks access for each private read/range request. Share expiry and revocation are separate from read tickets. Trash revokes links; restore does not resurrect them. Context deletion preserves reused/kept assets. Quota reservations and processing leases are fenced against retries and stale workers. Thread badge counts are maintained aggregates and preview claims are indexed.

Provider attachment handling preserves the asset identity and selects a compatible cached representation. Claude's native image forwarding is explicitly covered. Image conversion is bounded below the model image limit; WAV is converted to inline-compatible M4A. A real HEIC file was converted through the worker's command path on this Mac, producing a 103,158-byte PNG.

MCP uploads are scoped to the current thread, including projectless conversations. Optional management requires explicit environment service permissions and cannot broaden an asset beyond that thread. User instruction flags are not permission grants.

## Validation

Final focused verification passed:

- Server: 64 tests across upload/MCP registration, queue delivery, file storage, prompts and media conversion; six additional Claude attachment cases passed.
- Backend: 56 tests across asset lifecycle/permissions, private media delivery, migration and queue operations.
- Web: 56 tests across asset upload, queue, media/gallery, legacy alias rendering and workspace publication; earlier settings checks also passed.
- iOS: 16 final asset/markdown tests and 21 previously verified queue tests. The linked-image parser regression was fixed and rerun successfully.
- Scoped server, backend and web typechecks and targeted lint passed. Native signed simulator builds passed.

No repository-wide test run was requested or performed.

## Deployment boundary

This work has not been deployed to production or uploaded to TestFlight. Production private ACL configuration, coordinated backend/environment/client deployment and cross-device storage acceptance remain unverified. Preview processing requires an explicitly authorized environment with FFmpeg. See [the rollout runbook](company-assets.md).
