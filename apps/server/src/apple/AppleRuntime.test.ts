// @effect-diagnostics globalDate:off -- Tests drive lease expiry with fake time, not polling or sleeps.
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CompanyId } from "@spiritdevs/contracts/company";
import {
  AppleStatus,
  APPLE_WS_METHODS,
  AppleRpcs,
  type AppleEnvironmentHealth,
  type AppleIntegration,
  type AppleTarget,
} from "@spiritdevs/contracts/apple";
import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  WsRpcGroup,
} from "@spiritdevs/contracts";
import { AppStoreConnectClient, type AscHttp } from "@spiritdevs/backend/appStoreConnectApi";
import { AppleRuntime, type AppleBackend } from "./AppleRuntime.ts";
import { makeAppleRpcHandlers } from "./appleRpc.ts";
import { appleTestCredential } from "../../../../packages/backend/src/fixtures/appleTestKey.ts";
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeStatus = Schema.encodeSync(AppleStatus);
const NOW = 1_800_000_000_000;
const target: AppleTarget = {
  companyId: CompanyId.make("01990000-0000-7000-8000-000000000011"),
  accountId: "account",
  teamId: "APPLETEAM1",
};
function harness(http?: AscHttp) {
  let integration: AppleIntegration = {
    accountId: target.accountId,
    teamId: target.teamId,
    accountRevision: 1,
    connected: true,
    revision: 1,
    issuerId: appleTestCredential.issuerId,
    keyIdSuffix: "Y001",
    lastVerifiedAt: NOW,
  };
  let credential = appleTestCredential;
  let failure = false;
  const health = new Map<string, AppleEnvironmentHealth>();
  const clients: AppStoreConnectClient[] = [];
  const tokens: string[] = [];
  const runtimes: AppleRuntime[] = [];
  const credentials = vi.fn(async () => credential);
  const backendFor = (environmentId: string): AppleBackend => ({
    accountStatus: async () => ({}),
    status: async () => {
      if (failure) throw new Error(`Cloud transport ${credential.privateKey}`);
      return { integration, environments: [...health.values()] };
    },
    heartbeat: async () => {
      if (failure) throw new Error(`Cloud transport ${credential.privateKey}`);
      health.set(environmentId, {
        environmentId,
        leaseExpiresAt: Date.now() + 30_000,
        connected: integration.connected,
        revision: integration.revision,
        lastVerifiedAt: health.get(environmentId)?.lastVerifiedAt ?? null,
        error: health.get(environmentId)?.error ?? null,
      });
      return { integration, expiresAt: integration.connected ? Date.now() + 30_000 : null };
    },
    credential: credentials,
    health: async (_target, _accountRevision, current) => {
      health.set(environmentId, { ...current, leaseExpiresAt: Date.now() + 30_000 });
    },
  });
  const runtime = (environmentId: string) => {
    const backend = backendFor(environmentId);
    const result = new AppleRuntime({
      environmentId,
      backend,
      makeClient: (key) => {
        const client = new AppStoreConnectClient(key, async (url, init) => {
          tokens.push(new Headers(init?.headers).get("authorization")!);
          return http
            ? http(url, init)
            : new Response(
                JSON.stringify({
                  data: [
                    {
                      id: `app-${key.keyId}`,
                      attributes: {
                        name: "App",
                        bundleId: "com.example.app",
                        privateKey: key.privateKey,
                      },
                    },
                  ],
                }),
              );
        });
        vi.spyOn(client, "dispose");
        clients.push(client);
        return client;
      },
    });
    runtimes.push(result);
    return { result, backend };
  };
  return {
    runtime,
    credentials,
    clients,
    tokens,
    rotate() {
      credential = { ...appleTestCredential, keyId: "TESTKEY002" };
      integration = { ...integration, revision: integration.revision + 1, keyIdSuffix: "Y002" };
    },
    changeScope() {
      integration = { ...integration, accountRevision: integration.accountRevision + 1 };
    },
    revoke() {
      integration = { ...integration, revision: integration.revision + 1, connected: false };
    },
    failCloud() {
      failure = true;
    },
    dispose() {
      runtimes.forEach((r) => r.dispose());
    },
  };
}

describe("environment Apple runtime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());
  it("two environments drop old clients before their next use after rotation/revoke", async () => {
    const h = harness();
    const a = h.runtime("env-a").result,
      b = h.runtime("env-b").result;
    await Promise.all([a.listApps(target), b.listApps(target)]);
    expect(h.credentials).toHaveBeenCalledTimes(2);
    await a.listApps(target);
    expect(h.tokens).toHaveLength(2);
    h.rotate();
    await Promise.all([a.listApps(target), b.listApps(target)]);
    expect(h.clients[0]?.dispose).toHaveBeenCalledOnce();
    expect(h.clients[1]?.dispose).toHaveBeenCalledOnce();
    expect(h.credentials).toHaveBeenCalledTimes(4);
    const keyIds = h.tokens.map(
      (token) =>
        JSON.parse(Buffer.from(token.replace("Bearer ", "").split(".")[0]!, "base64url").toString())
          .kid,
    );
    expect(keyIds).toEqual(["TESTKEY001", "TESTKEY001", "TESTKEY002", "TESTKEY002"]);
    h.revoke();
    await expect(a.listApps(target)).rejects.toMatchObject({ code: "not-connected" });
    await expect(b.listApps(target)).rejects.toMatchObject({ code: "not-connected" });
    expect(h.clients[2]?.dispose).toHaveBeenCalledOnce();
    expect(h.clients[3]?.dispose).toHaveBeenCalledOnce();
    h.dispose();
  });
  it("drops idle keys on lease expiry without any network polling", async () => {
    const h = harness();
    const runtime = h.runtime("env").result;
    await runtime.listApps(target);
    expect(h.clients).toHaveLength(1);
    vi.advanceTimersByTime(30_001);
    expect(h.clients[0]?.dispose).toHaveBeenCalledOnce();
    expect(h.tokens).toHaveLength(1);
    await runtime.listApps(target);
    expect(h.credentials).toHaveBeenCalledTimes(2);
    h.dispose();
  });
  it("invalidates cached clients after an account scope change and fails closed on cloud loss", async () => {
    const h = harness();
    const runtime = h.runtime("env").result;
    await runtime.listApps(target);
    h.changeScope();
    await runtime.listApps(target);
    expect(h.clients[0]?.dispose).toHaveBeenCalledOnce();
    h.failCloud();
    const failure = await runtime.listApps(target).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "cloud-unavailable" });
    expect(JSON.stringify(failure)).not.toContain("PRIVATE KEY");
    expect(h.clients[1]?.dispose).toHaveBeenCalledOnce();
    expect(h.tokens).toHaveLength(2);
    h.dispose();
  });
  it("discards in-flight reads that overlap rotation", async () => {
    let release!: (response: Response) => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const h = harness(async () => {
      started();
      return await new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    const runtime = h.runtime("env").result;
    const read = runtime.listApps(target);
    await entered;
    h.rotate();
    release(new Response(JSON.stringify({ data: [] })));
    await expect(read).rejects.toMatchObject({ code: "credential-changed" });
    expect(h.clients[0]?.dispose).toHaveBeenCalledOnce();
    h.dispose();
  });
  it("reports failed verification, including Retry-After, and never returns input secrets", async () => {
    const h = harness(
      async () =>
        new Response(appleTestCredential.privateKey, {
          status: 429,
          headers: { "Retry-After": "17" },
        }),
    );
    const runtime = h.runtime("env").result;
    const status = await runtime.testConnection(target);
    expect(status.health.error).toMatchObject({ code: "rate-limited", retryAfterSeconds: 17 });
    const encoded = encodeStatus(status);
    for (const forbidden of ["PRIVATE KEY", "TESTKEY001", "Bearer", "ciphertext"])
      expect(JSON.stringify(encoded)).not.toContain(forbidden);
    h.dispose();
  });
  effectIt.effect(
    "registers all RPCs, blocks writes with read-only scopes, and leaves Apple ID/app creation explicitly stubbed",
    () =>
      Effect.gen(function* () {
        const h = harness();
        const { result: runtime, backend } = h.runtime("env");
        const read = makeAppleRpcHandlers(runtime, [AuthOrchestrationReadScope]);
        const write = makeAppleRpcHandlers(runtime, [
          AuthOrchestrationReadScope,
          AuthOrchestrationOperateScope,
        ]);
        expect([...WsRpcGroup.requests.keys()]).toEqual(
          expect.arrayContaining([...AppleRpcs.requests.keys()]),
        );
        // The actual typed handler boundary is also the serialization boundary used by all clients.
        const denied = yield* Effect.result(
          read[APPLE_WS_METHODS.registerBundleId]({
            ...target,
            name: "App",
            identifier: "com.example.app",
            platform: "IOS",
          }),
        );
        expect(denied).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "EnvironmentAuthorizationError" },
        });
        expect(h.credentials).not.toHaveBeenCalled();
        const account = vi.spyOn(backend, "accountStatus");
        const start = yield* Effect.result(
          write[APPLE_WS_METHODS.appleIdStart]({
            companyId: target.companyId,
            accountId: target.accountId,
            password: "password-must-not-be-kept",
          }),
        );
        expect(start).toMatchObject({ _tag: "Failure", failure: { code: "not-implemented" } });
        expect(encodeUnknownJson(start)).not.toContain("password-must-not-be-kept");
        expect(encodeUnknownJson(account.mock.calls)).not.toContain("password-must-not-be-kept");
        const create = yield* Effect.result(
          write[APPLE_WS_METHODS.createApp]({
            ...target,
            name: "App",
            bundleId: "com.example.app",
            sku: "sku",
            primaryLocale: "en-US",
            platforms: ["IOS"],
          }),
        );
        expect(create).toMatchObject({ _tag: "Failure", failure: { code: "not-implemented" } });
        h.dispose();
      }),
  );
});
