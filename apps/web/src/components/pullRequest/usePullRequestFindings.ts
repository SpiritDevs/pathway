import { squashAtomCommandFailure } from "@spiritdevs/client-runtime/state/runtime";
import type { EnvironmentId, PullRequestDetail } from "@spiritdevs/contracts";
import { useRef, useState } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import { toastManager } from "../ui/toast";
import { buildFixFindingsHandoff } from "./pullRequestDetail.logic";
import type { PullRequestThreadTask } from "./usePullRequestActions";

/** Load conversation data only when findings are requested, then hand off the complete result. */
export function usePullRequestFindings({
  environmentId,
  detail,
  startHandoff,
}: {
  environmentId: EnvironmentId;
  detail: PullRequestDetail | null;
  startHandoff: (key: string, task: PullRequestThreadTask) => Promise<unknown>;
}) {
  const loadActivity = useAtomQueryRunner(pullRequestEnvironment.activity, {
    reportFailure: false,
  });
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);

  const start = async () => {
    if (!detail || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      const result = await loadActivity({
        environmentId,
        input: {
          projectId: detail.projectId,
          repository: detail.repository,
          number: detail.number,
        },
      });
      if (result._tag === "Failure") {
        throw squashAtomCommandFailure(result);
      }
      await startHandoff(
        "findings",
        buildFixFindingsHandoff({
          number: detail.number,
          title: detail.title,
          url: detail.url,
          headBranch: detail.headBranch,
          baseBranch: detail.baseBranch,
          checks: detail.checks,
          reviewThreads: result.value.reviewThreads,
          comments: result.value.comments,
          commentsTruncated: result.value.commentsTruncated,
        }),
      );
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not prepare pull request findings",
        description: error instanceof Error ? error.message : "Try Fix findings again.",
      });
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  return { pending, start };
}
