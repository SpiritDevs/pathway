import { createAppleEnvironmentAtoms } from "@spiritdevs/client-runtime/state/apple";

import { connectionAtomRuntime } from "../connection/runtime";

export const appleEnvironment = createAppleEnvironmentAtoms(connectionAtomRuntime);
