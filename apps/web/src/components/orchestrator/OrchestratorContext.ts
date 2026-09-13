import { createContext, useContext } from "react";
import type { OrchestratorState } from "./OrchestratorProvider";

export const OrchestratorContext = createContext<OrchestratorState | null>(null);
export function useOrchestrators() {
  const value = useContext(OrchestratorContext);
  if (!value) throw new Error("OrchestratorProvider is required.");
  return value;
}
export { useBusinessToolsQuery as useOrchestratorQuery } from "../contacts/businessToolsCloud";
