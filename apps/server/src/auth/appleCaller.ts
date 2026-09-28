import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { CLOUD_LINKED_USER_ID } from "../cloud/config.ts";
import { type AuthenticatedSession } from "./EnvironmentAuth.ts";
import { ServerSecretStore } from "./ServerSecretStore.ts";

export type AppleCaller = { clerkSubject: string } | { userId: string };

/** Cloud minting reserves cloud-connect for the linked owner; peer sessions retain the acting user. */
export const resolveAppleCaller = Effect.fn("auth.resolveAppleCaller")(function* (
  session: Pick<AuthenticatedSession, "subject">,
): Effect.fn.Return<AppleCaller | null, never, ServerSecretStore> {
  if (session.subject === "cloud-connect") {
    const secrets = yield* ServerSecretStore;
    const linked = yield* secrets.get(CLOUD_LINKED_USER_ID).pipe(Effect.option);
    if (Option.isNone(linked) || Option.isNone(linked.value)) return null;
    const clerkSubject = new TextDecoder().decode(linked.value.value).trim();
    return clerkSubject ? { clerkSubject } : null;
  }
  if (
    [
      "one-time-token",
      "cli-issued-session",
      "administrative-bootstrap",
      "desktop-bootstrap",
    ].includes(session.subject)
  )
    return null;
  const userId = session.subject.trim();
  return userId ? { userId } : null;
});
