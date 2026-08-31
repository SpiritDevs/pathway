/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agentThreads from "../agentThreads.js";
import type * as capturedEmails from "../capturedEmails.js";
import type * as calendarAccounts from "../calendarAccounts.js";
import type * as calendars from "../calendars.js";
import type * as cloudProjects from "../cloudProjects.js";
import type * as companies from "../companies.js";
import type * as connectGrants from "../connectGrants.js";
import type * as crons from "../crons.js";
import type * as emailTags from "../emailTags.js";
import type * as environmentCommands from "../environmentCommands.js";
import type * as environments from "../environments.js";
import type * as focusNotifications from "../focusNotifications.js";
import type * as focuses from "../focuses.js";
import type * as invitations from "../invitations.js";
import type * as issueAttachments from "../issueAttachments.js";
import type * as issueAutomation from "../issueAutomation.js";
import type * as issueImport from "../issueImport.js";
import type * as lib_automationJobs from "../lib/automationJobs.js";
import type * as lib_companyApply from "../lib/companyApply.js";
import type * as lib_directIssueApply from "../lib/directIssueApply.js";
import type * as lib_domainIds from "../lib/domainIds.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_identity from "../lib/identity.js";
import type * as lib_issueApply from "../lib/issueApply.js";
import type * as lib_relayIdentity from "../lib/relayIdentity.js";
import type * as lib_slackOutbound from "../lib/slackOutbound.js";
import type * as lib_validators from "../lib/validators.js";
import type * as memberships from "../memberships.js";
import type * as projectMigration from "../projectMigration.js";
import type * as relayPersistence from "../relayPersistence.js";
import type * as roles from "../roles.js";
import type * as slackIntegrations from "../slackIntegrations.js";
import type * as slackOperations from "../slackOperations.js";
import type * as smoke from "../smoke.js";
import type * as sync from "../sync.js";
import type * as teams from "../teams.js";
import type * as trustedEmailSenders from "../trustedEmailSenders.js";

import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";

declare const fullApi: ApiFromModules<{
  agentThreads: typeof agentThreads;
  capturedEmails: typeof capturedEmails;
  calendarAccounts: typeof calendarAccounts;
  calendars: typeof calendars;
  cloudProjects: typeof cloudProjects;
  companies: typeof companies;
  connectGrants: typeof connectGrants;
  crons: typeof crons;
  emailTags: typeof emailTags;
  environmentCommands: typeof environmentCommands;
  environments: typeof environments;
  focusNotifications: typeof focusNotifications;
  focuses: typeof focuses;
  invitations: typeof invitations;
  issueAttachments: typeof issueAttachments;
  issueAutomation: typeof issueAutomation;
  issueImport: typeof issueImport;
  "lib/automationJobs": typeof lib_automationJobs;
  "lib/companyApply": typeof lib_companyApply;
  "lib/directIssueApply": typeof lib_directIssueApply;
  "lib/domainIds": typeof lib_domainIds;
  "lib/errors": typeof lib_errors;
  "lib/identity": typeof lib_identity;
  "lib/issueApply": typeof lib_issueApply;
  "lib/relayIdentity": typeof lib_relayIdentity;
  "lib/slackOutbound": typeof lib_slackOutbound;
  "lib/validators": typeof lib_validators;
  memberships: typeof memberships;
  projectMigration: typeof projectMigration;
  relayPersistence: typeof relayPersistence;
  roles: typeof roles;
  slackIntegrations: typeof slackIntegrations;
  slackOperations: typeof slackOperations;
  smoke: typeof smoke;
  sync: typeof sync;
  teams: typeof teams;
  trustedEmailSenders: typeof trustedEmailSenders;
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
