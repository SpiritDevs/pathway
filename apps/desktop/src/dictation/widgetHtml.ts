// @effect-diagnostics globalDate:off globalTimers:off - This script runs in the isolated overlay without an Effect runtime.
import type {
  DictationBridge,
  DictationCommand,
  DictationHistoryEntry,
  DictationState,
} from "@spiritdevs/contracts/dictation";

/** This function is serialized into the isolated overlay. Keep all runtime dependencies inside it. */
function mountDictationOverlay() {
  const bridge = (
    window as unknown as {
      dictationOverlay: DictationBridge & {
        resize(width: number, height: number): void;
        hide(): void;
      };
    }
  ).dictationOverlay;
  const root = document.getElementById("widget")!;
  let state: DictationState | null = null;
  let recentOpen = false;
  let recent: readonly DictationHistoryEntry[] = [];
  let recentLoading = false;
  let recentError: string | null = null;
  let actionError: string | null = null;
  let copied: string | null = null;
  let signature = "";
  let historyRequest = 0;
  let revision = 0;
  let active = true;
  let preferredSize = "";
  let resultHovered = false;
  let resultFocused = false;
  let dismissTimer: ReturnType<typeof setInterval> | undefined;
  let dismissRemaining = 0;
  let dismissDuration = 5000;
  let dismissTick = 0;
  let dismissAfterCopy = false;
  function stopDismissTimer() {
    clearInterval(dismissTimer);
    dismissTimer = undefined;
  }
  function updateDismissRing() {
    const ring = document.getElementById("dismiss-ring");
    ring?.setAttribute("stroke-dashoffset", String(100 * (1 - dismissRemaining / dismissDuration)));
  }
  function startDismissTimer(duration: number, afterCopy = false) {
    stopDismissTimer();
    dismissDuration = duration;
    dismissRemaining = duration;
    dismissAfterCopy = afterCopy;
    dismissTick = Date.now();
    updateDismissRing();
    dismissTimer = setInterval(() => {
      const now = Date.now();
      if (dismissAfterCopy || (!resultHovered && !resultFocused)) {
        dismissRemaining = Math.max(0, dismissRemaining - (now - dismissTick));
        updateDismissRing();
      }
      dismissTick = now;
      if (dismissRemaining === 0) {
        stopDismissTimer();
        void execute({ type: "dismiss" });
      }
    }, 100);
  }
  const icons: Record<string, string> = {
    mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/>',
    settings:
      '<path d="M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z"/><circle cx="12" cy="12" r="3"/>',
    history: '<path d="M3 11a9 9 0 1 1 2 7M3 3v8h8M12 7v5l3 2"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V6a4 4 0 0 1 8 0v4"/>',
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  };
  function icon(name: string) {
    const span = document.createElement("span");
    span.className = "icon";
    span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] ?? ""}</svg>`;
    return span;
  }
  function element(tag: string, className = "", text?: string) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function size(width: number, height: number) {
    const next = `${width}:${height}`;
    if (next === preferredSize) return;
    preferredSize = next;
    bridge.resize?.(width, height);
  }
  function updateIdle() {
    const pill = root.querySelector<HTMLElement>(".idle");
    const handle = root.querySelector<HTMLButtonElement>(".idle-handle");
    const controls = root.querySelector<HTMLElement>(".idle-controls");
    if (!pill || !handle || !controls) return;
    const expanded = resultHovered || resultFocused;
    const handleFocused = document.activeElement === handle;
    pill.className = expanded ? "pill idle" : "pill idle compact";
    handle.setAttribute("aria-expanded", String(expanded));
    controls.hidden = !expanded;
    if (expanded && handleFocused) controls.querySelector<HTMLButtonElement>("button")?.focus();
    handle.hidden = expanded;
    size(expanded ? 296 : 80, expanded ? 72 : 32);
  }
  async function execute(command: DictationCommand) {
    actionError = null;
    const startedAt = revision;
    try {
      const next = await bridge.execute(command);
      if (!active) return false;
      if (startedAt === revision) receive(next);
      return true;
    } catch (error) {
      if (!active) return false;
      actionError = error instanceof Error ? error.message : String(error);
      render(true);
      return false;
    }
  }
  function button(
    label: string,
    iconName: string,
    action: () => void,
    className = "",
    iconOnly = false,
  ) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = className;
    node.setAttribute("aria-label", label);
    node.title = label;
    node.append(icon(iconName));
    if (!iconOnly) node.append(element("span", "", label));
    node.addEventListener("pointerdown", (event) => event.preventDefault());
    node.addEventListener("click", action);
    return node;
  }
  async function loadRecent() {
    const request = ++historyRequest;
    recentLoading = true;
    render(true);
    try {
      const entries = await bridge.listHistory();
      if (!active || !recentOpen || request !== historyRequest) return;
      recent = entries.slice(0, 5);
      recentError = null;
    } catch (error) {
      if (!active || !recentOpen || request !== historyRequest) return;
      recentError = error instanceof Error ? error.message : String(error);
    }
    recentLoading = false;
    render(true);
  }
  function closeRecent() {
    recentOpen = false;
    historyRequest++;
    render(true);
  }
  function addError(parent: HTMLElement, message: string) {
    const node = element("p", "error", message);
    node.setAttribute("role", "alert");
    parent.append(node);
  }
  async function copy(text: string, id: string) {
    if (await execute({ type: "copy", text })) {
      copied = id;
      if (state?.phase === "result" && state.result?.id === id && !recentOpen)
        startDismissTimer(3000, true);
      render(true);
    }
  }
  function renderRecent() {
    const panel = element("section", "panel recent");
    panel.setAttribute("aria-label", "Recent dictations");
    const header = element("div", "panel-header");
    header.append(
      element("h2", "", "Recent dictations"),
      button("Close recent dictations", "close", closeRecent, "round", true),
    );
    panel.append(header);
    if (recentError) addError(panel, recentError);
    if (recentLoading && !recent.length) panel.append(element("p", "empty", "Loading history…"));
    else if (!recent.length)
      panel.append(element("p", "empty", "Your saved dictations will appear here."));
    for (const entry of recent) {
      const row = element("div", "recent-row");
      const content = element("div", "recent-content");
      content.append(
        element("p", "recent-text", entry.text),
        element(
          "span",
          "meta",
          new Date(entry.createdAt).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          }),
        ),
      );
      row.append(
        content,
        button(
          copied === entry.id ? "Copied" : "Copy dictation",
          copied === entry.id ? "check" : "copy",
          () => void copy(entry.text, entry.id),
          "round",
          true,
        ),
      );
      panel.append(row);
    }
    const footer = element("div", "panel-footer");
    footer.append(
      button(
        "View all history",
        "arrow",
        () => {
          closeRecent();
          void execute({ type: "open", page: "history" });
        },
        "subtle",
      ),
    );
    panel.append(footer);
    root.append(panel);
    size(408, Math.min(572, 190 + recent.length * 72));
  }
  function renderResult(result: DictationHistoryEntry) {
    const panel = element("section", "panel result");
    panel.setAttribute("aria-label", "Dictation result");
    const header = element("div", "panel-header");
    const dismiss = button(
      "Dismiss result",
      "close",
      () => {
        stopDismissTimer();
        void execute({ type: "dismiss" });
      },
      "round dismiss",
      true,
    );
    const countdown = element("span", "dismiss-countdown");
    countdown.innerHTML =
      '<svg viewBox="0 0 32 32" aria-hidden="true"><circle id="dismiss-ring" cx="16" cy="16" r="14" pathLength="100" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="100" transform="rotate(-90 16 16)"/></svg>';
    dismiss.append(countdown);
    header.append(
      element(
        "h2",
        "",
        result.delivery === "unconfirmed"
          ? "Check your text field"
          : result.delivery === "inserted"
            ? "Dictation inserted"
            : result.delivery === "test"
              ? "Microphone test"
              : "Your dictation",
      ),
      dismiss,
    );
    panel.append(header);
    if (result.delivery === "unconfirmed")
      panel.append(
        element(
          "p",
          "description",
          "Insertion could not be confirmed. Check the field before copying to avoid a duplicate.",
        ),
      );
    if (result.delivery === "manual")
      panel.append(
        element("p", "description", "Your text is ready to copy. Your clipboard has not changed."),
      );
    panel.append(element("p", "transcript", result.text));
    if (result.cleanup === "unavailable")
      panel.append(element("p", "description", "Cleanup unavailable. Recognized text was kept."));
    if (
      state?.error &&
      !(result.cleanup === "unavailable" && state.error.startsWith("Cleanup unavailable"))
    )
      addError(panel, state.error);
    const footer = element("div", "panel-footer");
    footer.append(
      button(
        copied === result.id ? "Copied" : "Copy text",
        copied === result.id ? "check" : "copy",
        () => void copy(result.text, result.id),
        "primary",
      ),
    );
    panel.append(footer);
    root.append(panel);
    updateDismissRing();
    size(424, Math.min(440, 224 + Math.ceil(result.text.length / 46) * 21));
  }
  function liveIndicators() {
    if (!state) return;
    const duration = document.getElementById("duration");
    if (duration) {
      const seconds = Math.floor(Math.max(0, state.durationMs) / 1000);
      const label =
        state.durationMs >= 270_000
          ? `${Math.max(0, 300 - seconds)}s left`
          : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
      if (duration.textContent !== label) duration.textContent = label;
    }
    const level = Math.round(Math.min(1, Math.max(0, state.level)) * 12);
    for (const [index, bar] of Array.from(
      document.querySelectorAll<HTMLElement>(".wave-bar"),
    ).entries()) {
      const height = `${2 + Math.round(level * (0.5 + Math.sin(index * 2.1) * 0.45))}px`;
      if (bar.style.height !== height) bar.style.height = height;
    }
  }
  function render(force = false) {
    if (!state) return;
    const nextSignature = JSON.stringify([
      state.phase,
      state.mode,
      state.durationMs >= 270_000,
      state.result,
      state.error,
      state.authenticated,
      state.accountId,
      state.supported,
      state.preferences.enabled,
      state.preferences.showIdleBar,
      recentOpen,
      actionError,
    ]);
    if (!force && signature === nextSignature) {
      liveIndicators();
      return;
    }
    signature = nextSignature;
    root.replaceChildren();
    if (!state.authenticated || !state.supported || !state.preferences.enabled) {
      size(112, 48);
      return;
    }
    if (recentOpen) renderRecent();
    else if (state.phase === "result" && state.result) renderResult(state.result);
    else if (state.phase === "error" || actionError) {
      const panel = element("section", "panel failure");
      const header = element("div", "panel-header");
      header.append(
        element("h2", "", "Dictation needs attention"),
        button(
          "Dismiss error",
          "close",
          () => {
            actionError = null;
            void execute({ type: "dismiss" });
          },
          "round",
          true,
        ),
      );
      panel.append(header);
      addError(
        panel,
        actionError ?? state.error ?? "Could not transcribe this recording. Please try again.",
      );
      const footer = element("div", "panel-footer");
      footer.append(
        button(
          "Settings",
          "settings",
          () => void execute({ type: "open", page: "settings" }),
          "subtle",
        ),
        button(
          "Record again",
          "mic",
          () => void execute({ type: "start", mode: "locked" }),
          "primary",
        ),
      );
      panel.append(footer);
      root.append(panel);
      size(424, 234);
    } else if (state.phase === "recording" || state.phase === "starting") {
      const locked = state.mode !== "hold";
      const pill = element("div", "pill recording");
      if (locked)
        pill.append(
          button(
            "Cancel recording",
            "close",
            () => void execute({ type: "cancel" }),
            "round",
            true,
          ),
        );

      const wave = element("div", "wave");
      wave.setAttribute("aria-label", "Recording audio");
      for (let i = 0; i < (locked ? 17 : 13); i++) wave.append(element("i", "wave-bar"));
      pill.append(wave);
      const nearingLimit = state.durationMs >= 270_000;
      if (nearingLimit) {
        const time = element("span", "duration cutoff-reveal");
        time.id = "duration";
        pill.append(time);
      }
      if (locked)
        pill.append(
          button(
            "Accept recording",
            "check",
            () => void execute({ type: "stop" }),
            "round accept",
            true,
          ),
        );
      if (nearingLimit)
        root.append(
          element("div", "hint cutoff-reveal", "Approaching the five-minute recording limit"),
        );
      root.append(pill);
      size(nearingLimit ? 330 : locked ? 264 : 132, nearingLimit ? 70 : 48);
    } else if (state.phase === "processing") {
      const pill = element("div", "pill processing");
      pill.append(
        icon("mic"),
        element("span", "processing-label", "Transcribing…"),
        button("Cancel processing", "close", () => void execute({ type: "cancel" }), "round", true),
      );
      root.append(pill);
      size(264, 72);
    } else if (state.preferences.showIdleBar) {
      const pill = element("div", "pill idle");
      pill.setAttribute("aria-label", "Dictation controls");
      const handle = document.createElement("button");
      handle.type = "button";
      handle.className = "idle-handle";
      handle.setAttribute("aria-label", "Show dictation controls");
      handle.setAttribute("aria-controls", "idle-controls");
      const controls = element("div", "idle-controls");
      controls.id = "idle-controls";
      controls.append(
        button("Record", "mic", () => void execute({ type: "start", mode: "locked" })),
        element("span", "divider"),
        button(
          "Settings",
          "settings",
          () => void execute({ type: "open", page: "settings" }),
          "idle-action",
          true,
        ),
        button(
          "History",
          "history",
          () => {
            recentOpen = true;
            void loadRecent();
          },
          "idle-action",
          true,
        ),
      );
      controls.append(
        button("Hide dictation bar", "close", () => bridge.hide(), "idle-action", true),
      );
      pill.append(handle, controls);
      root.append(pill);
      updateIdle();
    } else size(112, 48);
    if (actionError && (recentOpen || state.phase === "result")) {
      const panel = root.querySelector<HTMLElement>(".panel");
      if (panel) addError(panel, actionError);
    }
    liveIndicators();
  }
  function receive(next: DictationState) {
    const accountChanged = state?.accountId !== next.accountId || !next.authenticated;
    const resultChanged = state?.phase !== next.phase || state?.result?.id !== next.result?.id;
    state = next;
    if (accountChanged || resultChanged) {
      stopDismissTimer();
      copied = null;
      if (next.phase === "result" && next.result && next.authenticated && next.preferences.enabled)
        startDismissTimer(5000);
    }
    if (!next.preferences.enabled) stopDismissTimer();
    revision++;
    if (accountChanged) {
      recent = [];
      copied = null;
      recentOpen = false;
      resultHovered = false;
      resultFocused = false;
      historyRequest++;
    }
    if (["starting", "recording", "processing"].includes(next.phase)) recentOpen = false;
    render();
    if (recentOpen) void loadRecent();
  }
  const unsubscribe = bridge.onState(receive);
  const initialRevision = revision;
  void bridge
    .getState()
    .then((next) => {
      if (active && revision === initialRevision) receive(next);
    })
    .catch((error: unknown) => {
      if (!active) return;
      const panel = element("section", "panel failure");
      addError(panel, error instanceof Error ? error.message : "Could not connect to dictation.");
      root.append(panel);
      size(424, 150);
    });
  root.addEventListener("pointerenter", () => {
    resultHovered = true;
    updateIdle();
  });
  root.addEventListener("pointerleave", () => {
    resultHovered = false;
    updateIdle();
  });
  root.addEventListener("focusout", (event) => {
    if (root.contains(event.relatedTarget as Node | null)) return;
    resultFocused = false;
    updateIdle();
  });
  root.addEventListener("focusin", () => {
    resultFocused = true;
    updateIdle();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    if (recentOpen) closeRecent();
    else
      void execute({
        type:
          state && ["starting", "recording", "processing"].includes(state.phase)
            ? "cancel"
            : "dismiss",
      });
  });
  window.addEventListener(
    "unload",
    () => {
      active = false;
      stopDismissTimer();
      historyRequest++;
      unsubscribe();
    },
    { once: true },
  );
}

export function createDictationWidgetHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pathway dictation</title>
<style>
*{box-sizing:border-box}[hidden]{display:none!important}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;color:#f5f5f6;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body{display:flex;align-items:flex-end;justify-content:center;padding:12px}button{font:inherit;color:inherit;border:0;cursor:pointer;background:transparent;display:inline-flex;align-items:center;justify-content:center;gap:7px;border-radius:20px;padding:8px 10px;white-space:nowrap;-webkit-app-region:no-drag}button:hover{background:#29292d}button:focus-visible{outline:2px solid #c1b5fc;outline-offset:2px}button:disabled{opacity:.4;pointer-events:none}h2,p{margin:0}#widget{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:9px;max-width:100%;max-height:100%}.icon{display:inline-flex;width:16px;height:16px;flex-shrink:0}.icon svg{width:100%;height:100%}.pill{display:flex;align-items:center;justify-content:center;gap:10px;background:#101012;border:1px solid #323236;border-radius:99px;box-shadow:0 4px 12px #0005;flex-shrink:0;min-height:44px;padding:5px 8px}.idle{height:48px;width:272px;padding:5px 8px;gap:6px}.idle-controls{display:flex;align-items:center;gap:6px}.idle button{height:36px;font-size:12px}.idle.compact{width:44px;height:8px;min-height:8px;padding:0;background:#10101266;border-color:#ffffff60;box-shadow:none}.idle .idle-handle{width:100%;height:100%;padding:0}.idle-action{width:36px;padding:8px;flex-shrink:0}.divider{height:18px;width:1px;background:#39393e;margin:0 3px}.round{height:29px;width:29px;padding:6px;flex-shrink:0}.recording{gap:10px;padding:1px 6px;min-height:24px;height:24px}.recording .round{height:20px;width:20px;padding:3px}.recording .icon{width:12px;height:12px}.recording .wave{height:14px}.dismiss{position:relative}.dismiss-countdown{position:absolute;inset:0;pointer-events:none}.dismiss-countdown svg{width:100%;height:100%}.cutoff-reveal{animation:cutoff-reveal .25s ease-out}@keyframes cutoff-reveal{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}.accept{background:#eeedf1;color:#141416}.accept:hover{background:#fff}.wave{height:26px;display:flex;align-items:center;justify-content:center;gap:3px;width:auto}.wave-bar{display:block;width:3px;height:4px;border-radius:3px;background:#eeeeef}.duration{font-size:11px;font-variant-numeric:tabular-nums;color:#aaaab3;min-width:30px}.hint{font-size:10px;letter-spacing:.01em;background:#131315;color:#c5c5cc;border:1px solid #34343a;padding:5px 10px;border-radius:12px}.processing{padding-left:16px;gap:12px}.processing-label{font-size:12px;color:#d4d4db;padding-right:6px}.panel{width:380px;max-width:100%;max-height:100%;background:#111113;border:1px solid #35353b;box-shadow:0 4px 12px #0005;border-radius:18px;overflow:hidden;display:flex;flex-direction:column}.result,.failure{width:396px}.panel-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 14px 8px 18px;flex-shrink:0}.panel h2{font-size:13px;font-weight:600;letter-spacing:-.1px}.panel .round{color:#a3a3ad}.description{font-size:11px;line-height:1.55;color:#a8a8b2;padding:0 18px 10px}.transcript{white-space:pre-wrap;overflow-wrap:anywhere;overflow-y:auto;padding:5px 18px 14px;font-size:14px;line-height:1.6;user-select:text;min-height:44px;flex:1}.panel-footer{padding:10px 14px;border-top:1px solid #29292f;display:flex;justify-content:flex-end;gap:7px;flex-shrink:0}.primary{background:#eae9ef;color:#131315;border-radius:9px;font-size:12px;padding:8px 12px}.primary:hover{background:#fff}.subtle{color:#c8c8d1;font-size:11px;border-radius:8px}.recent-row{display:flex;gap:14px;align-items:center;padding:12px 16px;border-top:1px solid #26262c;min-height:70px}.recent-content{min-width:0;flex:1}.recent-text{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:12px;line-height:1.45;color:#dedee5;overflow-wrap:anywhere}.meta{display:block;margin-top:5px;color:#83838f;font-size:10px}.empty{font-size:12px;line-height:1.6;color:#9999a5;padding:22px 18px}.error{color:#ffb0b5;font-size:12px;line-height:1.55;padding:8px 18px 16px;overflow-y:auto}.recent{overflow-y:auto}@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head><body><main id="widget" aria-label="Pathway dictation"></main><script>(${mountDictationOverlay.toString()})();</script></body></html>`;
}
