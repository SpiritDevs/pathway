import { useState } from "react";

import { APP_LOADING_MESSAGES, type AppLoadingReason } from "./splashScreen.logic";

// The lift and the message fade are one timeline that starts on the first paint,
// in the boot shell in index.html, and is usually still running when React takes
// over. Mounting resumes it with a negative delay rather than replaying it, so
// the logo never drops back to the middle of the screen at the handoff. The
// classes are defined alongside that markup; keep these durations in sync with
// the animations there.
const LIFT_DURATION_MS = 520;
const MESSAGE_DELAY_MS = 220;
const MESSAGE_DURATION_MS = 300;
const TIMELINE_MS = Math.max(LIFT_DURATION_MS, MESSAGE_DELAY_MS + MESSAGE_DURATION_MS);

/**
 * The app's loading screen: the icon lifts, the reason it is loading reads below
 * it, and a spinner sits at the bottom. Every boot-blocking wait renders this,
 * so the icon the boot shell painted stays put until the app itself is ready.
 */
export function SplashScreen({ reason }: { readonly reason: AppLoadingReason }) {
  // Frozen per mount: recomputing this on the re-render that swaps the message
  // would shove the running animation forward.
  const [elapsedMs] = useState(() => Math.round(Math.min(performance.now(), TIMELINE_MS)));

  return (
    <div
      aria-label="Pathway splash screen"
      // The layout classes come from index.html so this frame and the boot shell
      // cannot drift; the canvas is Tailwind's because only React-side renders
      // have the real theme and the app's grain to match against.
      className="boot-shell surface-grain bg-background text-foreground"
    >
      <div className="boot-stack" style={{ animationDelay: `${-elapsedMs}ms` }}>
        <img alt="Pathway" className="boot-logo" src="/apple-touch-icon.png" />
        <p
          className="boot-message"
          role="status"
          style={{ animationDelay: `${MESSAGE_DELAY_MS - elapsedMs}ms` }}
        >
          {APP_LOADING_MESSAGES[reason]}
        </p>
      </div>
      <span aria-hidden="true" className="boot-spinner" />
    </div>
  );
}
