import { createComputerEnvironmentAtoms } from "@spiritdevs/client-runtime/state/computer";

import { connectionAtomRuntime } from "../connection/runtime";

export const computerEnvironment = createComputerEnvironmentAtoms(connectionAtomRuntime);
