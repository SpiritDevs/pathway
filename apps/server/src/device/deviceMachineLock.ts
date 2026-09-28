// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - coordinates independent Node servers using the host filesystem and PID identity.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HostProcessEnvironment } from "@spiritdevs/shared/hostProcess";
import * as NodeOS from "node:os";

const Owner = Schema.Struct({ pid: Schema.Int, identity: Schema.optional(Schema.String) });
const decodeOwner = Schema.decodeUnknownSync(Schema.fromJsonString(Owner));

/** PID reuse must not preserve an expired owner. Unavailable identity probes fail closed. */
export function processIdentity(pid: number): string | null {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return null;
    return "unknown";
  }
  try {
    return (
      NodeChildProcess.execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        timeout: 5000,
        env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      }).trim() || "unknown"
    );
  } catch {
    return "unknown";
  }
}

export function isMachineOwnerAlive(owner: typeof Owner.Type) {
  const current = processIdentity(owner.pid);
  return (
    current !== null &&
    (!owner.identity ||
      owner.identity === "unknown" ||
      current === "unknown" ||
      current === owner.identity)
  );
}

export const machineOwner = () => ({
  pid: process.pid,
  identity: processIdentity(process.pid) ?? "unknown",
});

/** Shared by install, usage registration, reclamation and simulator ownership transactions. */
export async function withMachineLock<T>(
  root: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  await NodeFSP.mkdir(root, { recursive: true });
  const lock = NodePath.join(root, ".maintenance-lock");
  const nonce = NodeCrypto.randomUUID();
  const candidate = `${lock}.${nonce}`;
  const ownerFile = `${process.pid}.${nonce}.json`;
  const removeEmpty = async () => {
    await NodeFSP.rmdir(lock).catch((error: NodeJS.ErrnoException) => {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST", "EPERM"].includes(error.code ?? "")) throw error;
    });
  };
  await NodeFSP.mkdir(candidate);
  const deadline = Date.now() + 660_000;
  try {
    await NodeFSP.writeFile(NodePath.join(candidate, ownerFile), JSON.stringify(machineOwner()));
    while (true) {
      signal?.throwIfAborted();
      try {
        await NodeFSP.rename(candidate, lock);
        break;
      } catch (error) {
        if (
          !["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw error;
        const files = await NodeFSP.readdir(lock).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return [];
        });
        if (files.length === 1) {
          const previousFile = NodePath.join(lock, files[0]!);
          const previous = await NodeFSP.readFile(previousFile, "utf8")
            .then(decodeOwner)
            .catch(() => null);
          if (previous && !isMachineOwnerAlive(previous))
            await NodeFSP.unlink(previousFile).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
            });
        }
        await removeEmpty();
        if (Date.now() >= deadline)
          throw new Error(
            "Device tools are locked by another process. Retry after its operation finishes.",
            { cause: error },
          );
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      signal?.throwIfAborted();
      return await operation();
    } finally {
      await NodeFSP.unlink(NodePath.join(lock, ownerFile));
      await removeEmpty();
    }
  } finally {
    await NodeFSP.rm(candidate, { recursive: true, force: true });
  }
}

/** All environments on the same OS account share immutable helper installs. */
export const deviceCacheBaseDir = Effect.gen(function* () {
  const environment = yield* HostProcessEnvironment;
  return (
    environment.PATHWAY_DEVICE_CACHE_DIR ||
    NodePath.join(
      environment.HOME || environment.USERPROFILE || NodeOS.homedir(),
      ".pathway",
      "device-cache",
    )
  );
});

/** Register before exposing an entry path, while holding the same lock as pruning. */
export async function retainDeviceTool(root: string, name: string, version: string) {
  const directory = NodePath.join(root, ".users");
  await NodeFSP.mkdir(directory, { recursive: true });
  const record = { ...machineOwner(), name, version };
  const file = NodePath.join(directory, `${process.pid}.${name}.${version}.json`);
  const temporary = file + "." + NodeCrypto.randomUUID() + ".pending";
  await NodeFSP.writeFile(temporary, JSON.stringify(record));
  await NodeFSP.rename(temporary, file);
}
