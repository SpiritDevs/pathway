import {
  ChatAttachmentId,
  IssueCommentId,
  IssueId,
  IssueStatusId,
  IssueTodoId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
  type Issue,
  type IssueTodo,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "~/providerInstances";

import {
  buildIssueStartWorkPrompt,
  buildIssuesTalkPrompt,
  buildIssueTalkPrompt,
  issueTalkHostProjectId,
  issueDetailPath,
  issueDetailUrl,
  issueStartWorkAttachmentIds,
  loadIssueStartWorkImages,
  issueStartWorkWorkspaceModeLabel,
  issueStartWorkTodos,
  resolveIssueStartWorkModelSelection,
  resolveIssueStartWorkStatusId,
  resolveIssueStartWorkWorkspacePlan,
} from "./issueStartWork.logic";

const NOW = "2026-08-12T00:00:00.000Z";

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: IssueId.make("i1"),
    key: "PAT-12",
    title: "Login test is flaky",
    description: "",
    statusId: IssueStatusId.make("todo"),
    priority: "none",
    assignee: null,
    projectId: null,
    milestoneId: null,
    cycleId: null,
    parentId: null,
    sortOrder: "m",
    labelIds: [],
    dueDate: null,
    triage: false,
    slackSource: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function todo(id: string, text: string, position: number, done = false): IssueTodo {
  return {
    id: IssueTodoId.make(id),
    issueId: IssueId.make("i1"),
    text,
    done,
    position,
  };
}

function provider(
  instanceId: string,
  driver: "codex" | "claudeAgent",
  models: ReadonlyArray<string>,
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: NOW,
    models: models.map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: {},
    })),
    slashCommands: [],
    skills: [],
  };
}

describe("resolveIssueStartWorkModelSelection", () => {
  const providers = [
    provider("codex", "codex", ["gpt-5.6-sol"]),
    provider("codex_personal", "codex", ["gpt-5.6-luna"]),
    provider("claudeAgent", "claudeAgent", ["claude-opus-4-6"]),
  ];
  const entries = deriveProviderInstanceEntries(providers);
  const modelOptionsByInstance = new Map([
    [
      ProviderInstanceId.make("codex"),
      [{ slug: "gpt-5.6-sol", name: "GPT-5.6 Sol", isDefault: true }],
    ],
    [
      ProviderInstanceId.make("codex_personal"),
      [{ slug: "gpt-5.6-luna", name: "GPT-5.6 Luna", isDefault: true }],
    ],
    [
      ProviderInstanceId.make("claudeAgent"),
      [{ slug: "claude-opus-4-6", name: "Claude Opus 4.6", isDefault: true }],
    ],
  ]);

  it("keeps a compatible project model and its reasoning options", () => {
    expect(
      resolveIssueStartWorkModelSelection({
        provider: ProviderDriverKind.make("codex"),
        projectDefault: {
          instanceId: ProviderInstanceId.make("codex_personal"),
          model: "gpt-5.6-luna",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
        instanceEntries: entries,
        modelOptionsByInstance,
      }),
    ).toEqual({
      instanceId: "codex_personal",
      model: "gpt-5.6-luna",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
  });

  it("does not cross the assigned agent boundary when the project default uses another provider", () => {
    expect(
      resolveIssueStartWorkModelSelection({
        provider: ProviderDriverKind.make("codex"),
        projectDefault: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        instanceEntries: entries,
        modelOptionsByInstance,
      }),
    ).toEqual({ instanceId: "codex", model: "gpt-5.6-sol" });
  });

  it("returns no choice when the assigned provider has no configured instance", () => {
    expect(
      resolveIssueStartWorkModelSelection({
        provider: ProviderDriverKind.make("cursor"),
        projectDefault: null,
        instanceEntries: entries,
        modelOptionsByInstance,
      }),
    ).toBe(null);
  });
});

describe("issueDetailUrl", () => {
  it("points at the sheet over the list, because there is no per-issue route", () => {
    expect(issueDetailPath("PAT-12")).toBe("/issues?issue=PAT-12");
    expect(issueDetailUrl("http://localhost:5733", "PAT-12")).toBe(
      "http://localhost:5733/issues?issue=PAT-12",
    );
  });

  it("does not double a slash, and escapes a key that needs it", () => {
    expect(issueDetailUrl("http://localhost:5733/", "PAT-12")).toBe(
      "http://localhost:5733/issues?issue=PAT-12",
    );
    expect(issueDetailPath("A B")).toBe("/issues?issue=A%20B");
  });
});

describe("resolveIssueStartWorkWorkspacePlan", () => {
  it("uses the New worktree option label for the selected workspace trigger", () => {
    expect(issueStartWorkWorkspaceModeLabel("new_worktree")).toBe("New worktree");
  });

  it("starts current-checkout work in a distinct local thread without worktree preparation", () => {
    expect(resolveIssueStartWorkWorkspacePlan("current_checkout", "main")).toEqual({
      envMode: "local",
      branch: null,
      prepareWorktreeBaseBranch: null,
    });
  });

  it("uses the selected branch as the base for an isolated task worktree", () => {
    expect(resolveIssueStartWorkWorkspacePlan("new_worktree", "release/next")).toEqual({
      envMode: "worktree",
      branch: "release/next",
      prepareWorktreeBaseBranch: "release/next",
    });
  });

  it("refuses to invent a worktree base when the checkout has no branch", () => {
    expect(resolveIssueStartWorkWorkspacePlan("new_worktree", null)).toBe(null);
  });
});

describe("buildIssueStartWorkPrompt", () => {
  const base = {
    issue: issue(),
    statusName: "In Progress",
    projectTitle: "Pathway",
    priorityLabel: "High",
    todos: [],
    relations: [],
    issueUrl: "http://localhost:5733/issues?issue=PAT-12",
  };

  it("leads with the key and title, then the link and the metadata line", () => {
    const prompt = buildIssueStartWorkPrompt(base);
    const lines = prompt.split("\n");

    expect(lines[0]).toBe("# PAT-12 — Login test is flaky");
    expect(lines[2]).toBe("http://localhost:5733/issues?issue=PAT-12");
    expect(lines[3]).toBe("Status: In Progress · Priority: High · Project: Pathway");
  });

  it("drops every section it has nothing for", () => {
    const prompt = buildIssueStartWorkPrompt({
      ...base,
      statusName: null,
      projectTitle: null,
      priorityLabel: null,
    });

    expect(prompt).not.toContain("## Description");
    expect(prompt).not.toContain("## Checklist");
    expect(prompt).not.toContain("## Related");
    expect(prompt).not.toContain("Status:");
    expect(prompt.split("\n")[2]).toBe("http://localhost:5733/issues?issue=PAT-12");
  });

  it("writes todos as a checklist that keeps their done state", () => {
    const prompt = buildIssueStartWorkPrompt({
      ...base,
      todos: [todo("t1", "Reproduce it", 0, true), todo("t2", "Fix it", 1)],
    });

    expect(prompt).toContain("## Checklist\n- [x] Reproduce it\n- [ ] Fix it");
  });

  it("names each relation from this issue's end", () => {
    const prompt = buildIssueStartWorkPrompt({
      ...base,
      relations: [
        { label: "Blocked by", key: "PAT-3", title: "Auth rewrite" },
        { label: "Sub-issue of", key: "PAT-1", title: "Login epic" },
      ],
    });

    expect(prompt).toContain(
      "## Related\n- Blocked by: PAT-3 — Auth rewrite\n- Sub-issue of: PAT-1 — Login epic",
    );
  });

  it("carries a description verbatim and names only the Pathway issue tools", () => {
    const prompt = buildIssueStartWorkPrompt({
      ...base,
      issue: issue({ description: "  It fails one run in ten.  " }),
    });

    expect(prompt).toContain("## Description\nIt fails one run in ten.");
    expect(prompt).toContain("Pathway MCP's `issues_get` tool");
    expect(prompt).toContain("`issues_update` and `issues_comment`");
    expect(prompt).toContain("`issues_comment_evidence`");
    expect(prompt).toContain("do not use Linear or another external issue tracker");
  });

  it("adds a due date to the metadata line when the issue has one", () => {
    const prompt = buildIssueStartWorkPrompt({ ...base, issue: issue({ dueDate: "2026-09-01" }) });
    expect(prompt).toContain("Due: 2026-09-01");
  });

  it("names the configured review destination without treating every finished turn as completion", () => {
    const prompt = buildIssueStartWorkPrompt({ ...base, completionStatusName: "Ready for QA" });
    expect(prompt).toContain("genuinely finished");
    expect(prompt).toContain("move it to Ready for QA");
    expect(prompt).toContain("starts its configured audits");
  });
});

describe("buildIssueTalkPrompt", () => {
  const base = {
    issue: issue({ description: "Decide whether retries belong in the client." }),
    statusName: "Todo",
    projectTitle: "Pathway",
    priorityLabel: "Medium",
    todos: [todo("t1", "Document the chosen retry boundary", 0)],
    relations: [],
    issueUrl: "http://localhost:5733/issues?issue=PAT-12",
    completionStatusName: "Done",
  };

  it("carries the issue context into a user-led discussion without starting implementation", () => {
    const prompt = buildIssueTalkPrompt(base);

    expect(prompt).toContain("# PAT-12 — Login test is flaky");
    expect(prompt).toContain("## Description\nDecide whether retries belong in the client.");
    expect(prompt).toContain("## Checklist\n- [ ] Document the chosen retry boundary");
    expect(prompt).toContain("I want to talk through PAT-12");
    expect(prompt).toContain("`issues_link_thread`");
    expect(prompt).toContain("Do not begin implementation unless I explicitly ask");
    expect(prompt).toContain("`issues_update` and `issues_comment`");
    expect(prompt).not.toContain("move it to Done");
  });
});

describe("buildIssuesTalkPrompt", () => {
  it("links every selected issue and makes the discussion explicitly non-implementing", () => {
    const prompt = buildIssuesTalkPrompt(
      [
        issue(),
        issue({ id: IssueId.make("i2"), key: "PAT-18", title: "Retries hide auth failures" }),
      ],
      "http://localhost:5733",
    );

    expect(prompt).toContain("# Talk through 2 selected issues");
    expect(prompt).toContain("[PAT-12 — Login test is flaky]");
    expect(prompt).toContain("issues?issue=PAT-12");
    expect(prompt).toContain("[PAT-18 — Retries hide auth failures]");
    expect(prompt).toContain("issues?issue=PAT-18");
    expect(prompt).toContain("reading each issue with Pathway MCP's `issues_get` tool");
    expect(prompt).toContain("link this thread to each one with `issues_link_thread`");
    expect(prompt).toContain("Use each issue's own project as its context");
    expect(prompt).toContain("treat an issue without a project as a global question");
    expect(prompt).toContain("Do not begin implementation unless I explicitly ask");
  });

  it("hosts the chat in an issue project when available and otherwise falls back globally", () => {
    const connectedProject = ProjectId.make("connected");
    const fallbackProject = ProjectId.make("fallback");

    expect(
      issueTalkHostProjectId(
        [issue({ projectId: null }), issue({ projectId: connectedProject })],
        [fallbackProject, connectedProject],
      ),
    ).toBe(connectedProject);
    expect(issueTalkHostProjectId([issue({ projectId: null })], [fallbackProject])).toBe(
      fallbackProject,
    );
  });
});

describe("issueStartWorkTodos", () => {
  it("orders by position with the id breaking a tie", () => {
    const ordered = issueStartWorkTodos([
      todo("b", "second", 1),
      todo("a", "first", 0),
      todo("c", "also first", 0),
    ]);
    expect(ordered.map((each) => each.id)).toEqual(["a", "c", "b"]);
  });
});

describe("issueStartWorkAttachmentIds", () => {
  it("keeps image order, deduplicates, and respects the first-turn attachment limit", () => {
    const attachmentIds = Array.from({ length: 9 }, (_, index) =>
      ChatAttachmentId.make(`image-${index}`),
    );
    const comments = [
      {
        id: IssueCommentId.make("comment-1"),
        issueId: IssueId.make("i1"),
        author: { kind: "user" as const },
        body: "screenshots",
        attachmentIds: [attachmentIds[0]!, ...attachmentIds],
        createdAt: NOW,
        editedAt: null,
      },
    ];

    expect(issueStartWorkAttachmentIds(comments)).toEqual(attachmentIds.slice(0, 8));
  });
});

describe("loadIssueStartWorkImages", () => {
  it("keeps readable images in order and skips broken, non-image, and video attachments", async () => {
    const requested: string[] = [];
    const images = await loadIssueStartWorkImages(
      [
        "https://pathway.test/first.png",
        "https://pathway.test/missing.png",
        "https://pathway.test/notes.txt",
        "https://pathway.test/recording.webm",
        "https://pathway.test/last.jpg",
      ],
      async (url) => {
        requested.push(url);
        if (url.endsWith("/missing.png")) throw new Error("network failure");
        return {
          ok: true,
          blob: async () =>
            new Blob([url], { type: url.endsWith("/notes.txt") ? "text/plain" : "image/png" }),
        };
      },
    );

    expect(requested).toEqual([
      "https://pathway.test/first.png",
      "https://pathway.test/missing.png",
      "https://pathway.test/notes.txt",
      "https://pathway.test/last.jpg",
    ]);
    expect(images.map(({ sourceIndex }) => sourceIndex)).toEqual([0, 4]);
  });

  it("returns no images instead of failing when every response is unreadable", async () => {
    await expect(
      loadIssueStartWorkImages(["broken.png"], async () => ({
        ok: false,
        blob: async () => new Blob([], { type: "image/png" }),
      })),
    ).resolves.toEqual([]);
  });
});

describe("resolveIssueStartWorkStatusId", () => {
  const status = (id: string, category: "backlog" | "unstarted" | "started") => ({
    id: IssueStatusId.make(id),
    name: id,
    color: "#2563eb",
    category,
    position: 0,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const statuses = [
    status("backlog", "backlog"),
    status("todo", "unstarted"),
    status("doing", "started"),
  ];

  it("uses the configured work-started transition", () => {
    expect(
      resolveIssueStartWorkStatusId({
        configuredStatusId: IssueStatusId.make("todo"),
        statuses,
      }),
    ).toBe("todo");
  });

  it("falls back to active work, then Todo-like work", () => {
    expect(resolveIssueStartWorkStatusId({ configuredStatusId: null, statuses })).toBe("doing");
    expect(
      resolveIssueStartWorkStatusId({
        configuredStatusId: IssueStatusId.make("missing"),
        statuses: statuses.slice(0, 2),
      }),
    ).toBe("todo");
  });
});
