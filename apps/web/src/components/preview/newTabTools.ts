import type { LucideIcon } from "lucide-react";
import { createContext, useContext } from "react";

/** A surface the right panel can open, as offered by its empty state and new tabs. */
export interface PanelSurfaceAction {
  readonly kind: string;
  readonly label: string;
  readonly description: string;
  readonly icon: LucideIcon;
  readonly available: boolean;
  readonly disabledReason: string;
  readonly badgeCount: number;
  readonly onClick: () => void;
}

const NewTabToolsContext = createContext<ReadonlyArray<PanelSurfaceAction>>([]);

/**
 * Provided by the right panel with only the tools that can open now; a blank browser tab offers
 * these and turns into the one picked.
 */
export const NewTabToolsProvider = NewTabToolsContext.Provider;

export function useNewTabTools(): ReadonlyArray<PanelSurfaceAction> {
  return useContext(NewTabToolsContext);
}
