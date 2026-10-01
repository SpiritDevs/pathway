/** Rebuild with node scripts/ios/build-device-stream.mjs; verify without Node at Xcode build time via --check in CI. */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");
const bundle = NodePath.join(root, "apps/pathway-ios/Pathway/Resources/PathwayDeviceStream.bundle");
const manifestPath = NodePath.join(bundle, "manifest.json");
const hash = async (path) =>
  NodeCrypto.createHash("sha256")
    .update(await NodeFSP.readFile(path))
    .digest("hex");
if (process.argv.includes("--check")) {
  const manifest = JSON.parse(await NodeFSP.readFile(manifestPath, "utf8"));
  for (const [path, expected] of Object.entries(manifest.inputs)) {
    if ((await hash(NodePath.join(root, path))) !== expected)
      throw new Error(
        `Device stream bundle source changed: ${path}. Run node scripts/ios/build-device-stream.mjs`,
      );
  }
  for (const [path, expected] of Object.entries(manifest.outputs)) {
    if ((await hash(NodePath.join(bundle, path))) !== expected)
      throw new Error(`Device stream bundle asset changed: ${path}`);
  }
  console.log("Native device stream bundle matches its sources and assets.");
} else {
  const require = NodeModule.createRequire(NodePath.join(root, "apps/web/package.json"));
  const { build } = await import(require.resolve("vite"));
  const inputs = new Set(["scripts/ios/build-device-stream.mjs", "pnpm-lock.yaml"]);
  await build({
    root: NodePath.join(root, "apps/pathway-ios/device-stream"),
    configFile: false,
    publicDir: false,
    build: {
      outDir: bundle,
      emptyOutDir: true,
      target: "safari18",
      sourcemap: false,
      minify: true,
      lib: {
        entry: NodePath.join(root, "apps/pathway-ios/device-stream/entry.ts"),
        name: "PathwayDeviceStream",
        formats: ["iife"],
        fileName: () => "device-stream.js",
      },
    },
    plugins: [
      {
        name: "native-device-stream-source-manifest",
        generateBundle() {
          for (const id of this.getModuleIds()) {
            const path = id.split("?")[0];
            if (path.startsWith(root + "/") && !path.includes("/node_modules/"))
              inputs.add(NodePath.relative(root, path));
          }
        },
      },
    ],
  });
  await NodeFSP.writeFile(
    NodePath.join(bundle, "Info.plist"),
    '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.spiritdevs.pathway.device-stream</string><key>CFBundlePackageType</key><string>BNDL</string></dict></plist>\n',
  );
  const outputs = {};
  for (const entry of await NodeFSP.readdir(bundle, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name !== "manifest.json") {
      const path = NodePath.join(entry.parentPath, entry.name);
      outputs[NodePath.relative(bundle, path)] = await hash(path);
    }
  }
  const inputHashes = {};
  for (const path of [...inputs].sort()) inputHashes[path] = await hash(NodePath.join(root, path));
  await NodeFSP.writeFile(
    manifestPath,
    JSON.stringify({ inputs: inputHashes, outputs }, null, 2) + "\n",
  );
}
