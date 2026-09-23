import {
  PATHWAY_CUA_DESKTOP_IDENTITY,
  type PathwayDesktopFlavor,
} from "@spiritdevs/shared/desktopFlavor";
import { fromLenientJson } from "@spiritdevs/shared/schemaJson";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  DEFAULT_LINUX_PASSWORD_STORE,
  normalizeLinuxPasswordStorePreference,
  resolveLinuxPasswordStoreSwitch,
  type LinuxPasswordStoreSwitch,
  type LinuxPasswordStorePreference,
} from "../linuxSecretStorage.ts";
import {
  resolveDesktopBaseDir,
  resolveDesktopStateDir,
  resolveFlavorPathwayHome,
  type JoinPath,
} from "./DesktopStatePaths.ts";

interface EarlyDesktopSettingsInput {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly readFileString: (path: string) => string;
  readonly flavor?: PathwayDesktopFlavor | undefined;
}

type EarlyLinuxElectronOptionsInput = EarlyDesktopSettingsInput;

export interface EarlyLinuxElectronOptions {
  readonly isDevelopment: boolean;
  readonly scheme: string;
  readonly linuxWmClass: string;
  readonly linuxDesktopEntryName: string;
  readonly passwordStore: LinuxPasswordStoreSwitch | null;
}

export const resolveLinuxDesktopEntryName = (isDevelopment: boolean): string =>
  isDevelopment ? "com.spiritdevs.Pathway.Development.desktop" : "com.spiritdevs.Pathway.desktop";

/** OS-facing names for this process. The cua flavor wins over development so an isolated build never shares them. */
export function resolveDesktopRuntimeIdentity(input: {
  readonly isDevelopment: boolean;
  readonly flavor?: PathwayDesktopFlavor | undefined;
}) {
  if (input.flavor === "cua") {
    const cua = PATHWAY_CUA_DESKTOP_IDENTITY;
    return {
      flavor: "cua",
      displayName: cua.displayName as string | undefined,
      scheme: cua.scheme,
      defaultHomeDirName: cua.homeDirName,
      userDataDirName: cua.userDataDirName,
      legacyUserDataDirName: cua.userDataDirName,
      appUserModelId: cua.bundleId,
      linuxWmClass: cua.linuxExecutableName,
      linuxDesktopEntryName: cua.linuxDesktopEntryName,
    } as const;
  }
  const dev = input.isDevelopment;
  return {
    flavor: "production",
    displayName: undefined,
    scheme: dev ? "pathway-dev" : "pathway",
    defaultHomeDirName: ".pathway",
    userDataDirName: dev ? "pathway-dev" : "pathway",
    legacyUserDataDirName: dev ? "Pathway (Dev)" : "Pathway (Alpha)",
    appUserModelId: dev ? "com.spiritdevs.pathway.dev" : "com.spiritdevs.pathway",
    linuxWmClass: dev ? "pathway-dev" : "pathway",
    linuxDesktopEntryName: resolveLinuxDesktopEntryName(dev),
  } as const;
}

const trimNonEmpty = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
};

const EarlyDesktopSettingsJson = fromLenientJson(
  Schema.Struct({
    linuxPasswordStore: Schema.optionalKey(Schema.Unknown),
  }),
);
const decodeEarlyDesktopSettingsJson = Schema.decodeSync(EarlyDesktopSettingsJson);

const isDevelopmentEnvironment = (env: NodeJS.ProcessEnv): boolean =>
  trimNonEmpty(env.VITE_DEV_SERVER_URL) !== null;

function resolveEarlyDesktopSettingsPath(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly flavor?: PathwayDesktopFlavor | undefined;
}): string {
  const identity = resolveDesktopRuntimeIdentity({
    isDevelopment: isDevelopmentEnvironment(input.env),
    flavor: input.flavor,
  });
  const pathwayHome = resolveFlavorPathwayHome({
    homeDirectory: input.homeDirectory,
    joinPath: input.joinPath,
    pathwayHome: Option.fromUndefinedOr(input.env.PATHWAY_HOME),
    isolated: identity.flavor === "cua",
  });
  const baseDir = resolveDesktopBaseDir({
    homeDirectory: input.homeDirectory,
    joinPath: input.joinPath,
    pathwayHome,
    defaultHomeDirName: identity.defaultHomeDirName,
  });
  const stateDir = resolveDesktopStateDir({
    baseDir,
    isDevelopment: isDevelopmentEnvironment(input.env),
    joinPath: input.joinPath,
    pathwayHome,
  });
  return input.joinPath(stateDir, "desktop-settings.json");
}

export function resolveEarlyLinuxPasswordStorePreference(
  input: EarlyDesktopSettingsInput,
): LinuxPasswordStorePreference {
  const settingsPath = resolveEarlyDesktopSettingsPath(input);
  try {
    const parsed = decodeEarlyDesktopSettingsJson(input.readFileString(settingsPath));
    return normalizeLinuxPasswordStorePreference(parsed.linuxPasswordStore);
  } catch {
    return DEFAULT_LINUX_PASSWORD_STORE;
  }
}

export function resolveEarlyLinuxElectronOptions(
  input: EarlyLinuxElectronOptionsInput,
): EarlyLinuxElectronOptions {
  const preference = resolveEarlyLinuxPasswordStorePreference(input);
  const isDevelopment = isDevelopmentEnvironment(input.env);
  const identity = resolveDesktopRuntimeIdentity({ isDevelopment, flavor: input.flavor });
  return {
    isDevelopment,
    scheme: identity.scheme,
    linuxWmClass: identity.linuxWmClass,
    linuxDesktopEntryName: identity.linuxDesktopEntryName,
    passwordStore: resolveLinuxPasswordStoreSwitch({
      preference,
      env: input.env,
    }),
  };
}
