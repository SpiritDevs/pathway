import { describe, expect, it } from "vite-plus/test";

import {
  COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX,
  COMPOSER_PRIMARY_ACTIONS_COMPACT_BREAKPOINT_PX,
  resolveComposerFooterFit,
  shouldUseCompactComposerPrimaryActions,
} from "./composerFooterLayout";

describe("resolveComposerFooterFit", () => {
  const full = { compact: false, fullWidth: 0 };

  it("stays expanded while the controls fit, however narrow", () => {
    expect(resolveComposerFooterFit(full, 420, 0)).toBe(full);
  });

  it("collapses once the controls overflow and expands when that width returns", () => {
    const compact = resolveComposerFooterFit(full, 500, 36);
    expect(compact).toEqual({ compact: true, fullWidth: 536 });
    expect(resolveComposerFooterFit(compact, 535, 0)).toBe(compact);
    expect(resolveComposerFooterFit(compact, 536, 0)).toEqual(full);
  });
});

describe("shouldUseCompactComposerPrimaryActions", () => {
  it("matches the wide footer breakpoint", () => {
    expect(COMPOSER_PRIMARY_ACTIONS_COMPACT_BREAKPOINT_PX).toBe(
      COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX,
    );
    expect(
      shouldUseCompactComposerPrimaryActions(COMPOSER_PRIMARY_ACTIONS_COMPACT_BREAKPOINT_PX - 1, {
        hasWideActions: true,
      }),
    ).toBe(true);
    expect(
      shouldUseCompactComposerPrimaryActions(COMPOSER_PRIMARY_ACTIONS_COMPACT_BREAKPOINT_PX, {
        hasWideActions: true,
      }),
    ).toBe(false);
  });
});
