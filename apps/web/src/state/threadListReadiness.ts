import { Atom } from "effect/unstable/reactivity";
import { ALL_FOCUS_ID, CONVERSATIONS_FOCUS_ID } from "@spiritdevs/client-runtime/state/focuses";
import { activeFocusIdAtom, focusReadModelReadinessAtom } from "../cloud/focusReadModel";
import { companyThreadReadinessAtom, type ThreadListReadiness } from "../cloud/companyReadiness";
import { allEnvironmentShellsBootstrappedAtom } from "./shell";

export const threadListReadinessAtom = Atom.make((get): ThreadListReadiness => {
  const company = get(companyThreadReadinessAtom);
  if (company !== "ready") return company;
  const focus = get(activeFocusIdAtom);
  if (focus !== ALL_FOCUS_ID && focus !== CONVERSATIONS_FOCUS_ID) {
    const readiness = get(focusReadModelReadinessAtom);
    if (readiness !== "ready") return readiness;
  }
  return get(allEnvironmentShellsBootstrappedAtom) ? "ready" : "loading";
});
