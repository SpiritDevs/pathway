export const COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX = 780;
export const COMPOSER_PRIMARY_ACTIONS_COMPACT_BREAKPOINT_PX =
  COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX;

export interface ComposerFooterFit {
  readonly compact: boolean;
  // The composer width the full controls needed when they last overflowed.
  readonly fullWidth: number;
}

// Collapses the footer controls only once they overflow, and expands them again
// once the composer is as wide as they needed. `overflow` is measured on the full
// controls, so it is ignored while compact.
export function resolveComposerFooterFit(
  previous: ComposerFooterFit,
  composerWidth: number,
  overflow: number,
): ComposerFooterFit {
  if (previous.compact) {
    return composerWidth >= previous.fullWidth ? { compact: false, fullWidth: 0 } : previous;
  }
  return overflow > 0 ? { compact: true, fullWidth: composerWidth + overflow } : previous;
}

export function shouldUseCompactComposerPrimaryActions(
  width: number | null,
  options?: { hasWideActions?: boolean },
): boolean {
  if (!options?.hasWideActions) {
    return false;
  }
  return width !== null && width < COMPOSER_PRIMARY_ACTIONS_COMPACT_BREAKPOINT_PX;
}
