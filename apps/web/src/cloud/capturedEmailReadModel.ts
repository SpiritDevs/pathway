/** Replica-backed captured mail, its shared catalogs, and project-binding lookup. */
import {
  CapturedEmailEntity,
  EmailTagEntity,
  EnvironmentBindingEntity,
  TrustedEmailSenderEntity,
} from "@spiritdevs/client-runtime/sync";
import type { EmailTag, TrustedEmailSender } from "@spiritdevs/contracts";
import type { CloudProjectId } from "@spiritdevs/contracts/cloudProject";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";

import { companyRegistryReplicasAtom } from "./companyRegistryReplica";
import { activeCompanyReplicaRoutingAtom } from "./activeCompany";

const EMPTY_CAPTURED_EMAILS: ReadonlyArray<CapturedEmailEntity> = Object.freeze([]);
const isCapturedEmail = Schema.is(CapturedEmailEntity);
const isEnvironmentBinding = Schema.is(EnvironmentBindingEntity);
const isEmailTag = Schema.is(EmailTagEntity);
const isTrustedEmailSender = Schema.is(TrustedEmailSenderEntity);

export const cloudCapturedEmailsAtom = Atom.make((get): ReadonlyArray<CapturedEmailEntity> => {
  const activeCompanyId = get(activeCompanyReplicaRoutingAtom);
  const emails: CapturedEmailEntity[] = [];
  const seen = new Set<string>();
  for (const [companyId, replica] of get(companyRegistryReplicasAtom)) {
    if (activeCompanyId !== null && companyId !== activeCompanyId) continue;
    for (const value of replica.view.values()) {
      if (!isCapturedEmail(value) || seen.has(value.id)) continue;
      seen.add(value.id);
      emails.push(value);
    }
  }
  if (emails.length === 0) return EMPTY_CAPTURED_EMAILS;
  return emails.sort(
    (left, right) =>
      Date.parse(right.message.timings.messageReceivedAt) -
      Date.parse(left.message.timings.messageReceivedAt),
  );
}).pipe(Atom.withLabel("cloud-captured-emails"));

const EMPTY_EMAIL_TAGS: ReadonlyArray<EmailTag> = Object.freeze([]);

export const cloudEmailTagsAtom = Atom.make((get): ReadonlyArray<EmailTag> => {
  const activeCompanyId = get(activeCompanyReplicaRoutingAtom);
  const tags: EmailTag[] = [];
  for (const [companyId, replica] of get(companyRegistryReplicasAtom)) {
    if (activeCompanyId !== null && companyId !== activeCompanyId) continue;
    for (const value of replica.view.values()) {
      if (!isEmailTag(value)) continue;
      tags.push({ id: value.id, name: value.name, color: value.color });
    }
  }
  return tags.length === 0
    ? EMPTY_EMAIL_TAGS
    : tags.sort((left, right) => left.name.localeCompare(right.name));
}).pipe(Atom.withLabel("cloud-email-tags"));

const EMPTY_TRUSTED_EMAIL_SENDERS: ReadonlyArray<TrustedEmailSender> = Object.freeze([]);

export const cloudTrustedEmailSendersAtom = Atom.make((get): ReadonlyArray<TrustedEmailSender> => {
  const activeCompanyId = get(activeCompanyReplicaRoutingAtom);
  const senders: TrustedEmailSender[] = [];
  for (const [companyId, replica] of get(companyRegistryReplicasAtom)) {
    if (activeCompanyId !== null && companyId !== activeCompanyId) continue;
    for (const value of replica.view.values()) {
      if (!isTrustedEmailSender(value)) continue;
      senders.push({ id: value.id, address: value.address });
    }
  }
  return senders.length === 0
    ? EMPTY_TRUSTED_EMAIL_SENDERS
    : senders.sort((left, right) => left.address.localeCompare(right.address));
}).pipe(Atom.withLabel("cloud-trusted-email-senders"));

/** `${environmentId}\0${localProjectId}` → stable company project id. */
export const cloudProjectBindingsAtom = Atom.make((get): ReadonlyMap<string, CloudProjectId> => {
  const activeCompanyId = get(activeCompanyReplicaRoutingAtom);
  const bindings = new Map<string, CloudProjectId>();
  for (const [companyId, replica] of get(companyRegistryReplicasAtom)) {
    if (activeCompanyId !== null && companyId !== activeCompanyId) continue;
    for (const value of replica.view.values()) {
      if (!isEnvironmentBinding(value) || value.status !== "active") continue;
      bindings.set(`${value.environmentId}\0${value.localProjectId}`, value.cloudProjectId);
    }
  }
  return bindings;
}).pipe(Atom.withLabel("cloud-captured-email-project-bindings"));
