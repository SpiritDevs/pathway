import { createEnvironmentCatalogAtoms } from "@spiritdevs/client-runtime/state/connections";

import { connectionAtomRuntime } from "./runtime";

export const localEnvironmentCatalog = createEnvironmentCatalogAtoms(connectionAtomRuntime);

/** The app-level connection catalog is personal to this client and never follows company scope. */
export const environmentCatalog = localEnvironmentCatalog;
