import { companyEntityCodec, type CompanySyncEntity } from "@spiritdevs/client-runtime/sync";
import { EnvironmentId, ProjectId } from "@spiritdevs/contracts";
import { CompanyId } from "@spiritdevs/contracts/company";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  companyCapturedEmailsFromReplicas,
  companyEmailTagsFromReplicas,
  companyProjectBindingsFromReplicas,
  companyTrustedEmailSendersFromReplicas,
  trustedEmailSenderAddressesForCompany,
} from "./capturedEmailReadModel";

const COMPANY_A = CompanyId.make("company-a");
const COMPANY_B = CompanyId.make("company-b");
const ENVIRONMENT_ID = EnvironmentId.make("environment-one");
const PROJECT_ID = ProjectId.make("project-one");

function entity(
  kind: "capturedEmail" | "emailTag" | "trustedEmailSender" | "environmentBinding",
  payload: unknown,
) {
  const codec = companyEntityCodec(kind);
  if (codec === null) throw new Error(`missing ${kind} codec`);
  return Option.getOrThrow(codec.decode(payload));
}

function capturedEmail(subject: string) {
  return entity("capturedEmail", {
    id: `${ENVIRONMENT_ID}:message-one`,
    environmentId: ENVIRONMENT_ID,
    cloudProjectId: "cloud-project-one",
    message: {
      id: "message-one",
      attribution: {
        projectId: PROJECT_ID,
        mailSlug: "pathway",
        matchedBy: "auth-username",
        matchedValue: "pathway",
      },
      envelope: {
        mailFrom: "sender@example.com",
        rcptTo: ["dev@example.test"],
        authUsername: "pathway",
        helo: null,
        remoteAddress: null,
      },
      parsedHeaders: {
        subject,
        messageId: null,
        date: null,
        from: [{ address: "sender@example.com", name: null }],
        to: [{ address: "dev@example.test", name: null }],
        cc: [],
        bcc: [],
        replyTo: [],
        headers: [],
      },
      textBody: "hello",
      htmlBody: null,
      attachments: [],
      smtpTransactionLog: [],
      timings: {
        connectedAt: "2026-08-19T00:00:00.000Z",
        messageReceivedAt: "2026-08-19T00:00:00.000Z",
        parsedAt: "2026-08-19T00:00:00.000Z",
        storedAt: "2026-08-19T00:00:00.000Z",
        parseDurationMs: 0,
        totalDurationMs: 0,
      },
      sizeBytes: 5,
      isRead: false,
      detectedCode: null,
      deliverability: {
        version: 1,
        checks: [],
        metrics: {
          subjectLength: subject.length,
          imageCount: 0,
          visibleTextCharacters: 5,
          imageToTextRatio: 0,
          trackingPixelCount: 0,
        },
        htmlCompatibilityWarnings: [],
      },
    },
    tagIds: ["tag-one"],
    updatedAt: 1_000,
  });
}

function replica(companyLabel: string) {
  const values = [
    capturedEmail(`${companyLabel} mail`),
    entity("emailTag", {
      id: "tag-one",
      name: `${companyLabel} tag`,
      color: "#123456",
      createdAt: 1_000,
      updatedAt: 1_000,
    }),
    entity("trustedEmailSender", {
      id: "sender-one",
      address: "sender@example.com",
      createdAt: 1_000,
      updatedAt: 1_000,
    }),
    entity("environmentBinding", {
      id: `binding-${companyLabel}`,
      cloudProjectId: `cloud-project-${companyLabel}`,
      environmentId: ENVIRONMENT_ID,
      localProjectId: PROJECT_ID,
      localWorkspaceRoot: `/work/${companyLabel}`,
      status: "active",
      lastSeenAt: 1_000,
      createdAt: 1_000,
      updatedAt: 1_000,
    }),
  ];
  return {
    view: new Map(values.map((value) => [`${value.entityKind}:${value.id}`, value] as const)),
  };
}

describe("company-scoped captured email projections", () => {
  it("preserves company provenance for rows, catalogs, and colliding local bindings", () => {
    const replicas = new Map([
      [COMPANY_A, replica("a")],
      [COMPANY_B, replica("b")],
    ]) satisfies ReadonlyMap<CompanyId, { readonly view: ReadonlyMap<string, CompanySyncEntity> }>;

    expect(companyCapturedEmailsFromReplicas(replicas).map((row) => row.companyId)).toEqual([
      COMPANY_A,
      COMPANY_B,
    ]);
    expect(companyEmailTagsFromReplicas(replicas).map((tag) => tag.companyId)).toEqual([
      COMPANY_A,
      COMPANY_B,
    ]);
    expect(
      companyTrustedEmailSendersFromReplicas(replicas).map((sender) => sender.companyId),
    ).toEqual([COMPANY_A, COMPANY_B]);
    expect(
      trustedEmailSenderAddressesForCompany(
        companyTrustedEmailSendersFromReplicas(replicas),
        COMPANY_A,
      ),
    ).toEqual(new Set(["sender@example.com"]));
    expect(
      trustedEmailSenderAddressesForCompany(
        companyTrustedEmailSendersFromReplicas(
          new Map([
            [
              COMPANY_B,
              {
                view: new Map([
                  [
                    "trustedEmailSender:sender-two",
                    entity("trustedEmailSender", {
                      id: "sender-two",
                      address: "other@example.com",
                      createdAt: 1_000,
                      updatedAt: 1_000,
                    }),
                  ],
                ]),
              },
            ],
          ]),
        ),
        COMPANY_A,
      ),
    ).toEqual(new Set());
    expect(
      companyProjectBindingsFromReplicas(replicas).get(`${ENVIRONMENT_ID}\0${PROJECT_ID}`),
    ).toEqual([
      { companyId: COMPANY_A, cloudProjectId: "cloud-project-a" },
      { companyId: COMPANY_B, cloudProjectId: "cloud-project-b" },
    ]);
  });

  it("projects only the replicas supplied by the account scope", () => {
    const selected = new Map([[COMPANY_B, replica("b")]]);

    expect(companyCapturedEmailsFromReplicas(selected).map((row) => row.companyId)).toEqual([
      COMPANY_B,
    ]);
    expect(companyEmailTagsFromReplicas(selected).map((tag) => tag.companyId)).toEqual([COMPANY_B]);
  });
});
