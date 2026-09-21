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
import type * as aiOrchestratorAttachments from "../aiOrchestratorAttachments.js";
import type * as aiOrchestratorControls from "../aiOrchestratorControls.js";
import type * as aiOrchestratorEvents from "../aiOrchestratorEvents.js";
import type * as aiOrchestratorJobs from "../aiOrchestratorJobs.js";
import type * as aiOrchestratorPush from "../aiOrchestratorPush.js";
import type * as aiOrchestratorReviews from "../aiOrchestratorReviews.js";
import type * as aiOrchestrators from "../aiOrchestrators.js";
import type * as browserPasswords from "../browserPasswords.js";
import type * as calendarAccounts from "../calendarAccounts.js";
import type * as calendars from "../calendars.js";
import type * as capturedEmails from "../capturedEmails.js";
import type * as cloudProjects from "../cloudProjects.js";
import type * as companies from "../companies.js";
import type * as connectGrants from "../connectGrants.js";
import type * as contacts from "../contacts.js";
import type * as crons from "../crons.js";
import type * as dictationDictionary from "../dictationDictionary.js";
import type * as emailTags from "../emailTags.js";
import type * as environmentCommands from "../environmentCommands.js";
import type * as environments from "../environments.js";
import type * as focusNotifications from "../focusNotifications.js";
import type * as focuses from "../focuses.js";
import type * as invitations from "../invitations.js";
import type * as issueAttachments from "../issueAttachments.js";
import type * as issueAutomation from "../issueAutomation.js";
import type * as issueImport from "../issueImport.js";
import type * as lib_aiOrchestratorAuthority from "../lib/aiOrchestratorAuthority.js";
import type * as lib_aiOrchestratorCollaboration from "../lib/aiOrchestratorCollaboration.js";
import type * as lib_aiOrchestratorContext from "../lib/aiOrchestratorContext.js";
import type * as lib_aiOrchestratorEnvironmentSignals from "../lib/aiOrchestratorEnvironmentSignals.js";
import type * as lib_aiOrchestratorInspections from "../lib/aiOrchestratorInspections.js";
import type * as lib_aiOrchestratorIssueSignals from "../lib/aiOrchestratorIssueSignals.js";
import type * as lib_aiOrchestratorRouting from "../lib/aiOrchestratorRouting.js";
import type * as lib_aiOrchestratorSchema from "../lib/aiOrchestratorSchema.js";
import type * as lib_aiOrchestratorSignals from "../lib/aiOrchestratorSignals.js";
import type * as lib_aiOrchestratorTargets from "../lib/aiOrchestratorTargets.js";
import type * as lib_aiOrchestratorWork from "../lib/aiOrchestratorWork.js";
import type * as lib_automationJobs from "../lib/automationJobs.js";
import type * as lib_businessToolsSchema from "../lib/businessToolsSchema.js";
import type * as lib_companyApply from "../lib/companyApply.js";
import type * as lib_companySyncHead from "../lib/companySyncHead.js";
import type * as lib_conversationLifecycle from "../lib/conversationLifecycle.js";
import type * as lib_delegatedBusinessOwner from "../lib/delegatedBusinessOwner.js";
import type * as lib_dictationDictionary from "../lib/dictationDictionary.js";
import type * as lib_directIssueApply from "../lib/directIssueApply.js";
import type * as lib_domainIds from "../lib/domainIds.js";
import type * as lib_environmentRuntime from "../lib/environmentRuntime.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_identity from "../lib/identity.js";
import type * as lib_issueApply from "../lib/issueApply.js";
import type * as lib_mail from "../lib/mail.js";
import type * as lib_mailAccountRuntime from "../lib/mailAccountRuntime.js";
import type * as lib_mailSchema from "../lib/mailSchema.js";
import type * as lib_providerAllowanceSchema from "../lib/providerAllowanceSchema.js";
import type * as lib_publisherReconciliation from "../lib/publisherReconciliation.js";
import type * as lib_relayIdentity from "../lib/relayIdentity.js";
import type * as lib_slackOutbound from "../lib/slackOutbound.js";
import type * as lib_threadAlertPolicy from "../lib/threadAlertPolicy.js";
import type * as lib_threadQueueRetention from "../lib/threadQueueRetention.js";
import type * as lib_trackedTime from "../lib/trackedTime.js";
import type * as lib_validators from "../lib/validators.js";
import type * as loginErrorReports from "../loginErrorReports.js";
import type * as mail from "../mail.js";
import type * as mailJobs from "../mailJobs.js";
import type * as mailRelay from "../mailRelay.js";
import type * as memberships from "../memberships.js";
import type * as projectMigration from "../projectMigration.js";
import type * as providerAllowanceBudgets from "../providerAllowanceBudgets.js";
import type * as relayPersistence from "../relayPersistence.js";
import type * as roles from "../roles.js";
import type * as slackIntegrations from "../slackIntegrations.js";
import type * as slackOperations from "../slackOperations.js";
import type * as smoke from "../smoke.js";
import type * as sync from "../sync.js";
import type * as teams from "../teams.js";
import type * as threadAlertPolicies from "../threadAlertPolicies.js";
import type * as threadQueue from "../threadQueue.js";
import type * as timeTracking from "../timeTracking.js";
import type * as trustedEmailSenders from "../trustedEmailSenders.js";
import type * as workerWakeups from "../workerWakeups.js";

import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";

declare const fullApi: ApiFromModules<{
  agentThreads: typeof agentThreads;
  aiOrchestratorAttachments: typeof aiOrchestratorAttachments;
  aiOrchestratorControls: typeof aiOrchestratorControls;
  aiOrchestratorEvents: typeof aiOrchestratorEvents;
  aiOrchestratorJobs: typeof aiOrchestratorJobs;
  aiOrchestratorPush: typeof aiOrchestratorPush;
  aiOrchestratorReviews: typeof aiOrchestratorReviews;
  aiOrchestrators: typeof aiOrchestrators;
  browserPasswords: typeof browserPasswords;
  calendarAccounts: typeof calendarAccounts;
  calendars: typeof calendars;
  capturedEmails: typeof capturedEmails;
  cloudProjects: typeof cloudProjects;
  companies: typeof companies;
  connectGrants: typeof connectGrants;
  contacts: typeof contacts;
  crons: typeof crons;
  dictationDictionary: typeof dictationDictionary;
  emailTags: typeof emailTags;
  environmentCommands: typeof environmentCommands;
  environments: typeof environments;
  focusNotifications: typeof focusNotifications;
  focuses: typeof focuses;
  invitations: typeof invitations;
  issueAttachments: typeof issueAttachments;
  issueAutomation: typeof issueAutomation;
  issueImport: typeof issueImport;
  "lib/aiOrchestratorAuthority": typeof lib_aiOrchestratorAuthority;
  "lib/aiOrchestratorCollaboration": typeof lib_aiOrchestratorCollaboration;
  "lib/aiOrchestratorContext": typeof lib_aiOrchestratorContext;
  "lib/aiOrchestratorEnvironmentSignals": typeof lib_aiOrchestratorEnvironmentSignals;
  "lib/aiOrchestratorInspections": typeof lib_aiOrchestratorInspections;
  "lib/aiOrchestratorIssueSignals": typeof lib_aiOrchestratorIssueSignals;
  "lib/aiOrchestratorRouting": typeof lib_aiOrchestratorRouting;
  "lib/aiOrchestratorSchema": typeof lib_aiOrchestratorSchema;
  "lib/aiOrchestratorSignals": typeof lib_aiOrchestratorSignals;
  "lib/aiOrchestratorTargets": typeof lib_aiOrchestratorTargets;
  "lib/aiOrchestratorWork": typeof lib_aiOrchestratorWork;
  "lib/automationJobs": typeof lib_automationJobs;
  "lib/businessToolsSchema": typeof lib_businessToolsSchema;
  "lib/companyApply": typeof lib_companyApply;
  "lib/companySyncHead": typeof lib_companySyncHead;
  "lib/conversationLifecycle": typeof lib_conversationLifecycle;
  "lib/delegatedBusinessOwner": typeof lib_delegatedBusinessOwner;
  "lib/dictationDictionary": typeof lib_dictationDictionary;
  "lib/directIssueApply": typeof lib_directIssueApply;
  "lib/domainIds": typeof lib_domainIds;
  "lib/environmentRuntime": typeof lib_environmentRuntime;
  "lib/errors": typeof lib_errors;
  "lib/identity": typeof lib_identity;
  "lib/issueApply": typeof lib_issueApply;
  "lib/mail": typeof lib_mail;
  "lib/mailAccountRuntime": typeof lib_mailAccountRuntime;
  "lib/mailSchema": typeof lib_mailSchema;
  "lib/providerAllowanceSchema": typeof lib_providerAllowanceSchema;
  "lib/publisherReconciliation": typeof lib_publisherReconciliation;
  "lib/relayIdentity": typeof lib_relayIdentity;
  "lib/slackOutbound": typeof lib_slackOutbound;
  "lib/threadAlertPolicy": typeof lib_threadAlertPolicy;
  "lib/threadQueueRetention": typeof lib_threadQueueRetention;
  "lib/trackedTime": typeof lib_trackedTime;
  "lib/validators": typeof lib_validators;
  loginErrorReports: typeof loginErrorReports;
  mail: typeof mail;
  mailJobs: typeof mailJobs;
  mailRelay: typeof mailRelay;
  memberships: typeof memberships;
  projectMigration: typeof projectMigration;
  providerAllowanceBudgets: typeof providerAllowanceBudgets;
  relayPersistence: typeof relayPersistence;
  roles: typeof roles;
  slackIntegrations: typeof slackIntegrations;
  slackOperations: typeof slackOperations;
  smoke: typeof smoke;
  sync: typeof sync;
  teams: typeof teams;
  threadAlertPolicies: typeof threadAlertPolicies;
  threadQueue: typeof threadQueue;
  timeTracking: typeof timeTracking;
  trustedEmailSenders: typeof trustedEmailSenders;
  workerWakeups: typeof workerWakeups;
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
