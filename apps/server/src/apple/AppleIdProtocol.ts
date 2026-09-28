import { srpExchange } from "./AppleSrp.ts";
// @effect-diagnostics globalDate:off globalFetch:off -- Protocol boundary has an injectable clock and HTTP transport.
import * as Schema from "effect/Schema";
import { Cookie, CookieJar } from "tough-cookie";
import type { AppleSessionCredential, DiscoveredAppleTeam } from "@spiritdevs/backend/appleSession";
import { AppleError } from "@spiritdevs/contracts/apple";

export type AppleHttp = (url: string, init: RequestInit) => Promise<Response>;
export const appleError = (code: AppleError["code"], message: string) =>
  new AppleError({ code, message, retryAfterSeconds: null });
const authBase = "https://idmsa.apple.com/appleauth/";
const phone = Schema.Struct({ id: Schema.Int, numberWithDialCode: Schema.String });
const optionsSchema = Schema.Struct({
  trustedPhoneNumbers: Schema.optional(Schema.Array(phone)),
  trustedPhoneNumber: Schema.optional(phone),
  noTrustedDevices: Schema.optional(Schema.Boolean),
  fsaChallenge: Schema.optional(Schema.Unknown),
});
const decodeServiceKey = Schema.decodeUnknownSync(Schema.Struct({ authServiceKey: Schema.String }));
const decodeSession = Schema.decodeUnknownSync(
  Schema.Struct({ user: Schema.Record(Schema.String, Schema.Unknown) }),
);
const decodeOptions = Schema.decodeUnknownSync(optionsSchema);
const decodeTeams = Schema.decodeUnknownSync(
  Schema.Struct({
    teams: Schema.optional(
      Schema.Array(
        Schema.Struct({
          teamId: Schema.String,
          name: Schema.String,
          type: Schema.optional(Schema.String),
        }),
      ),
    ),
  }),
);
export type AppleChallenge = {
  kind: "trusted-device" | "sms" | "sms-choice";
  destination: string | null;
  phoneNumbers: readonly { id: number; destination: string }[];
};
export type AppleAuthenticated = {
  credential: AppleSessionCredential;
  expiresAt: number;
  teams: readonly DiscoveredAppleTeam[];
};
export interface AppleIdProtocol {
  start(
    email: string,
    password: string,
    signal: AbortSignal,
  ): Promise<AppleChallenge | AppleAuthenticated>;
  complete(code: string, signal: AbortSignal): Promise<AppleAuthenticated>;
  requestCode(phoneNumberId: number, signal: AbortSignal): Promise<AppleChallenge>;
  dispose(): void;
}
/** Per-flow jars, including redirects. No shared OS cookie store or library cookie cache. */
export class AppleCookieHttp {
  readonly jar = new CookieJar();
  readonly http: AppleHttp;
  readonly now: () => number;
  constructor(http: AppleHttp = (url, init) => fetch(url, init), now = Date.now) {
    this.http = http;
    this.now = now;
  }
  async request(url: string, init: RequestInit, redirects = 0): Promise<Response> {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      !/(^|\.)apple\.com$/i.test(parsed.hostname) ||
      redirects > 8
    )
      throw appleError("invalid-response", "Apple returned an invalid redirect.");
    const headers = new Headers(init.headers);
    const cookies = await this.jar.getCookieString(url);
    if (cookies) headers.set("cookie", cookies);
    else headers.delete("cookie");
    const response = await this.http(url, { ...init, headers, redirect: "manual" });
    for (const cookie of response.headers.getSetCookie()) await this.jar.setCookie(cookie, url);
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.get("location")) {
      const next = new URL(response.headers.get("location")!, url);
      const nextHeaders = new Headers();
      for (const [name, value] of new Headers(init.headers)) {
        if (
          next.origin === parsed.origin ||
          ["accept", "user-agent", "range", "accept-encoding", "if-range"].includes(name)
        )
          nextHeaders.set(name, value);
      }
      const isGet = [301, 302, 303].includes(response.status);
      await response.body?.cancel();
      return this.request(
        next.href,
        { ...init, headers: nextHeaders, ...(isGet ? { method: "GET", body: null } : {}) },
        redirects + 1,
      );
    }
    return response;
  }
  restore(credential: AppleSessionCredential): void {
    for (const c of credential.cookies)
      this.jar.setCookieSync(
        new Cookie({ ...c, expires: c.expires === null ? "Infinity" : new Date(c.expires) }),
        `https://${c.domain.replace(/^\./, "")}${c.path}`,
      );
  }
  credential(): AppleSessionCredential {
    const cookies = (this.jar.serializeSync()?.cookies ?? []).flatMap((raw) => {
      const c = Cookie.fromJSON(raw);
      if (!c?.domain || !c.secure || !/(^|\.)apple\.com$/i.test(c.domain)) return [];
      return [
        {
          key: c.key,
          value: c.value,
          domain: c.domain,
          path: c.path ?? "/",
          secure: c.secure,
          httpOnly: c.httpOnly,
          expires: c.expires instanceof Date ? c.expires.getTime() : null,
        },
      ];
    });
    return { cookies };
  }
}

export class LiveAppleIdProtocol implements AppleIdProtocol {
  readonly #client: AppleCookieHttp;
  #headers: Record<string, string> = {};
  #phones: AppleChallenge["phoneNumbers"] = [];
  #phoneId: number | undefined;
  readonly now: () => number;
  constructor(http?: AppleHttp, now = Date.now) {
    this.now = now;
    this.#client = new AppleCookieHttp(http, now);
  }
  dispose() {
    this.#client.jar.removeAllCookiesSync();
    this.#headers = {};
    this.#phones = [];
  }
  async #request(path: string, signal: AbortSignal, body?: unknown, method = "GET") {
    const response = await this.#client.request(new URL(path, authBase).href, {
      method,
      headers: this.#headers,
      signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const scnt = response.headers.get("scnt");
    if (scnt) this.#headers.scnt = scnt;
    if (!response.ok)
      throw appleError(
        response.status === 401 || response.status === 400 ? "unauthorized" : "request-failed",
        "Apple could not complete sign-in. Check the code or sign in again.",
      );
    return response;
  }
  async start(
    email: string,
    password: string,
    signal: AbortSignal,
  ): Promise<AppleChallenge | AppleAuthenticated> {
    // The logout request uses no account cookies; its redirect exposes Apple's current public widget key.
    const probe = await this.#client.http("https://appstoreconnect.apple.com/logout", {
      method: "HEAD",
      redirect: "manual",
      signal,
    });
    const location = probe.headers.get("location");
    let key = location
      ? new URL(location, "https://appstoreconnect.apple.com").searchParams.get("widgetKey")
      : null;
    if (!key) {
      const response = await this.#client.request(
        "https://appstoreconnect.apple.com/olympus/v1/app/config?hostname=itunesconnect.apple.com",
        { signal },
      );
      key = decodeServiceKey(await response.json()).authServiceKey;
    }
    const result = await srpExchange(email, password, key, this.#client, signal);
    if (!result.isTFAEnabled) return this.#authenticated(signal);
    if (!result.scnt || !result.sessionId)
      throw appleError("invalid-response", "Apple did not return a challenge.");
    this.#headers = {
      "X-Apple-Widget-Key": key,
      "X-Apple-ID-Session-Id": result.sessionId,
      scnt: result.scnt,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    const options = decodeOptions(await (await this.#request("auth", signal)).json());
    if (options.fsaChallenge !== undefined)
      throw appleError(
        "request-failed",
        "This Apple account requires a hardware security key, which this sign-in flow does not support.",
      );
    this.#phones = (options.trustedPhoneNumbers ?? []).map((p) => ({
      id: p.id,
      destination: p.numberWithDialCode,
    }));
    this.#phoneId = options.trustedPhoneNumber?.id;
    if (options.noTrustedDevices && this.#phones.length === 1 && this.#phoneId === undefined)
      return this.requestCode(this.#phones[0]!.id, signal);
    return {
      kind:
        this.#phoneId !== undefined
          ? "sms"
          : options.noTrustedDevices
            ? "sms-choice"
            : "trusted-device",
      destination: options.trustedPhoneNumber?.numberWithDialCode ?? null,
      phoneNumbers: this.#phones,
    };
  }
  async requestCode(phoneNumberId: number, signal: AbortSignal): Promise<AppleChallenge> {
    const phone = this.#phones.find((p) => p.id === phoneNumberId);
    if (!phone)
      throw appleError("invalid-response", "Choose a phone number from the current challenge.");
    await this.#request(
      "auth/verify/phone",
      signal,
      { phoneNumber: { id: phoneNumberId }, mode: "sms" },
      "PUT",
    );
    this.#phoneId = phoneNumberId;
    return { kind: "sms", destination: phone.destination, phoneNumbers: this.#phones };
  }
  async complete(code: string, signal: AbortSignal): Promise<AppleAuthenticated> {
    if (!/^\d{6}$/.test(code))
      throw appleError("unauthorized", "Enter the six-digit Apple verification code.");
    const sms = this.#phoneId !== undefined;
    await this.#request(
      `auth/verify/${sms ? "phone" : "trusteddevice"}/securitycode`,
      signal,
      {
        securityCode: { code },
        ...(sms ? { phoneNumber: { id: this.#phoneId }, mode: "sms" } : {}),
      },
      "POST",
    );
    await this.#request("auth/2sv/trust", signal);
    return this.#authenticated(signal);
  }
  async #authenticated(signal: AbortSignal): Promise<AppleAuthenticated> {
    const response = await this.#client.request(
      "https://appstoreconnect.apple.com/olympus/v1/session",
      { signal },
    );
    if (!response.ok)
      throw appleError("unauthorized", "Apple rejected the session. Sign in again.");
    decodeSession(await response.json());
    // ASC provider IDs are not Developer team IDs. Discovery uses the Developer portal.
    let teams: readonly DiscoveredAppleTeam[] = [];
    try {
      const discovery = await this.#client.request(
        "https://developer.apple.com/services-account/QH65B2/account/listTeams.action",
        { method: "POST", signal },
      );
      if (discovery.ok) {
        const data = decodeTeams(await discovery.json());
        teams = (data.teams ?? []).map((t) => ({
          teamId: t.teamId,
          name: t.name,
          type:
            t.type === "Company/Organization"
              ? "organization"
              : t.type === "Individual"
                ? "individual"
                : t.type === "In-House"
                  ? "enterprise"
                  : "unknown",
        }));
      }
    } catch {
      // Developer team membership is optional for an authenticated download session.
      signal.throwIfAborted();
    }
    const credential = this.#client.credential();
    if (!credential.cookies.length)
      throw appleError("invalid-response", "Apple returned no session cookies.");
    const sessionCookies = credential.cookies.filter((c) => ["myacinfo", "dqsid"].includes(c.key));
    const expiry = sessionCookies.flatMap((c) => (c.expires === null ? [] : [c.expires]));
    return { credential, expiresAt: Math.min(this.now() + 8 * 60 * 60 * 1000, ...expiry), teams };
  }
}
