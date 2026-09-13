import { newCommandId } from "../../lib/utils";
import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@spiritdevs/contracts";
import { CloudUploadIcon } from "lucide-react";
import { useState } from "react";
import { companyRegistryReplicasAtom } from "../../cloud/companyRegistryReplica";
import { cloudAgentThreadCompanyId } from "../../cloud/agentThreadReadModel";
import { uploadAsset, useAssetClient } from "../../cloud/assetClient";
import type { ImageLightboxAction } from "../media/ImageLightbox";
import { stackedThreadToast, toastManager } from "../ui/toast";

export function useWorkspaceAssetPublishAction(
  threadRef: ScopedThreadRef,
  getOriginalUrl: (index: number) => Promise<string>,
): ImageLightboxAction[] {
  const client = useAssetClient();
  const replicas = useAtomValue(companyRegistryReplicasAtom);
  const companyId = cloudAgentThreadCompanyId(
    replicas,
    threadRef.environmentId,
    threadRef.threadId,
  );
  const [pending, setPending] = useState(false);
  const [requests] = useState(() => new Map<number, string>());
  const [published, setPublished] = useState(() => new Set<number>());
  if (!client || !companyId) return [];
  return [
    {
      id: "publish-workspace-asset",
      label: pending ? "Uploading…" : "Make available across devices",
      icon: CloudUploadIcon,
      disabled: pending,
      onSelect: (image, index) => {
        if (pending) return;
        if (published.has(index)) {
          toastManager.add(
            stackedThreadToast({ type: "success", title: "Already saved in this thread’s Assets" }),
          );
          return;
        }
        setPending(true);
        void (async () => {
          const url = await getOriginalUrl(index);
          const response = await fetch(url);
          if (!response.ok)
            throw new Error("The original file could not be downloaded from the environment.");
          const maximum = 250 * 1024 * 1024;
          if (Number(response.headers.get("content-length")) > maximum)
            throw new Error("Files can be up to 250 MB.");
          const reader = response.body?.getReader();
          if (!reader) throw new Error("The original file has no content.");
          const chunks: Uint8Array<ArrayBuffer>[] = [];
          let size = 0;
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > maximum) throw new Error("Files can be up to 250 MB.");
              chunks.push(new Uint8Array(value));
            }
          } finally {
            await reader.cancel();
          }
          const file = new File(chunks, image.name, {
            type: response.headers.get("content-type")?.split(";")[0] || "application/octet-stream",
          });
          const requestId = requests.get(index) ?? newCommandId();
          requests.set(index, requestId);
          await uploadAsset(
            client,
            {
              companyId,
              file,
              clientRequestId: requestId,
              context: {
                kind: "thread",
                id: threadRef.threadId,
                environmentId: threadRef.environmentId,
              },
            },
            () => {},
          );
          setPublished((current) => new Set(current).add(index));
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: "Saved in this thread’s Assets",
              description: "Available to people who can access this thread.",
            }),
          );
        })()
          .catch((reason: unknown) =>
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Could not save asset",
                description: reason instanceof Error ? reason.message : "Please try again.",
              }),
            ),
          )
          .finally(() => setPending(false));
      },
    },
  ];
}
