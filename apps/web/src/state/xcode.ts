import { createXcodeEnvironmentAtoms } from "@spiritdevs/client-runtime/state/xcode";

import { connectionAtomRuntime } from "../connection/runtime";

export const xcodeEnvironment = createXcodeEnvironmentAtoms(connectionAtomRuntime);
