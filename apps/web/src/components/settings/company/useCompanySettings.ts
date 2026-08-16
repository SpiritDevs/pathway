import { useAuth } from "@clerk/react";
import { useAtomValue } from "@effect/atom-react";
import type { CompanyId } from "@spiritdevs/contracts/company";
import { useEffect, useMemo, useRef } from "react";

import { activeCompanyAtom, activeCompanyIdAtom } from "../../../cloud/activeCompany";
import { makeCompanyAdminClient, type CompanyAdminClient } from "../../../cloud/companyAdmin";
import {
  companyRegistryMembershipIdsAtom,
  companyRegistryReplicasAtom,
} from "../../../cloud/companyRegistryReplica";
import { resolveCloudSyncConvexUrl } from "../../../cloud/publicConfig";
import { makeClerkConvexTokenFetcher } from "../../../cloud/syncTransportAuth";
import {
  companyDirectoryFromReplicaValues,
  deriveCurrentMemberPermissions,
} from "./companySettings.logic";

export function useCompanySettings() {
  const { getToken, isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const activeCompany = useAtomValue(activeCompanyAtom);
  const companyId = useAtomValue(activeCompanyIdAtom);
  const replicas = useAtomValue(companyRegistryReplicasAtom);
  const membershipIds = useAtomValue(companyRegistryMembershipIdsAtom);
  const replica = companyId === null ? null : (replicas.get(companyId) ?? null);
  const directory = useMemo(
    () => companyDirectoryFromReplicaValues(replica?.view.values() ?? []),
    [replica],
  );
  const convexUrl = resolveCloudSyncConvexUrl();
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  const admin = useMemo<CompanyAdminClient | null>(() => {
    if (!isSignedIn || convexUrl === null) return null;
    return makeCompanyAdminClient({
      convexUrl,
      fetchToken: (args) => makeClerkConvexTokenFetcher(getTokenRef.current)(args),
    });
  }, [convexUrl, isSignedIn]);
  const currentMembership = useMemo(() => {
    if (companyId === null) return null;
    const membershipId = membershipIds.get(companyId);
    if (membershipId === undefined) return null;
    return {
      membershipId,
      isOwner:
        directory.company?.owners.some((owner) => owner.membershipId === membershipId) ?? false,
    };
  }, [companyId, directory.company?.owners, membershipIds]);

  useEffect(() => {
    return () => {
      void admin?.close();
    };
  }, [admin]);

  const permissions = useMemo(
    () =>
      deriveCurrentMemberPermissions({
        directory,
        membershipId: currentMembership?.membershipId ?? null,
        isOwner: currentMembership?.isOwner ?? null,
      }),
    [currentMembership, directory],
  );

  return {
    admin,
    activeCompany,
    companyId: companyId as CompanyId | null,
    currentMembership,
    directory,
    isAuthLoaded: isLoaded,
    isSignedIn: Boolean(isSignedIn),
    permissions,
    replica,
  };
}
