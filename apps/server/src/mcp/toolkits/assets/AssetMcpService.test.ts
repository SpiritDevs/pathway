// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the real Node streaming file boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, it, expect } from "vite-plus/test";
import {
  prepareLocalAsset,
  assetReference,
  assetMimeType,
  assetManagementArgs,
} from "./AssetMcpService.ts";
import {
  PATHWAY_MCP_TOOL_NAMES,
  PATHWAY_READ_ONLY_MCP_TOOL_NAMES,
} from "../../PathwayMcpToolCatalog.ts";
async function withWorkspace(run: (root: string, base: string) => Promise<void>) {
  const base = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pathway-asset-publish-"));
  const root = NodePath.join(base, "workspace");
  await NodeFSP.mkdir(root);
  try {
    await run(root, base);
  } finally {
    await NodeFSP.rm(base, { recursive: true, force: true });
  }
}
describe("agent asset publication", () => {
  it("hashes actual local bytes and resolves relative paths", async () =>
    withWorkspace(async (root) => {
      const bytes = Buffer.from("requested report");
      await NodeFSP.writeFile(NodePath.join(root, "report.txt"), bytes);
      const file = await prepareLocalAsset("report.txt", root);
      expect(file.byteSize).toBe(bytes.length);
      expect(file.checksum).toBe(NodeCrypto.createHash("sha256").update(bytes).digest("hex"));
    }));
  it("rejects traversal and symlinks outside the workspace", async () =>
    withWorkspace(async (root, base) => {
      await NodeFSP.writeFile(NodePath.join(base, "private.txt"), "private");
      await NodeFSP.symlink(NodePath.join(base, "private.txt"), NodePath.join(root, "linked.txt"));
      await expect(prepareLocalAsset("../private.txt", root)).rejects.toThrow(
        "inside this thread's workspace",
      );
      await expect(prepareLocalAsset("linked.txt", root)).rejects.toThrow(
        "inside this thread's workspace",
      );
    }));
  it("rejects folders and empty files", async () =>
    withWorkspace(async (root) => {
      await NodeFSP.writeFile(NodePath.join(root, "empty.txt"), "");
      await expect(prepareLocalAsset("empty.txt", root)).rejects.toThrow("nonempty regular file");
      await expect(prepareLocalAsset(".", root)).rejects.toThrow("nonempty regular file");
    }));
  it("returns a stable escaped identity and detects common formats", () => {
    expect(assetReference("company", "asset/one")).toBe("pathway-asset:company/asset%2Fone");
    expect(assetMimeType("Recording.MP4")).toBe("video/mp4");
    expect(assetMimeType("data.unknown")).toBe("application/octet-stream");
  });
  it("registers upload as a mutating tool for providers", () => {
    expect(PATHWAY_MCP_TOOL_NAMES).toEqual(
      expect.arrayContaining(["assets_upload", "assets_get", "assets_list", "assets_read"]),
    );
    expect(PATHWAY_READ_ONLY_MCP_TOOL_NAMES).not.toContain("assets_upload");
    expect(PATHWAY_READ_ONLY_MCP_TOOL_NAMES).toContain("assets_get");
  });
});

describe("thread-scoped asset management", () => {
  const context = { kind: "thread" as const, id: "thread", environmentId: "environment" };
  it.each(["detach", "trash", "share", "revoke", "attach"] as const)(
    "requires recorded instruction for %s",
    (operation) => {
      expect(() =>
        assetManagementArgs("company", context, { assetId: "asset", operation }),
      ).toThrow("explicit user instruction");
      expect(() =>
        assetManagementArgs("company", context, {
          assetId: "asset",
          operation,
          explicitUserInstruction: false,
        }),
      ).toThrow();
    },
  );
  it("keeps authority at the cloud boundary rather than adding an impersonated user", () => {
    const args = assetManagementArgs("company", context, {
      assetId: "asset",
      operation: "share",
      expiresInDays: 7,
      explicitUserInstruction: true,
    });
    expect(args).toEqual({
      companyId: "company",
      context,
      assetId: "asset",
      operation: "share",
      expiresInDays: 7,
      explicitUserInstruction: true,
    });
    expect(args).not.toHaveProperty("membershipId");
  });
  it("limits reuse to a message binding in the current environment and thread", () => {
    expect(
      assetManagementArgs("company", context, {
        assetId: "asset",
        operation: "attach",
        messageId: "message",
        explicitUserInstruction: true,
      }).context,
    ).toEqual({ ...context, messageId: "message" });
  });
  it("registers every management operation as mutating", () => {
    const names = [
      "assets_attach",
      "assets_rename",
      "assets_detach",
      "assets_trash",
      "assets_restore",
      "assets_share",
      "assets_revoke_share",
      "assets_retry",
    ];
    expect(PATHWAY_MCP_TOOL_NAMES).toEqual(expect.arrayContaining(names));
    for (const name of names) expect(PATHWAY_READ_ONLY_MCP_TOOL_NAMES).not.toContain(name);
  });
});
