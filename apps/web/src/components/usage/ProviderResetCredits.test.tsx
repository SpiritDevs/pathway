import type { ReactElement } from "react";
import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@spiritdevs/contracts";
import * as Cause from "effect/Cause";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";
import type { ConnectedProviderUsageAccount } from "./providerUsageAccounts";

const state = vi.hoisted(() => ({ redeem: vi.fn(), toast: vi.fn() }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { ...actual, useState: reactHookHarness.useState, useRef: reactHookHarness.useRef };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("../../state/server", () => ({
  serverEnvironment: { consumeResetCredit: Symbol("redeem") },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.redeem }));
vi.mock("../../state/environments", () => ({ usePrimaryEnvironmentId: () => null }));
vi.mock("../../state/session", () => ({ useEnvironmentSessionState: vi.fn() }));
vi.mock("../../environments/primary", () => ({ usePrimarySessionState: vi.fn() }));
vi.mock("../ui/toast", () => ({
  stackedThreadToast: (input: unknown) => input,
  toastManager: { add: state.toast },
}));

import { ProviderResetCreditList, ProviderResetCredits } from "./ProviderResetCredits";

const account: ConnectedProviderUsageAccount = {
  key: "account-key",
  environmentId: EnvironmentId.make("remote-environment"),
  environmentLabel: "Work Mac",
  displayName: "Work Codex",
  receivedAt: 1,
  provider: {
    instanceId: ProviderInstanceId.make("work-codex"),
    driver: ProviderDriverKind.make("codex"),
    displayName: "Work Codex",
    enabled: true,
    installed: true,
    auth: { status: "authenticated", email: "work@example.test" },
  } as ConnectedProviderUsageAccount["provider"],
  snapshot: {
    provider: "codex",
    instanceId: ProviderInstanceId.make("work-codex"),
    accountKey: "pinned-account",
    status: "ok",
    source: "provider",
    updatedAt: "2026-09-08T00:00:00.000Z",
    limits: [],
    usageLines: [],
    resetCredits: {
      availableCount: 3,
      credits: [
        { id: "later", expiresAt: "2099-12-01T00:00:00.000Z" },
        { id: "expired", expiresAt: "2020-01-01T00:00:00.000Z" },
        { id: "sooner", expiresAt: "2099-11-01T00:00:00.000Z" },
      ],
    },
  },
};
function render(overrides: Partial<Parameters<typeof ProviderResetCreditList>[0]> = {}) {
  hooks.beginRender();
  return ProviderResetCreditList({
    account,
    operateAccess: "granted",
    ...overrides,
  }) as ReactElement<Record<string, unknown>>;
}
function button(tree: ReactElement<Record<string, unknown>>, label: string) {
  const found = visitElements(tree, (element) => element.props.children === label);
  expect(found).not.toBeNull();
  return found!;
}
function open(overrides: Partial<Parameters<typeof ProviderResetCreditList>[0]> = {}) {
  const tree = render(overrides);
  (button(tree, "Redeem").props.onClick as (event: unknown) => void)({
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  });
  return render(overrides);
}
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("provider reset credits", () => {
  beforeEach(() => {
    hooks.reset();
    state.redeem.mockReset();
    state.toast.mockReset();
  });

  it("shows each unexpired credit in expiry order and hides unsupported accounts", () => {
    const tree = render();
    expect(visitElements(tree, (element) => element.type === "time")?.props.dateTime).toBe(
      "2099-11-01T00:00:00.000Z",
    );
    expect(
      visitElements(tree, (element) => element.props.dateTime === "2020-01-01T00:00:00.000Z"),
    ).toBeNull();
    expect(ProviderResetCredits({ accounts: [{ ...account, snapshot: null }] })).toBeNull();
  });

  it.each(["pending", "denied"] as const)(
    "disables redemption for %s operate access",
    (operateAccess) => {
      expect(button(render({ operateAccess }), "Redeem").props.disabled).toBe(true);
    },
  );

  it("disables redemption for a stale snapshot", () => {
    expect(
      button(
        render({ account: { ...account, snapshot: { ...account.snapshot!, stale: true } } }),
        "Redeem",
      ).props.disabled,
    ).toBe(true);
  });

  it("disables stale credits even when usage meters are fresh", () => {
    expect(
      button(
        render({
          account: {
            ...account,
            snapshot: {
              ...account.snapshot!,
              resetCredits: { ...account.snapshot!.resetCredits!, stale: true },
            },
          },
        }),
        "Redeem",
      ).props.disabled,
    ).toBe(true);
  });

  it("requires confirmation and targets the credit's environment, instance and account", async () => {
    state.redeem.mockResolvedValue({ _tag: "Success", value: { outcome: "reset" } });
    const confirmation = open();
    expect(state.redeem).not.toHaveBeenCalled();
    (button(confirmation, "Redeem reset").props.onClick as () => void)();
    await flush();
    expect(state.redeem).toHaveBeenCalledExactlyOnceWith({
      environmentId: account.environmentId,
      input: {
        instanceId: account.provider.instanceId,
        accountKey: "pinned-account",
        creditId: "sooner",
      },
    });
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: "Usage reset redeemed" }),
    );
  });

  it("allows cancel without consuming a credit", () => {
    const confirmation = open();
    const dialog = visitElements(confirmation, (element) => element.props.open === true)!;
    (dialog.props.onOpenChange as (open: boolean) => void)(false);
    expect(visitElements(render(), (element) => element.props.open === true)).toBeNull();
    expect(state.redeem).not.toHaveBeenCalled();
  });

  it("prevents repeat submission and dialog dismissal while a reset is pending", async () => {
    let resolve!: (result: unknown) => void;
    state.redeem.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const confirmation = open();
    const submit = button(confirmation, "Redeem reset").props.onClick as () => void;
    submit();
    submit();
    expect(state.redeem).toHaveBeenCalledTimes(1);
    const pending = render();
    expect(button(pending, "Redeeming…").props.disabled).toBe(true);
    const dialog = visitElements(pending, (element) => element.props.open === true)!;
    (dialog.props.onOpenChange as (open: boolean) => void)(false);
    expect(visitElements(render(), (element) => element.props.open === true)).not.toBeNull();
    resolve({ _tag: "Success", value: { outcome: "reset" } });
    await flush();
  });

  it("keeps failed redemption open with an error and no success claim", async () => {
    state.redeem.mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail(new Error("Connection lost")),
    });
    (button(open(), "Redeem reset").props.onClick as () => void)();
    await flush();
    expect(
      visitElements(render(), (element) => element.props.role === "alert")?.props.children,
    ).toBe("Connection lost");
    expect(state.toast).not.toHaveBeenCalled();
  });

  it.each([
    ["nothingToReset", "Your usage does not need a reset"],
    ["noCredit", "This reset is no longer available"],
    ["alreadyRedeemed", "This reset has already been redeemed"],
  ])("reports %s without claiming a reset", async (outcome, title) => {
    state.redeem.mockResolvedValue({ _tag: "Success", value: { outcome } });
    (button(open(), "Redeem reset").props.onClick as () => void)();
    await flush();
    expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "info", title }));
  });

  it("hands the menu's selected account to a dialog host outside the menu without redeeming", () => {
    const onRequestRedeem = vi.fn();
    open({ onRequestRedeem });
    expect(onRequestRedeem).toHaveBeenCalledWith({ account, creditId: "sooner" });
    expect(state.redeem).not.toHaveBeenCalled();
    expect(
      visitElements(render({ onRequestRedeem }), (element) => element.props.open === true),
    ).toBeNull();
  });
  it("does not redeem a credit that expires while confirmation is open", async () => {
    const confirmation = open();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2100-01-01T00:00:00.000Z"));
    try {
      (button(confirmation, "Redeem reset").props.onClick as () => void)();
      await flush();
      expect(state.redeem).not.toHaveBeenCalled();
      expect(
        visitElements(render(), (element) => element.props.role === "alert")?.props.children,
      ).toContain("expired");
    } finally {
      clock.mockRestore();
    }
  });
});
