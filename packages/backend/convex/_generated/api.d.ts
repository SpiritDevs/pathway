/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as companies from "../companies.js";
import type * as environmentCommands from "../environmentCommands.js";
import type * as environments from "../environments.js";
import type * as invitations from "../invitations.js";
import type * as lib_capability from "../lib/capability.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_identity from "../lib/identity.js";
import type * as lib_issueApply from "../lib/issueApply.js";
import type * as lib_relayIdentity from "../lib/relayIdentity.js";
import type * as lib_validators from "../lib/validators.js";
import type * as memberships from "../memberships.js";
import type * as relayPersistence from "../relayPersistence.js";
import type * as roles from "../roles.js";
import type * as smoke from "../smoke.js";
import type * as sync from "../sync.js";
import type * as teams from "../teams.js";

import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";

declare const fullApi: ApiFromModules<{
  companies: typeof companies;
  environmentCommands: typeof environmentCommands;
  environments: typeof environments;
  invitations: typeof invitations;
  "lib/capability": typeof lib_capability;
  "lib/errors": typeof lib_errors;
  "lib/identity": typeof lib_identity;
  "lib/issueApply": typeof lib_issueApply;
  "lib/relayIdentity": typeof lib_relayIdentity;
  "lib/validators": typeof lib_validators;
  memberships: typeof memberships;
  relayPersistence: typeof relayPersistence;
  roles: typeof roles;
  smoke: typeof smoke;
  sync: typeof sync;
  teams: typeof teams;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<typeof fullApi, FunctionReference<any, "public">>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<typeof fullApi, FunctionReference<any, "internal">>;

export declare const components: {};
