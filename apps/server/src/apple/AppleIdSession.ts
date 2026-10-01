// @effect-diagnostics globalDate:off globalTimers:off -- Shared runtime; bounded challenge expiry, injected clock.
import * as NodeCrypto from "node:crypto";
import { AppleError, type AppleIdSessionState } from "@spiritdevs/contracts/apple";
import type {
  AppleSessionBackend,
  AppleSessionTarget,
  AppleSessionMetadata,
  AppleSessionLease,
} from "@spiritdevs/backend/appleSession";
import {
  appleError,
  LiveAppleIdProtocol,
  type AppleAuthenticated,
  type AppleIdProtocol,
} from "./AppleIdProtocol.ts";
import * as Schema from "effect/Schema";

type State = typeof AppleIdSessionState.Type;
type Flow = {
  id: string;
  target: AppleSessionTarget;
  metadata: AppleSessionMetadata;
  protocol: AppleIdProtocol;
  controller: AbortController;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  busy: boolean;
};
const key = (target: AppleSessionTarget) => JSON.stringify([target.companyId, target.accountId]);
const isAppleError = Schema.is(AppleError);
const safe = (error: unknown) =>
  isAppleError(error) ? error : appleError("request-failed", "Apple sign-in failed. Try again.");
/** One per environment. Watchers receive only public states; codes and passwords never enter state. */
export class AppleIdSession {
  #flows = new Map<string, Flow>();
  #states = new Map<string, State>();
  #watchers = new Map<string, Set<(state: State) => void>>();
  #commits = new Map<string, Promise<unknown>>();
  #closed = false;
  readonly backend: AppleSessionBackend;
  readonly makeProtocol: () => AppleIdProtocol;
  readonly now: () => number;
  constructor(
    backend: AppleSessionBackend,
    makeProtocol: () => AppleIdProtocol = () => new LiveAppleIdProtocol(),
    now = Date.now,
  ) {
    this.backend = backend;
    this.makeProtocol = makeProtocol;
    this.now = now;
  }
  #publish(target: AppleSessionTarget, state: State) {
    if (JSON.stringify(this.#states.get(key(target))) === JSON.stringify(state)) return state;
    this.#states.set(key(target), state);
    for (const listener of this.#watchers.get(key(target)) ?? []) listener(state);
    return state;
  }
  #drop(target: AppleSessionTarget) {
    const flow = this.#flows.get(key(target));
    if (!flow) return;
    this.#flows.delete(key(target));
    clearTimeout(flow.timer);
    flow.controller.abort();
    flow.protocol.dispose();
  }
  #current(flow: Flow) {
    if (this.#closed || this.#flows.get(key(flow.target)) !== flow || flow.expiresAt <= this.now())
      throw appleError("credential-changed", "This Apple sign-in expired or was cancelled.");
    flow.controller.signal.throwIfAborted();
  }
  async #serial<A>(target: AppleSessionTarget, run: () => Promise<A>): Promise<A> {
    const id = key(target);
    const previous = this.#commits.get(id);
    const pending = Promise.resolve(previous)
      .catch(() => undefined)
      .then(run);
    this.#commits.set(id, pending);
    try {
      return await pending;
    } finally {
      if (this.#commits.get(id) === pending) this.#commits.delete(id);
    }
  }
  async status(target: AppleSessionTarget): Promise<State> {
    target = { companyId: target.companyId, accountId: target.accountId };
    return this.#serial(target, async () => {
      const meta = await this.backend.status(target);
      const flow = this.#flows.get(key(target));
      if (
        flow &&
        (meta.accountRevision !== flow.metadata.accountRevision ||
          meta.revision !== flow.metadata.revision ||
          flow.expiresAt <= this.now())
      ) {
        this.#drop(target);
        return this.#publish(target, { state: "expired" });
      }
      if (flow) return this.#states.get(key(target)) ?? { state: "signed-out" };
      if (meta.expiresAt !== null)
        return this.#publish(
          target,
          meta.expiresAt > this.now()
            ? { state: "authenticated", expiresAt: meta.expiresAt }
            : { state: "expired" },
        );
      const state = this.#states.get(key(target));
      return this.#publish(
        target,
        state?.state === "failed" || state?.state === "expired" ? state : { state: "signed-out" },
      );
    });
  }
  /** Subscribe before reading initial state so a concurrent challenge cannot be lost. */
  watch(target: AppleSessionTarget, listener: (state: State) => void): () => void {
    const id = key(target);
    const listeners = this.#watchers.get(id) ?? new Set();
    listeners.add(listener);
    this.#watchers.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.#watchers.delete(id);
    };
  }
  async #finish(flow: Flow, result: AppleAuthenticated): Promise<State> {
    return this.#serial(flow.target, async () => {
      this.#current(flow);
      const metadata = await this.backend.save(flow.target, {
        accountRevision: flow.metadata.accountRevision,
        revision: flow.metadata.revision,
        credential: result.credential,
        expiresAt: result.expiresAt,
        teams: result.teams,
      });
      try {
        this.#current(flow);
      } catch (error) {
        await this.backend.revoke(flow.target, metadata.revision).catch(() => undefined);
        throw error;
      }
      this.#drop(flow.target);
      return this.#publish(flow.target, { state: "authenticated", expiresAt: metadata.expiresAt! });
    });
  }
  async start(target: AppleSessionTarget, password: string): Promise<State> {
    target = { companyId: target.companyId, accountId: target.accountId };
    const metadata = await this.backend.status(target);
    if (this.#closed) throw appleError("request-failed", "The environment is stopping.");
    if (this.#flows.has(key(target)))
      throw appleError(
        "request-failed",
        "Apple sign-in is already in progress. Complete or cancel it first.",
      );
    const expiresAt = this.now() + 10 * 60_000;
    const flow: Flow = {
      id: NodeCrypto.randomUUID(),
      target: { companyId: target.companyId, accountId: target.accountId },
      metadata,
      protocol: this.makeProtocol(),
      controller: new AbortController(),
      expiresAt,
      busy: true,
      timer: setTimeout(() => {
        this.#drop(target);
        this.#publish(target, { state: "expired" });
      }, 10 * 60_000),
    };
    flow.timer.unref?.();
    this.#flows.set(key(target), flow);
    this.#publish(target, { state: "authenticating", flowId: flow.id, expiresAt });
    try {
      const result = await flow.protocol.start(metadata.email, password, flow.controller.signal);
      this.#current(flow);
      if ("credential" in result) return await this.#finish(flow, result);
      return this.#publish(target, { state: "challenge", flowId: flow.id, expiresAt, ...result });
    } catch (error) {
      if (this.#flows.get(key(target)) === flow) {
        this.#drop(target);
        this.#publish(target, { state: "failed", error: safe(error) });
      }
      throw safe(error);
    } finally {
      flow.busy = false;
    }
  }
  async #flow(target: AppleSessionTarget, flowId: string) {
    await this.status(target);
    const flow = this.#flows.get(key(target));
    if (!flow || flow.id !== flowId)
      throw appleError("credential-changed", "This Apple challenge is no longer current.");
    this.#current(flow);
    if (flow.busy)
      throw appleError("request-failed", "The Apple challenge response is already being checked.");
    flow.busy = true;
    return flow;
  }
  async complete(target: AppleSessionTarget, flowId: string, code: string): Promise<State> {
    const flow = await this.#flow(target, flowId);
    flow.busy = true;
    try {
      return await this.#finish(flow, await flow.protocol.complete(code, flow.controller.signal));
    } catch (error) {
      throw safe(error);
    } finally {
      flow.busy = false;
    }
  }
  async requestCode(
    target: AppleSessionTarget,
    flowId: string,
    phoneNumberId: number,
  ): Promise<State> {
    const flow = await this.#flow(target, flowId);
    flow.busy = true;
    try {
      const challenge = await flow.protocol.requestCode(phoneNumberId, flow.controller.signal);
      this.#current(flow);
      return this.#publish(target, {
        state: "challenge",
        flowId,
        expiresAt: flow.expiresAt,
        ...challenge,
      });
    } catch (error) {
      throw safe(error);
    } finally {
      flow.busy = false;
    }
  }
  async cancel(target: AppleSessionTarget, flowId: string): Promise<State> {
    target = { companyId: target.companyId, accountId: target.accountId };
    await this.backend.status(target);
    const flow = this.#flows.get(key(target));
    if (!flow || flow.id !== flowId)
      throw appleError("credential-changed", "This Apple sign-in is no longer current.");
    return this.signOut(target);
  }
  async signOut(target: AppleSessionTarget): Promise<State> {
    target = { companyId: target.companyId, accountId: target.accountId };
    await this.backend.status(target);
    this.#drop(target);
    return this.#serial(target, async () => {
      const current = await this.backend.status(target);
      await this.backend.revoke(target, current.revision);
      return this.#publish(target, { state: "signed-out" });
    });
  }
  async lease(target: AppleSessionTarget): Promise<AppleSessionLease> {
    try {
      const lease = await this.backend.read({
        companyId: target.companyId,
        accountId: target.accountId,
      });
      if (
        lease.expiresAt === null ||
        lease.expiresAt <= this.now() ||
        lease.leaseExpiresAt <= this.now()
      )
        throw appleError("unauthorized", "Sign in to the Apple account again.");
      return lease;
    } catch {
      this.#publish(target, { state: "expired" });
      throw appleError(
        "unauthorized",
        "Sign in to the Apple account again, then retry the install.",
      );
    }
  }
  dispose() {
    this.#closed = true;
    for (const flow of this.#flows.values()) this.#drop(flow.target);
    this.#states.clear();
    this.#watchers.clear();
  }
}
