import { useMemo } from "react";

import { PROVIDER_CLIENT_DEFINITIONS } from "../settings/providerDriverMeta";
import { issueAssigneeOptions, type IssueAssigneeOption } from "./issueDetail.logic";
import { useIssueMemberDirectory } from "./issueMemberDirectory";

export function useIssueAssigneeOptions(): ReadonlyArray<IssueAssigneeOption> {
  const directory = useIssueMemberDirectory();
  return useMemo(
    () =>
      issueAssigneeOptions(
        PROVIDER_CLIENT_DEFINITIONS,
        directory.assignableMembers,
        directory.currentMembershipId,
      ),
    [directory.assignableMembers, directory.currentMembershipId],
  );
}
