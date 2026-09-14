# Task-aware orchestrator delegation

Investigation and implementation for COR-95, based on main `a26f42e0e`, 14 September 2026.

## What selected Astra High?

There are two independent selection paths.

| Path                              | Resolution before this change                                                                                              |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Cloud coordinator reasoning       | Ordered `OrchestratorConfig.models`; an empty list uses the Codex Astra model with High reasoning.                         |
| Cloud delegated project work      | Explicit `delegate.selection`, then the target's `project.defaultModelSelection`, then its `textGenerationModelSelection`. |
| Cloud delegated project-free work | Explicit selection, then the target's `textGenerationModelSelection`.                                                      |
| Thread MCP delegation             | Separate `OrchestratorMcpService` path with its own capabilities tool and parent inheritance.                              |

`aiOrchestratorWork.queueOrchestratorWork` persisted `selection:null` unchanged. `refreshOrchestratorWork` sent that null in the environment command. `environmentCommandClaimant.makeLiveExecutor` resolved it on the target. Null therefore records default resolution, not an intentional Astra High choice or inheritance from coordinator reasoning.

The old claim request contained only provider instance IDs and driver names. `contextFor` exposed environment descriptors and resource observations but no selectable models or reasoning options. The coordinator could not inspect a model catalog in this context. The user supplied the same observation for this assignment.

A read-only check of this Mac's live settings found no persisted text-generation override. Its Pathway project's saved selection was `codex_work / gpt-6-astra`, with Medium reasoning and the default service tier. At this revision the source text-generation default is `gpt-5.6-luna` with Low reasoning. These observations do not establish the saved settings on the reported remote host at the time of its High runs. The runtime mechanism is verified; the exact historical remote default remains unverified. No live settings or database rows were changed.

Code evidence: `apps/server/src/cloud/orchestrator.ts`, `packages/backend/convex/aiOrchestratorJobs.ts`, `packages/backend/convex/lib/aiOrchestratorWork.ts`, `apps/server/src/cloud/environmentCommandClaimant.ts`, and `packages/contracts/src/model.ts`.

## Public implementations

These are documented mechanisms, not comparative quality or cost measurements.

- [OpenCode agents](https://opencode.ai/docs/agents/) configure descriptions, models and permissions per agent. Its task permissions restrict which subagents a caller can invoke. Descriptions help the parent select a worker. [Public implementation](https://github.com/anomalyco/opencode/tree/dev/packages/opencode/src/agent).
- [Deep Agents subagents](https://docs.langchain.com/oss/python/deepagents/subagents) expose named workers with descriptions and optional model/tool overrides. An omitted model inherits the parent. [The public middleware](https://github.com/langchain-ai/deepagents/blob/main/libs/deepagents/deepagents/middleware/subagents.py) places the available agent descriptions in the delegation tool's instructions. This is a concrete example of giving the coordinator a catalog instead of expecting it to guess.
- [Oh My OpenAgent model matching](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/guide/agent-model-matching.md) uses task categories, configured model overrides and built-in fallback chains. Its documented resolution picks the first serviceable model and normalizes reasoning to supported settings. This offers flexibility, but Pathway's account allowances make automatic cross-account replacement a separate authorization concern.

Our recommendation is to adopt descriptive worker presets and real discovery, while keeping worker fallback explicit. We did not import third-party model rankings, identifiers or price tables. A preset's relative cost is a user's estimate. Without evidence, price, quality, image input and external-tool support remain unknown.

## Implementation

Environment workers publish a compact catalog from their cached provider snapshots. It includes instance identity, driver, availability, advertised models and option descriptors, plus the environment default. It excludes account details, credentials, prompts and project inventories. Publication occurs on change or after 60 seconds. Context hides catalogs older than 120 seconds. Catalogs are capped at 50 providers, 100 models per provider, 200 models overall and 24,000 encoded characters per catalog, with truncation reported explicitly. Total catalog context is bounded to 64,000 characters; omitted catalogs are identified.

The cloud context includes catalogs and worker presets only for environments already eligible under the orchestrator's existing scope. Presets contain a name, environment, exact selection, task guidance and relative cost. They do not grant capabilities. Coordinator guidance covers complexity, required tools, availability, cost uncertainty and escalation after a concrete failure. It requires explicit user requests to take precedence and forbids switching accounts to escape an allowance hold.

Resolution is now explicit action selection, then the first worker preset for that environment, then the existing project/environment defaults. Null remains backward compatible. No unavailable preset is replaced with another model. Action options decode strictly, so malformed reasoning overrides are rejected rather than silently dropped. Requested choices are checked against published discovery when present, and the target validates its current provider, model and options before launching. Existing project bindings, audience checks, command claims and allowance admission remain in place.

The assignment retains its requested selection and concise selection reason. When default resolution occurs on the target, its published thread shell supplies the effective model for display. The shared work list shows this in both the timeline and details panel, including the floating conversation view.

Web and Electron use the same settings editor. Native iOS preserves worker presets when saving settings, and cloud selection applies to its conversations; preset editing remains in web/desktop. No provider adapter behavior or attachments interface was changed. Codex, Claude, Cursor, Grok, OpenCode and registered additional drivers use their own advertised catalogs. Coordinator-only driver restrictions remain separate from worker availability.

## Validation and limits

Focused backend tests exercise catalog visibility, null defaults, explicit model/reasoning overrides, rejected selections, command payloads and older-client settings preservation. Server tests cover discovery bounds, unavailable providers, default precedence, refusing launch after validation fails and recovering accepted launch receipts after provider availability changes. Existing coordinator, command claimant and authorization tests run alongside them.

The screenshots in `evidence/cor-95` use the production web components and model picker with local fixture environment/settings data. They prove presentation and interaction, not deployment or cloud authentication. No real provider work was launched. Task suitability is coordinator judgment supported by guidance, not a benchmarked routing classifier. Provider catalogs currently lack certified per-model prices, image capabilities and tool inventories. Older environments do not publish this catalog or perform the new target validation, so upgrading the cloud backend and executing environments is required for the full behavior.

COR-94's attachments implementation was read only to establish scope. No attachment schemas, upload flows or file retrieval behavior were edited. Nothing was published, merged or deployed.

Validation result: 117 focused tests passed. Targeted server, web and backend typechecks passed. The local browser component pass exercised preset editing, cost, reasoning, reasoning reset, adding/removing presets and the actual model picker, with wide and narrow screenshots.
