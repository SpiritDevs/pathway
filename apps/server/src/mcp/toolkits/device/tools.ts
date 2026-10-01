import { ProjectionStoreV2 } from "../../../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import {
  DeviceInputInput,
  DeviceActionInput,
  DeviceDetail,
  DeviceToolCloseInput,
  DeviceToolError,
  DeviceToolListResult,
  DeviceToolOpenInput,
  DeviceToolOpenResult,
  DeviceToolScreenshotResult,
  DeviceToolTargetInput,
} from "@spiritdevs/contracts";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ServerConfig } from "../../../config.ts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as DeviceService from "../../../device/DeviceService.ts";

const dependencies = [
  ServerSettings.ServerSettingsService,
  McpInvocationContext.McpInvocationContext,
  DeviceService.DeviceService,
];

/** Shared lifecycle tools plus native controls for families the CLI cannot fully drive. */
const DeviceListTool = Tool.make("device_list", {
  description:
    "List iPhone, iPad, Apple Watch, Apple TV simulators and Android emulators on this environment's device hosts, which platforms each host can run, and which devices are already open in this thread's Device panel. Call this before device_open when you do not know a device id.",
  // An empty struct serializes as `anyOf [object, array]`, which some
  // providers reject and then drop every tool on the server with it.
  parameters: Schema.Struct({
    hostId: Schema.optional(
      Schema.String.annotate({ description: "Limit to one device host. Defaults to all hosts." }),
    ),
  }),
  success: DeviceToolListResult,
  failure: DeviceToolError,
  dependencies,
})
  .annotate(Tool.Title, "List devices")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const DeviceOpenTool = Tool.make("device_open", {
  description:
    "Open a simulator or emulator for this thread: boots it if needed, starts its live stream, and shows it in the user's Device panel so they can watch. Returns the agent-device CLI invocation pinned to the device; drive the device with that CLI afterwards.",
  parameters: DeviceToolOpenInput,
  success: DeviceToolOpenResult,
  failure: DeviceToolError,
  dependencies: [
    ...dependencies,
    ProjectionStoreV2,
    FileSystem.FileSystem,
    Path.Path,
    ServerConfig,
  ],
})
  .annotate(Tool.Title, "Open device")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const DeviceScreenshotTool = Tool.make("device_screenshot", {
  description:
    "Capture the current screen of an open device as a PNG image. Use it to see what the user sees; for taps and text use the agent-device CLI.",
  parameters: DeviceToolTargetInput,
  success: DeviceToolScreenshotResult,
  failure: DeviceToolError,
  dependencies,
})
  .annotate(Tool.Title, "Screenshot device")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const DeviceCloseTool = Tool.make("device_close", {
  description:
    "Remove a device from this thread's Device panel. Pass shutdown=true to also power the simulator or emulator off.",
  parameters: DeviceToolCloseInput,
  success: Schema.Record(Schema.String, Schema.Never).annotate({
    description: "The device was closed.",
  }),
  failure: DeviceToolError,
  dependencies: [...dependencies, ProjectionStoreV2],
})
  .annotate(Tool.Title, "Close device")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const DeviceInputTool = Tool.make("device_input", {
  description:
    "Send touch, Digital Crown rotation, Watch buttons or Siri Remote buttons to an open simulator on the selected environment. TV uses buttons, never touches. Coordinates are normalized 0..1.",
  parameters: DeviceInputInput,
  success: Schema.Struct({ ok: Schema.Boolean }),
  failure: DeviceToolError,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

const DeviceActionTool = Tool.make("device_action", {
  description:
    "Run a typed device action on the selected environment, including Watch pair/unpair and app launch/terminate. Pairing requires an explicit same-host iPhone simulator id. Does not boot the companion.",
  parameters: DeviceActionInput,
  success: DeviceDetail,
  failure: DeviceToolError,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

export const DeviceStandardToolkit = Toolkit.make(
  DeviceListTool,
  DeviceOpenTool,
  DeviceCloseTool,
  DeviceInputTool,
  DeviceActionTool,
);

export const DeviceScreenshotToolkit = Toolkit.make(DeviceScreenshotTool);

export const DeviceToolkit = Toolkit.make(
  DeviceListTool,
  DeviceOpenTool,
  DeviceScreenshotTool,
  DeviceCloseTool,
  DeviceInputTool,
  DeviceActionTool,
);
