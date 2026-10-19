import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import { Tool } from "effect/unstable/ai";

import { IssuesMcpCreateInput, IssuesToolkit } from "./tools.ts";

const isIssuesMcpCreateInput = Schema.is(IssuesMcpCreateInput);

const schemaHasDescription = (schema: unknown): boolean => {
  if (!schema || typeof schema !== "object") return false;
  const record = schema as Record<string, unknown>;
  if (typeof record.description === "string" && record.description.length > 0) return true;
  return [record.anyOf, record.oneOf, record.allOf]
    .filter(Array.isArray)
    .some((members) => members.some(schemaHasDescription));
};

/** Every tool is a top-level object with a described parameter, which is all a provider will take. */
it("exports provider-compatible object schemas with described parameters", () => {
  for (const tool of Object.values(IssuesToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly anyOf?: unknown;
      readonly oneOf?: unknown;
    };
    expect(
      tool.description?.length ?? 0,
      `${tool.name} should have a useful description`,
    ).toBeGreaterThan(40);
    expect(schema.type, `${tool.name} must export a top-level object schema`).toBe("object");
    expect(schema.anyOf, `${tool.name} must not export a root anyOf`).toBeUndefined();
    expect(schema.oneOf, `${tool.name} must not export a root oneOf`).toBeUndefined();
    for (const [field, fieldSchema] of Object.entries(schema.properties ?? {})) {
      expect(
        schemaHasDescription(fieldSchema),
        `${tool.name}.${field} should explain what data the agent must pass`,
      ).toBe(true);
    }
  }
});

/**
 * The decision record grants agents full write access with no approval gate, so the description is
 * the only place a side effect is ever stated. A tool that writes and does not say so is the bug
 * this guards against.
 */
it("states the side effect of every tool that writes", () => {
  const writers = [
    "issues_create",
    "issues_milestone_create",
    "issues_milestone_update",
    "issues_milestone_delete",
    "issues_update",
    "issues_comment",
    "issues_comment_evidence",
    "issues_delete",
    "issues_restore",
    "issues_link_thread",
  ] as const;
  for (const name of writers) {
    const tool = IssuesToolkit.tools[name];
    expect(Tool.getDescription(tool), `${name} should state its side effect`).toMatch(
      /writes to the tracker|visible to everyone|recorded against your name|recoverable|attributed to you|Record that a thread/i,
    );
    expect(Context.get(tool.annotations, Tool.Readonly), `${name} is a write`).toBe(false);
  }
});

it("marks the read tools read-only and the delete destructive", () => {
  for (const name of [
    "issues_list",
    "issues_get",
    "issues_get_attachment",
    "issues_milestones_list",
  ] as const) {
    expect(Context.get(IssuesToolkit.tools[name].annotations, Tool.Readonly)).toBe(true);
  }
  expect(Context.get(IssuesToolkit.tools.issues_delete.annotations, Tool.Destructive)).toBe(true);
  expect(
    Context.get(IssuesToolkit.tools.issues_milestone_delete.annotations, Tool.Destructive),
  ).toBe(true);
  expect(Context.get(IssuesToolkit.tools.issues_update.annotations, Tool.Destructive)).toBe(false);
  // A local SQLite table is not the open world. Evidence is the exception because it reads the
  // collaborative browser, whose current page may be remote.
  for (const tool of Object.values(IssuesToolkit.tools)) {
    expect(Context.get(tool.annotations, Tool.OpenWorld), `${tool.name} open-world hint`).toBe(
      tool.name === "issues_comment_evidence",
    );
  }
});

it("accepts the compact retry token returned for a maximum-length caller key", () => {
  const retryToken = `issue-retry:v1:${"c".repeat(16)}:${"r".repeat(43)}`;
  expect(
    isIssuesMcpCreateInput({
      title: "Resume the same create",
      idempotencyKey: retryToken,
    }),
  ).toBe(true);
  expect(retryToken.length).toBeLessThanOrEqual(512);
});
