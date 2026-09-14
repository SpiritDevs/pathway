# COR-95 review evidence

These screenshots use the actual Pathway model settings, model picker and work list components, with fixture provider/settings data in an isolated Vite preview. They are not screenshots of a deployed backend or real delegated runs.

- [Before, coordinator models only](coordinator-model-settings-before.png)
- [After, separate worker presets and defaults](worker-model-settings.png)
- [Actual provider/model picker](worker-model-picker.png)
- [Narrow web layout](worker-model-settings-narrow.png)
- [Selection explanations and an unavailable worker](worker-selection-reasons.png)
- [Worker preset interaction recording](worker-model-interactions.webm)

The browser pass verified editing the preset name and cost, selecting reasoning, clearing reasoning to provider default, adding a model from the discovered fixture catalog, removing that preset and opening the production model picker. No browser console errors occurred. The before image uses the original model editor from base commit a26f42e0e inside the same preview wrapper.

The local preview and capture scripts are retained in this worktree's ignored `.pathway/selection-preview` directory. Browser evidence attachment through the collaborative Preview tool was unavailable; these images are retained with the reviewable Git changes instead.

117 focused tests passed across the coordinator backend, coordinator runtime, command claimant and selection discovery. Targeted server, backend and web typechecks passed. Targeted lint and whitespace checks passed.

See [the investigation and research](../../docs/internals/orchestrator-selection.md) for selection precedence, sources, compatibility and remaining limitations.

PR review follow-up: [switching a worker to another environment](worker-environment-switch.png) now replaces its provider/model and clears its old reasoning options. Browser checks covered switching back and disabling environments with no discovered models. The three affected backend/server suites passed 107 tests, including new expired-catalog and legacy-alias regressions. Scoped server, web and backend typechecks and targeted lint passed. The native work card now displays the worker model and selection explanation; Swift syntax parsing passed, but a native build and simulator verification were not run for this follow-up.
