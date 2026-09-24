// The device-wide Computer control setting applies per environment: only where
// the environment can drive a desktop and this session may use it there. The
// hook is rendered for real; only its data sources are stubbed.

import {
  AuthAccessWriteScope,
  AuthComputerOperateScope,
  AuthOrchestrationOperateScope,
  EnvironmentId,
  type AuthEnvironmentScope,
  type ComputerAccessPolicy,
} from "@spiritdevs/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { resolveComputerControlForSend } from "./useComputerControlModeChange.logic";

const current = vi.hoisted(() => ({
  isElectron: false,
  primaryEnvironmentId: null as string | null,
  supported: true,
  computerControlEnabled: true,
  accessPolicy: "scoped" as ComputerAccessPolicy,
  session: undefined as
    | { authenticated: boolean; scopes?: ReadonlyArray<AuthEnvironmentScope> }
    | undefined,
}));

vi.mock("../env", () => ({
  get isElectron() {
    return current.isElectron;
  },
}));
vi.mock("../state/environments", () => ({
  usePrimaryEnvironmentId: () => current.primaryEnvironmentId,
}));
vi.mock("../environments/primary/sessionState", () => ({ primarySessionStateAtom: "primary" }));
vi.mock("../state/session", () => ({
  environmentSession: { sessionStateAtom: () => "remote" },
}));
vi.mock("./useComputerSupport", () => ({ useComputerSupport: () => current.supported }));
vi.mock("./useSettings", () => ({
  useEnvironmentSettings: (_environmentId: unknown, selector: (settings: unknown) => unknown) =>
    selector({
      computerControlEnabled: current.computerControlEnabled,
      computer: { accessPolicy: current.accessPolicy },
    }),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () =>
    current.session === undefined ? AsyncResult.initial() : AsyncResult.success(current.session),
}));

import { useComputerControlSetting } from "./useComputerAccess";

const REMOTE = EnvironmentId.make("environment-remote");
const PRIMARY = EnvironmentId.make("environment-primary");
const OPERATOR = [AuthOrchestrationOperateScope] as const;

function renderSetting(environmentId: EnvironmentId): boolean {
  let value: boolean | undefined;
  function Probe() {
    value = useComputerControlSetting(environmentId);
    return null;
  }
  renderToStaticMarkup(<Probe />);
  if (value === undefined) throw new Error("useComputerControlSetting did not render.");
  return value;
}

afterEach(() => {
  current.isElectron = false;
  current.primaryEnvironmentId = null;
  current.supported = true;
  current.computerControlEnabled = true;
  current.accessPolicy = "scoped";
  current.session = undefined;
});

describe("useComputerControlSetting", () => {
  it("drops the setting on an environment whose policy refuses this session", () => {
    current.session = { authenticated: true, scopes: OPERATOR };
    const setting = renderSetting(REMOTE);
    expect(setting).toBe(false);

    // An ordinary message carries no Computer intent, so the server accepts it.
    expect(
      resolveComputerControlForSend({
        messageText: "summarise the README",
        computerControlEnabled: setting,
        generation: 3,
      }).fields,
    ).toEqual({});
    // An explicit `/computer-use` still asks; the server's refusal is the answer.
    expect(
      resolveComputerControlForSend({
        messageText: "/computer-use open Notes",
        computerControlEnabled: setting,
        generation: 3,
      }),
    ).toEqual({ mode: "request", fields: { computerControlGeneration: 3 } });
  });

  it("follows the environment's access policy, not only the scoped rule", () => {
    current.session = { authenticated: true, scopes: [...OPERATOR, AuthComputerOperateScope] };
    expect(renderSetting(REMOTE)).toBe(true);
    current.accessPolicy = "admins-only";
    expect(renderSetting(REMOTE)).toBe(false);
    current.session = { authenticated: true, scopes: OPERATOR };
    current.accessPolicy = "any-operator";
    expect(renderSetting(REMOTE)).toBe(true);
    current.accessPolicy = "admins-only";
    current.session = { authenticated: true, scopes: [...OPERATOR, AuthAccessWriteScope] };
    expect(renderSetting(REMOTE)).toBe(true);
  });

  it("drops the setting where the environment cannot drive a desktop", () => {
    current.session = { authenticated: true, scopes: [...OPERATOR, AuthComputerOperateScope] };
    current.supported = false;
    expect(renderSetting(REMOTE)).toBe(false);
  });

  it("stays off when the setting is off", () => {
    current.computerControlEnabled = false;
    current.session = { authenticated: true, scopes: [...OPERATOR, AuthAccessWriteScope] };
    expect(renderSetting(REMOTE)).toBe(false);
  });

  it("keeps the setting while scopes are unknown, and on the desktop's own server", () => {
    expect(renderSetting(REMOTE)).toBe(true);
    current.session = { authenticated: true };
    expect(renderSetting(REMOTE)).toBe(true);

    current.isElectron = true;
    current.primaryEnvironmentId = PRIMARY;
    current.session = { authenticated: true, scopes: OPERATOR };
    expect(renderSetting(PRIMARY)).toBe(true);
    // A browser on the same primary server is held to its session's scopes.
    current.isElectron = false;
    expect(renderSetting(PRIMARY)).toBe(false);
  });
});
