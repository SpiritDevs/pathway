/** Replica-backed captured mail, its shared catalogs, and project-binding lookup. */
import {
  CapturedEmailEntity,
  EmailTagEntity,
  EnvironmentBindingEntity,
  TrustedEmailSenderEntity,
} from "@spiritdevs/client-runtime/sync";
import type { EmailTag, TrustedEmailSender } from "@spiritdevs/contracts";
import type { CloudProjectId } from "@spiritdevs/contracts/cloudProject";
import type { CompanyId } from "@spiritdevs/contracts/company";
import type { CompanyRegistryReplicaState } from "@spiritdevs/client-runtime/connection";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";

import { scopedCompanyRegistryReplicasAtom } from "./activeCompany";

export interface CompanyCapturedEmailEntity extends CapturedEmailEntity {
  readonly companyId: CompanyId;
}

export interface CompanyEmailTag extends EmailTag {
  readonly companyId: CompanyId;
}

export interface CompanyTrustedEmailSender extends TrustedEmailSender {
  readonly companyId: CompanyId;
}

export interface CompanyProjectBinding {
  readonly companyId: CompanyId;
  readonly cloudProjectId: CloudProjectId;
}

export function trustedEmailSenderAddressesForCompany(
  senders: ReadonlyArray<CompanyTrustedEmailSender>,
  companyId: CompanyId | null,
): ReadonlySet<string> {
  if (companyId === null) return new Set();
  return new Set(
    senders.filter((sender) => sender.companyId === companyId).map((sender) => sender.address),
  );
}

const EMPTY_CAPTURED_EMAILS: ReadonlyArray<CompanyCapturedEmailEntity> = Object.freeze([]);
const isCapturedEmail = Schema.is(CapturedEmailEntity);
const isEnvironmentBinding = Schema.is(EnvironmentBindingEntity);
const isEmailTag = Schema.is(EmailTagEntity);
const isTrustedEmailSender = Schema.is(TrustedEmailSenderEntity);

export function companyCapturedEmailsFromReplicas(
  replicas: ReadonlyMap<CompanyId, CompanyRegistryReplicaState>,
): ReadonlyArray<CompanyCapturedEmailEntity> {
  const emails: CompanyCapturedEmailEntity[] = [];
  const seen = new Set<string>();
  for (const [companyId, replica] of replicas) {
    for (const value of replica.view.values()) {
      if (!isCapturedEmail(value)) continue;
      const key = `${companyId}\0${value.environmentId}\0${value.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      emails.push({ ...value, companyId });
    }
  }
  if (emails.length === 0) return EMPTY_CAPTURED_EMAILS;
  return emails.sort(
    (left, right) =>
      Date.parse(right.message.timings.messageReceivedAt) -
      Date.parse(left.message.timings.messageReceivedAt),
  );
}

export const cloudCapturedEmailsAtom = Atom.make(
  (get): ReadonlyArray<CompanyCapturedEmailEntity> =>
    companyCapturedEmailsFromReplicas(get(scopedCompanyRegistryReplicasAtom)),
).pipe(Atom.withLabel("cloud-captured-emails"));

const EMPTY_EMAIL_TAGS: ReadonlyArray<CompanyEmailTag> = Object.freeze([]);

export function companyEmailTagsFromReplicas(
  replicas: ReadonlyMap<CompanyId, CompanyRegistryReplicaState>,
): ReadonlyArray<CompanyEmailTag> {
  const tags: CompanyEmailTag[] = [];
  for (const [companyId, replica] of replicas) {
    for (const value of replica.view.values()) {
      if (!isEmailTag(value)) continue;
      tags.push({ id: value.id, name: value.name, color: value.color, companyId });
    }
  }
  return tags.length === 0
    ? EMPTY_EMAIL_TAGS
    : tags.sort((left, right) => left.name.localeCompare(right.name));
}

export const cloudEmailTagsAtom = Atom.make(
  (get): ReadonlyArray<CompanyEmailTag> =>
    companyEmailTagsFromReplicas(get(scopedCompanyRegistryReplicasAtom)),
).pipe(Atom.withLabel("cloud-email-tags"));

const EMPTY_TRUSTED_EMAIL_SENDERS: ReadonlyArray<CompanyTrustedEmailSender> = Object.freeze([]);

export function companyTrustedEmailSendersFromReplicas(
  replicas: ReadonlyMap<CompanyId, CompanyRegistryReplicaState>,
): ReadonlyArray<CompanyTrustedEmailSender> {
  const senders: CompanyTrustedEmailSender[] = [];
  for (const [companyId, replica] of replicas) {
    for (const value of replica.view.values()) {
      if (!isTrustedEmailSender(value)) continue;
      senders.push({ id: value.id, address: value.address, companyId });
    }
  }
  return senders.length === 0
    ? EMPTY_TRUSTED_EMAIL_SENDERS
    : senders.sort((left, right) => left.address.localeCompare(right.address));
}

export const cloudTrustedEmailSendersAtom = Atom.make(
  (get): ReadonlyArray<CompanyTrustedEmailSender> =>
    companyTrustedEmailSendersFromReplicas(get(scopedCompanyRegistryReplicasAtom)),
).pipe(Atom.withLabel("cloud-trusted-email-senders"));

/** `${environmentId}\0${localProjectId}` → company and its stable project id. */
export function companyProjectBindingsFromReplicas(
  replicas: ReadonlyMap<CompanyId, CompanyRegistryReplicaState>,
): ReadonlyMap<string, ReadonlyArray<CompanyProjectBinding>> {
  const bindings = new Map<string, CompanyProjectBinding[]>();
  for (const [companyId, replica] of replicas) {
    for (const value of replica.view.values()) {
      if (!isEnvironmentBinding(value) || value.status !== "active") continue;
      const key = `${value.environmentId}\0${value.localProjectId}`;
      const rows = bindings.get(key) ?? [];
      rows.push({
        companyId,
        cloudProjectId: value.cloudProjectId,
      });
      bindings.set(key, rows);
    }
  }
  return bindings;
}

export const cloudProjectBindingsAtom = Atom.make(
  (get): ReadonlyMap<string, ReadonlyArray<CompanyProjectBinding>> =>
    companyProjectBindingsFromReplicas(get(scopedCompanyRegistryReplicasAtom)),
).pipe(Atom.withLabel("cloud-captured-email-project-bindings"));
