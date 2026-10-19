# Pathway menu bar — spec (grilled & locked, 2026-08-30)

A macOS menu bar companion: CodexBar-style provider usage at a glance plus Pathway's unique advantage — live thread state and quick controls — without opening the main window. All open questions below were resolved with Corey in the 2026-08-30 grill session; decisions are marked **[locked]**.

## Goals

- Glanceable provider allowances (per configured provider instance, de-duplicated per account) with reset countdowns.
- Active-thread awareness across all connected environments: what's running, what needs me (Attention Events), one click to act.
- Quick controls **[locked: all four]**: inline approve/deny, mini new-thread composer, interrupt/stop, snooze/settle.
- Works while the main window is closed.

## Non-goals (v1)

- Cost/spend analytics in the dropdown (system B stays in Settings → Usage).
- New provider usage drivers **[locked: existing three only — Codex, Claude, Cursor]**.
- Companion-owned credentials or Clerk sign-in in the helper.
- Desktop widgets, CLI, HTTP dashboard.

## Architecture [locked]

**Native Swift helper app on macOS, protocol-first so Windows/Linux follow later via an Electron tray consuming the same snapshot.**

```
environment servers (apps/server, N of them: local + remote/relay/tunnel)
        │  existing WS + new subscribeProviderUsage push (audit step 3)
        ▼
Electron main process — TRAY AGGREGATOR (client-runtime in main process)
  composes TraySnapshot across the connection catalog
        │  local unix socket (0600), newline-delimited JSON, versioned contract
        ▼
Swift helper app (MenuBarExtra, macOS 13+), embedded in Pathway.app
```

- **Aggregation [locked]:** the Electron main process already holds every environment connection and token; it composes the tray snapshot and serves it over a local socket. The helper is single-connection dumb. The future Win/Linux Electron tray reuses the same aggregator in-process.
- **Auth [locked: local token handoff]:** the helper never sees Clerk or environment tokens. The Electron process authenticates the socket (path in a private app-support dir, peer-credential check, per-launch secret passed to the helper at spawn). Existing pairing-token machinery stays untouched.
- **Packaging [locked: embedded helper]:** small Swift .app inside Pathway.app, same signing team, launched and supervised by Electron main, ships with the existing updater. Full quit (tray "Quit Pathway" or Cmd+Q) exits both.
- **Lifecycle [locked: Electron stays headless, default on]:** closing the main window keeps the Electron process (server host, connections, updater, aggregator) and tray alive; dock icon hides while headless. Setting to opt out.
- **Contracts [locked: composed tray snapshot, not Swift contract ports]:** one `TraySnapshot` schema in `packages/contracts` (usage per account, attention rows, active thread rows, allowed quick actions, environment status) plus a small command set (approve/deny, launch thread, interrupt, snooze/settle, open-in-app deep links). The Swift side hand-mirrors only this one small contract. No Effect-Schema→Swift codegen for now.

Rejected in grill: Electron popover on macOS (wanted native), Swift-side Clerk independence (later maybe), per-environment helper connections, full contract porting/codegen, local-environment-only v1.

## Dropdown layout (top → bottom)

1. **Header**: environment status (per-environment connected/reconnecting dots when >1), "Open Pathway".
2. **Needs attention** (only when non-empty) **[locked: same persisted notification log as the Focus Strip, ADR 0003; opening the dropdown zeroes badges everywhere]**: thread title, project, age; inline **Approve/Deny** for pending permission requests; **Snooze/Settle** on other rows; click → open thread in main window.
3. **Active threads**: running turns with provider icon, thread title, project, elapsed time; **Stop** control (two-step: click → "Confirm stop"). Event-driven state changes only — no spinner loops (AGENTS.md perf rule). Empty state: "No agents running".
4. **Usage**: per unique account (reuse `providerUsageAccounts.ts` de-dup semantics in the aggregator): provider icon, plan badge, bars per window (label + % left + reset countdown in local time), collapsed to the binding (lowest-remaining) window, expandable. Stale rows dimmed **with capture age** (never blank on transient failure); `needs-auth` rows say "Sign in via <provider> CLI".
5. **Mini composer [locked]**: text field + project picker defaulting to most recent project; submit launches the thread, it appears in Active; clicking it opens the main window (matches composer-launch behavior shipped in b2742a3). Full composer features stay in the app.
6. **Footer**: Refresh usage, Settings, Quit Pathway.

Interaction rules: everything one click deep, no sub-menus; countdown text updates at most once/min and only while the popover is open; popover height caps with internal scroll on threads.

## Tray icon [locked: glyph + attention badge]

- Template glyph; badge/count only when Attention Events are pending (mirrors and clears with Focus Strip badge semantics).
- Dimmed variant when all environments disconnected or usage universally stale. Never red-alarm for transient fetch failures.
- No always-on percent text in v1 (revisit as an opt-in setting later).

## Refresh policy

- Usage: push-first (`subscribeProviderUsage` from audit step 3). Pull fallback: 2 min while popover open, 5 min while any thread is running, 15–30 min idle; opportunistic refresh on popover open if >60 s old and just after a window's `resetsAt` passes; honor per-token Retry-After; back off on Low Power Mode.
- Threads/attention: already event-driven over existing WS.
- Aggregator pushes snapshot diffs to the helper only when content changes; helper renders exactly what it's told.

## Settings (Settings → Desktop, new section)

- Show menu bar item (default on, macOS).
- Keep running in menu bar when window closes (default **on** [locked]).
- Section toggles (usage / threads / attention).

## Surfaces checklist (AGENTS.md)

- Entry points: tray popover; all deep links land on existing main-window routes.
- Clients: helper is macOS desktop-only by nature; aggregator + contract are platform-neutral for the later Win/Linux Electron tray. Web/mobile unaffected.
- Providers: usage rows render whatever contract v2 delivers; per-provider logic stays in server drivers.
- Contracts: `TraySnapshot` + tray commands in `packages/contracts`; `subscribeProviderUsage` WS method per audit plan.
- Reverse states: tray hidable; keep-alive opt-out; every action available in-app too; snooze↔unsnooze parity via existing commands.
- Connection modes: aggregator spans local/relay/tunnel connections; disconnected environments render reconnect state, not blank.

## Build plan [locked in grill]

Staged, reviewed between stages; commits land on the working branch as conventional commits; each stage ends in a **draft PR** with before/after media; agents may run the app (dev server, Swift build, screenshots/video) for verification.

- **Stage A — metering remediation** (`provider-usage-metering-audit.md`: P0 fixes, contract v2, push pipeline, **plus all hygiene items** [locked]). Codex gpt-5.6-sol agents, high reasoning. Independently shippable.
- **Stage B — tray backbone**: TraySnapshot contract, Electron aggregator (client-runtime in main process), local socket + handoff, helper supervision, headless lifecycle, settings. Codex gpt-5.6-sol, high.
- **Stage C — Swift helper UI**: MenuBarExtra app, popover sections, mini composer, tray icon states; plus any web usage-bar UI adjustments from contract v2. Opus 5. Can start against fixture snapshots in parallel with B.
- Orchestration, review gates, and integration: Fable 5.
