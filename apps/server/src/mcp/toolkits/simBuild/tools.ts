import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import {
  SimBuildDiscovery,
  SimBuildError,
  SimBuildJob,
  SimBuildOptions,
  SimBuildUpdate,
} from "@spiritdevs/contracts/simBuild";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { SimBuildService } from "../../../simBuild/SimBuildService.ts";
const dependencies = [Crypto.Crypto, McpInvocationContext, ServerSettingsService, SimBuildService];
const options = Schema.Struct({
  ...SimBuildOptions.fields,
  requestId: Schema.optional(Schema.String),
});
const job = Schema.Struct({ jobId: Schema.String });
const discover = Tool.make("device_build_discover", {
  description:
    "Discover Xcode projects/workspaces, schemes and targets in this thread's checkout, including the generated ios/ folder for Expo/React Native. Requires a Mac environment with Xcode selected. Runs xcodebuild -list.",
  parameters: Schema.Struct({ refresh: Schema.optional(Schema.Boolean) }),
  success: SimBuildDiscovery,
  failure: SimBuildError,
  dependencies,
}).annotate(Tool.Readonly, false);
const build = Tool.make("device_build", {
  description:
    "Start an iOS simulator build in this thread's environment. Choose an exact container and scheme from device_build_discover and a local simulator from device_list. Use device_build_wait for its completion receipt, or device_build_status for batched logs. Reuse requestId when retrying a request.",
  parameters: options,
  success: SimBuildJob,
  failure: SimBuildError,
  dependencies,
}).annotate(Tool.Readonly, false);
const run = Tool.make("device_run", {
  description:
    "Build, install and launch on a chosen local iOS simulator. Call device_open first so the user can watch. After device_build_wait reports running, use the existing agent-device snapshot/click/fill tools from device_open to test the UI. Release is the RN/Expo default; Debug needs Metro running separately.",
  parameters: options,
  success: SimBuildJob,
  failure: SimBuildError,
  dependencies,
}).annotate(Tool.Readonly, false);
const test = Tool.make("device_test", {
  description:
    "Run the selected Xcode scheme's automated tests using xcodebuild test on an exact local iOS simulator. Wait with device_build_wait. For exploratory tap-based tests, use device_run then the agent-device CLI returned by device_open.",
  parameters: options,
  success: SimBuildJob,
  failure: SimBuildError,
  dependencies,
}).annotate(Tool.Readonly, false);
const status = Tool.make("device_build_status", {
  description:
    "Read this thread's build job, durable phase receipts and bounded recent logs with file/line diagnostics.",
  parameters: job,
  success: SimBuildUpdate,
  failure: SimBuildError,
  dependencies,
}).annotate(Tool.Readonly, true);
const wait = Tool.make("device_build_wait", {
  description:
    "Wait for a build's terminal receipt and process drain without polling. Returns running for a launched app, completed for build/test, failed, or cancelled. Does not cancel a job when the MCP request ends.",
  parameters: job,
  success: SimBuildJob,
  failure: SimBuildError,
  dependencies,
}).annotate(Tool.Readonly, true);
const cancel = Tool.make("device_build_cancel", {
  description:
    "Cancel this thread's build and wait for its captured child process to close. Does not shut down the simulator or stop a previously launched app.",
  parameters: job,
  success: SimBuildJob,
  failure: SimBuildError,
  dependencies,
}).annotate(Tool.Readonly, false);
export const SimBuildToolkit = Toolkit.make(discover, build, run, test, status, wait, cancel);
