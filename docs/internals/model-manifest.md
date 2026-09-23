# Updating the model manifest

The server fetches `apps/server/src/provider/model-manifest.json` from the
`main` branch of `SpiritDevs/pathway`. Bump `updatedAt` when publishing changes;
older manifests cannot replace the bundled or cached copy. Keep `version: 1` so
existing clients can continue reading current/legacy classifications.

`models` maps driver IDs and model slugs to `current` or `legacy`. Codex still
gets available models and capabilities from its provider. For Claude, use
`claudeAgent` as the driver ID.

The optional `claudeModels` array adds or overrides Claude catalog entries. Each
entry contains `model` (the existing `ServerProviderModel` wire shape, with
`isCustom: false`) and an optional `minimumVersion` (a Claude Code version such
as `2.1.280`). List new models first and give each slug one entry. The bundled
Opus 5.5 entry is an example. Existing hardcoded Claude models remain fallbacks.

Claude picker snapshots, chat execution, and utility text generation consume the
same manifest capabilities. Existing option IDs are `effort`, `contextWindow`,
`fastMode`, and `thinking`; new execution behaviors still need adapter code.
Model entries do not grant account access or install a newer provider CLI.

Provider checks refresh the shared manifest when provider update checks are
enabled. Successful downloads are cached for one hour; failures retry after five
minutes. Invalid or older downloads retain the last good data. The cache is
local to the environment, whose snapshots serve all connected clients.

Servers predating Claude catalog support need one update before they can consume
`claudeModels`. Later catalog changes can then ship through GitHub alone.
