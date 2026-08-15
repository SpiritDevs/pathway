import type { ChatAttachmentId, EnvironmentId, IssueId } from "@spiritdevs/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAssetUrlsState } from "~/assets/assetUrls";
import type {
  ReplicaIssueAttachment,
  ReplicaIssueAttachmentCloud,
} from "~/cloud/issueAttachmentClient";

export interface IssueAttachmentDisplay {
  readonly url: string;
  readonly fileName: string | null;
  readonly mimeType: string | null;
  readonly byteSize: number | null;
}

export interface IssueAttachmentUrlsState {
  readonly attachments: ReadonlyArray<IssueAttachmentDisplay | null>;
  /** Retry one failed signed URL once while this view remains mounted. */
  readonly refresh: (index: number) => void;
}

/** Resolves legacy assets over environment RPC and replica assets through the authorized query. */
export function useIssueAttachmentUrls(input: {
  readonly attachmentIds: ReadonlyArray<ChatAttachmentId>;
  readonly cloud: ReplicaIssueAttachmentCloud | null;
  readonly environmentId: EnvironmentId | null;
  readonly issueId: IssueId;
}): IssueAttachmentUrlsState {
  const legacyResources = useMemo(
    () =>
      input.cloud === null
        ? input.attachmentIds.map((attachmentId) => ({
            _tag: "attachment" as const,
            attachmentId,
          }))
        : [],
    [input.attachmentIds, input.cloud],
  );
  const legacy = useAssetUrlsState(
    input.cloud === null ? input.environmentId : null,
    legacyResources,
  );
  const retriedReplicaIdsRef = useRef(new Set<ChatAttachmentId>());
  const [replicaRefreshVersion, setReplicaRefreshVersion] = useState(0);
  const [replicaRows, setReplicaRows] = useState<
    ReadonlyMap<ChatAttachmentId, ReplicaIssueAttachment>
  >(new Map());

  useEffect(() => {
    let current = true;
    if (input.cloud === null || input.attachmentIds.length === 0) {
      setReplicaRows(new Map());
      return () => {
        current = false;
      };
    }
    const cloud = input.cloud;
    const batches: ChatAttachmentId[][] = [];
    for (let index = 0; index < input.attachmentIds.length; index += 8) {
      batches.push(input.attachmentIds.slice(index, index + 8));
    }
    void Promise.all(
      batches.map((attachmentIds) =>
        cloud.client.urls({
          companyId: cloud.companyId,
          issueId: input.issueId,
          attachmentIds,
        }),
      ),
    )
      .then((pages) => {
        if (!current) return;
        setReplicaRows(
          new Map(pages.flatMap((rows) => rows.map((row) => [row.attachmentId, row] as const))),
        );
      })
      .catch(() => {
        if (current) setReplicaRows(new Map());
      });
    return () => {
      current = false;
    };
  }, [input.attachmentIds, input.cloud, input.issueId, replicaRefreshVersion]);

  const refresh = useCallback(
    (index: number) => {
      if (input.cloud === null) {
        legacy.refresh(index);
        return;
      }
      const attachmentId = input.attachmentIds[index];
      if (attachmentId === undefined || retriedReplicaIdsRef.current.has(attachmentId)) return;
      retriedReplicaIdsRef.current.add(attachmentId);
      setReplicaRefreshVersion((current) => current + 1);
    },
    [input.attachmentIds, input.cloud, legacy],
  );
  const attachments = useMemo(
    () =>
      input.cloud === null
        ? legacy.urls.map((url) =>
            url === null ? null : { url, fileName: null, mimeType: null, byteSize: null },
          )
        : input.attachmentIds.map((attachmentId) => {
            const row = replicaRows.get(attachmentId);
            return row === undefined
              ? null
              : {
                  url: row.url,
                  fileName: row.fileName,
                  mimeType: row.mimeType,
                  byteSize: row.byteSize,
                };
          }),
    [input.attachmentIds, input.cloud, legacy.urls, replicaRows],
  );
  return { attachments, refresh };
}
