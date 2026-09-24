import { executeAtomQuery } from "@spiritdevs/client-runtime/state/runtime";
import type { EnvironmentId, ProjectFaviconPath } from "@spiritdevs/contracts";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { assetEnvironment } from "~/state/assets";
import { readPreparedConnection } from "~/state/session";
import { resolveAssetUrl } from "./assetUrls";

/** Reads one image from a project checkout, e.g. to upload it as the project's synced icon. */
export async function readProjectImage(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly path: ProjectFaviconPath;
}): Promise<Blob> {
  const result = await executeAtomQuery(
    appAtomRegistry,
    assetEnvironment.createUrl({
      environmentId: input.environmentId,
      input: { resource: { _tag: "project-image", cwd: input.cwd, path: input.path } },
    }),
    { refresh: true, reportFailure: false },
  );
  const connection = readPreparedConnection(input.environmentId);
  const url =
    result._tag === "Success" && connection !== null
      ? resolveAssetUrl(connection.httpBaseUrl, result.value.relativeUrl)
      : null;
  const response = url === null ? null : await fetch(url);
  if (!response?.ok) throw new Error(`Could not read ${input.path} from this connection.`);
  return await response.blob();
}
