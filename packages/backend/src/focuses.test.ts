// @effect-diagnostics globalDate:off -- Test rows mirror Convex documents.
import { convexTest } from "convex-test";
import { describe, expect, it } from "vite-plus/test";

import { api } from "../convex/_generated/api.js";
import schema from "../convex/schema.ts";

const modules = {
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/focuses.ts": () => import("../convex/focuses.ts"),
};

const CLERK_ISSUER = "https://clerk.example.test";
const NOW = 1_700_000_000_000;
const WORK = "0198c0de-aaaa-7aaa-8aaa-000000000001";
const PERSONAL = "0198c0de-aaaa-7aaa-8aaa-000000000002";
const PROJECT = "environment-a:project-a";

function harness() {
  return convexTest(schema, modules);
}

type Harness = ReturnType<typeof harness>;

function asUser(t: Harness, subject: string) {
  return t.withIdentity({
    issuer: CLERK_ISSUER,
    subject,
    tokenIdentifier: `${CLERK_ISSUER}|${subject}`,
  });
}

async function seedUser(t: Harness, subject: string) {
  await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkSubject: subject,
      email: `${subject}@example.test`,
      displayName: subject,
      imageUrl: null,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );
}

const createFocus = (id: string, name: string, orderKey?: string) => ({
  id,
  name,
  iconName: "Briefcase",
  accentColor: "#3366ff",
  ...(orderKey === undefined ? {} : { orderKey }),
});

describe("Focus definitions", () => {
  it("isolates each user's Focuses and supports create, update, and reorder", async () => {
    const t = harness();
    await seedUser(t, "user-one");
    await seedUser(t, "user-two");
    const owner = asUser(t, "user-one");

    const created = await owner.mutation(api.focuses.create, createFocus(WORK, " Work "));
    expect(created).toMatchObject({ id: WORK, name: "Work", accentColor: "#3366ff" });
    await owner.mutation(api.focuses.update, {
      focusId: WORK,
      name: "Client work",
      iconName: "Building2",
      accentColor: "#AABBCC",
    });
    await owner.mutation(api.focuses.reorder, { focusId: WORK, orderKey: "a" });

    await expect(owner.query(api.focuses.list, {})).resolves.toMatchObject({
      focuses: [
        {
          id: WORK,
          name: "Client work",
          iconName: "Building2",
          accentColor: "#aabbcc",
          orderKey: "a",
        },
      ],
      assignments: [],
    });
    await expect(asUser(t, "user-two").query(api.focuses.list, {})).resolves.toEqual({
      focuses: [],
      assignments: [],
    });
    await expect(
      asUser(t, "user-two").mutation(api.focuses.update, { focusId: WORK, name: "Mine" }),
    ).rejects.toThrow("No such Focus");
  });

  it("moves an exclusive project assignment atomically and unlinks it on delete", async () => {
    const t = harness();
    await seedUser(t, "user-one");
    const owner = asUser(t, "user-one");
    await owner.mutation(api.focuses.create, createFocus(WORK, "Work", "a"));
    await owner.mutation(api.focuses.create, createFocus(PERSONAL, "Personal", "b"));

    await owner.mutation(api.focuses.assignProject, { focusId: WORK, projectKey: PROJECT });
    await owner.mutation(api.focuses.assignProject, { focusId: PERSONAL, projectKey: PROJECT });
    const moved = await owner.query(api.focuses.list, {});
    expect(moved.assignments).toEqual([
      expect.objectContaining({ focusId: PERSONAL, projectKey: PROJECT }),
    ]);

    await owner.mutation(api.focuses.remove, { focusId: PERSONAL });
    const afterDelete = await owner.query(api.focuses.list, {});
    expect(afterDelete.focuses.map((focus) => focus.id)).toEqual([WORK]);
    expect(afterDelete.assignments).toEqual([]);

    await owner.mutation(api.focuses.assignProject, { focusId: WORK, projectKey: PROJECT });
    await owner.mutation(api.focuses.unassignProject, { projectKey: PROJECT });
    await expect(owner.query(api.focuses.list, {})).resolves.toMatchObject({ assignments: [] });
  });

  it("creates initial assignments atomically and moves projects from another Focus", async () => {
    const t = harness();
    await seedUser(t, "user-one");
    const owner = asUser(t, "user-one");
    await owner.mutation(api.focuses.create, {
      ...createFocus(WORK, "Work", "a"),
      projectKeys: [PROJECT],
    });

    await owner.mutation(api.focuses.create, {
      ...createFocus(PERSONAL, "Personal", "b"),
      projectKeys: [PROJECT, "environment-a:project-b"],
    });

    const readModel = await owner.query(api.focuses.list, {});
    expect(readModel.assignments).toHaveLength(2);
    expect(readModel.assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ focusId: PERSONAL, projectKey: PROJECT }),
        expect.objectContaining({ focusId: PERSONAL, projectKey: "environment-a:project-b" }),
      ]),
    );
  });

  it("rejects empty and untrimmed Focus ids", async () => {
    const t = harness();
    await seedUser(t, "user-one");
    const owner = asUser(t, "user-one");

    await expect(owner.mutation(api.focuses.create, createFocus("", "Empty"))).rejects.toThrow(
      "A Focus id must be a trimmed non-empty string",
    );
    await expect(
      owner.mutation(api.focuses.create, createFocus(` ${WORK} `, "Untrimmed")),
    ).rejects.toThrow("A Focus id must be a trimmed non-empty string");
    await expect(owner.query(api.focuses.list, {})).resolves.toEqual({
      focuses: [],
      assignments: [],
    });
  });

  it("rejects malformed project keys in create and assignProject", async () => {
    const t = harness();
    await seedUser(t, "user-one");
    const owner = asUser(t, "user-one");

    for (const projectKey of ["", "missing-colon", ` ${PROJECT} `]) {
      await expect(
        owner.mutation(api.focuses.create, {
          ...createFocus(WORK, "Work"),
          projectKeys: [projectKey],
        }),
      ).rejects.toThrow("A Focus project key must contain an environment id and project id");
    }
    await owner.mutation(api.focuses.create, createFocus(WORK, "Work"));
    for (const projectKey of ["", "missing-colon", ` ${PROJECT} `]) {
      await expect(
        owner.mutation(api.focuses.assignProject, { focusId: WORK, projectKey }),
      ).rejects.toThrow("A Focus project key must contain an environment id and project id");
    }
    await expect(owner.query(api.focuses.list, {})).resolves.toMatchObject({ assignments: [] });
  });
});
