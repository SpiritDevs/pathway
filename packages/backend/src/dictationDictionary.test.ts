import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, it } from "vite-plus/test";
import schema from "../convex/schema.ts";
import type { DictationDictionaryList } from "@spiritdevs/contracts/dictation";

const modules = {
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/dictationDictionary.ts": () => import("../convex/dictationDictionary.ts"),
};
const read = makeFunctionReference<
  "query",
  Record<string, never>,
  { revision: number; lists: readonly DictationDictionaryList[] }
>("dictationDictionary:read");
const save = makeFunctionReference<
  "mutation",
  { revision: number; lists: readonly DictationDictionaryList[] },
  number
>("dictationDictionary:save");
const lists = [
  {
    id: "personal",
    name: "Personal",
    terms: [{ id: "pathway", spelling: "Pathway", aliases: ["path way"] }],
  },
];

async function fixture() {
  const t = convexTest(schema, modules);
  for (const subject of ["user-a", "user-b"])
    await t.run((ctx) =>
      ctx.db.insert("users", {
        clerkSubject: subject,
        email: `${subject}@example.test`,
        displayName: subject,
        imageUrl: null,
        createdAt: 1,
        updatedAt: 1,
      }),
    );
  return {
    t,
    a: t.withIdentity({ subject: "user-a", issuer: "https://clerk.example.test" }),
    b: t.withIdentity({ subject: "user-b", issuer: "https://clerk.example.test" }),
  };
}
describe("personal dictation dictionary", () => {
  it("isolates accounts and allows deleting all terms", async () => {
    const { a, b } = await fixture();
    await a.mutation(save, { revision: 0, lists });
    expect(await a.query(read, {})).toEqual({ revision: 1, lists });
    expect(await b.query(read, {})).toEqual({ revision: 0, lists: [] });
    await a.mutation(save, { revision: 1, lists: [] });
    expect((await a.query(read, {})).lists).toEqual([]);
  });
  it("rejects stale saves and conflicting aliases", async () => {
    const { a } = await fixture();
    await a.mutation(save, { revision: 0, lists });
    await expect(a.mutation(save, { revision: 0, lists: [] })).rejects.toThrow("another computer");
    await expect(
      a.mutation(save, {
        revision: 1,
        lists: [
          {
            ...lists[0]!,
            terms: [
              ...lists[0]!.terms,
              { id: "conflict", spelling: "Other", aliases: ["path way"] },
            ],
          },
        ],
      }),
    ).rejects.toThrow("more than one spelling");
  });
  it("requires an authenticated account", async () => {
    const { t } = await fixture();
    await expect(t.query(read, {})).rejects.toThrow();
    await expect(t.mutation(save, { revision: 0, lists })).rejects.toThrow();
  });
});
