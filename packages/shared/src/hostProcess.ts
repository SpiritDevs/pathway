import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as NodeOS from "node:os";

export const HostProcessPlatform = Context.Reference<NodeJS.Platform>(
  "@spiritdevs/shared/hostProcess/HostProcessPlatform",
  {
    defaultValue: () => process.platform,
  },
);

export const HostProcessArchitecture = Context.Reference<NodeJS.Architecture>(
  "@spiritdevs/shared/hostProcess/HostProcessArchitecture",
  {
    defaultValue: () => process.arch,
  },
);

export const HostProcessHostname = Context.Reference<string>(
  "@spiritdevs/shared/hostProcess/HostProcessHostname",
  {
    defaultValue: () => NodeOS.hostname(),
  },
);

export const HostProcessEnvironment = Context.Reference<NodeJS.ProcessEnv>(
  "@spiritdevs/shared/hostProcess/HostProcessEnvironment",
  {
    defaultValue: () => process.env,
  },
);

export const HostProcessWorkingDirectory = Context.Reference<string>(
  "@spiritdevs/shared/hostProcess/HostProcessWorkingDirectory",
  {
    defaultValue: () => process.cwd(),
  },
);

export const HostProcessExecutablePath = Context.Reference<string>(
  "@spiritdevs/shared/hostProcess/HostProcessExecutablePath",
  {
    defaultValue: () => process.execPath,
  },
);

export const HostProcessArguments = Context.Reference<ReadonlyArray<string>>(
  "@spiritdevs/shared/hostProcess/HostProcessArguments",
  {
    defaultValue: () => process.argv,
  },
);

export const isHostWindows = Effect.map(HostProcessPlatform, (platform) => platform === "win32");
