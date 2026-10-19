/**
 * ComputerService - the environment's Computer Use surface: whether this host
 * can ever drive a desktop, what the boot probe saw, and the manager.
 *
 * @module computer/Services/ComputerService
 */
import type { ComputerAvailability } from "@spiritdevs/contracts";
import * as Context from "effect/Context";

import type { ComputerManager } from "../ComputerManager.ts";

export interface ComputerServiceShape {
  /** The host could ever drive a desktop, not that it can right now. */
  readonly supported: boolean;
  /** The passive boot probe's verdict. */
  readonly availability: ComputerAvailability;
  readonly manager: ComputerManager;
}

export class ComputerService extends Context.Service<ComputerService, ComputerServiceShape>()(
  "@spiritdevs/pathway/computer/Services/ComputerService",
) {}
