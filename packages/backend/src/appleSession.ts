import * as Schema from "effect/Schema";

/** Only cookies cross the environment-to-Cloud boundary, never sign-in inputs or library state. */
export const AppleSessionCookie = Schema.Struct({
  key: Schema.String,
  value: Schema.String,
  domain: Schema.String,
  path: Schema.String,
  secure: Schema.Boolean,
  httpOnly: Schema.Boolean,
  expires: Schema.NullOr(Schema.Number),
});
export const AppleSessionCredential = Schema.Struct({ cookies: Schema.Array(AppleSessionCookie) });
export type AppleSessionCredential = typeof AppleSessionCredential.Type;
export type AppleSessionTarget = { companyId: string; accountId: string };
export type AppleSessionMetadata = {
  email: string;
  accountRevision: number;
  revision: number;
  expiresAt: number | null;
};
export type AppleSessionLease = AppleSessionMetadata & {
  credential: AppleSessionCredential;
  leaseExpiresAt: number;
};
export type DiscoveredAppleTeam = {
  teamId: string;
  name: string;
  type: "individual" | "organization" | "enterprise" | "unknown";
};
export interface AppleSessionBackend {
  status(target: AppleSessionTarget): Promise<AppleSessionMetadata>;
  save(
    target: AppleSessionTarget,
    input: {
      accountRevision: number;
      revision: number;
      credential: AppleSessionCredential;
      expiresAt: number;
      teams: readonly DiscoveredAppleTeam[];
    },
  ): Promise<AppleSessionMetadata>;
  read(target: AppleSessionTarget): Promise<AppleSessionLease>;
  revoke(target: AppleSessionTarget, revision: number): Promise<void>;
}
