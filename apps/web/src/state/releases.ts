import { createReleaseEnvironmentAtoms } from "@spiritdevs/client-runtime/state/releases";

import { connectionAtomRuntime } from "../connection/runtime";

export const releaseEnvironment = createReleaseEnvironmentAtoms(connectionAtomRuntime);
