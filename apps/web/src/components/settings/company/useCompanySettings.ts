import { useAuth } from "@clerk/react";
import { useAtomValue } from "@effect/atom-react";
import type { CompanyId, MembershipId } from "@spiritdevs/contracts/company";
import { useEffect, useMemo, useState } from "react";

import { activeCompanyAtom, activeCompanyIdAtom } from "../../../cloud/activeCompany";
import { makeCompanyAdminClient, type CompanyAdminClient } from "../../../cloud/companyAdmin";
import { companyRegistryReplicasAtom } from "../../../cloud/companyRegistryReplica";
import { resolveCloudSyncConvexUrl } from "../../../cloud/publicConfig";
import { makeClerkConvexTokenFetcher } from "../../../cloud/syncTransportAuth";
import {
  companyDirectoryFromReplicaValues,
  deriveCurrentMemberPermissions,
} from "./companySettings.logic";

interface CurrentMembership {
  readonly membershipId: MembershipId;
  readonly isOwner: boolean;
}

export function useCompanySettings() {
  const { getToken, isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const activeCompany = useAtomValue(activeCompanyAtom);
  const companyId = useAtomValue(activeCompanyIdAtom);
  const replicas = useAtomValue(companyRegistryReplicasAtom);
  const replica = companyId === null ? null : (replicas.get(companyId) ?? null);
  const directory = useMemo(
    () => companyDirectoryFromReplicaValues(replica?.view.values() ?? []),
    [replica],
  );
  const convexUrl = resolveCloudSyncConvexUrl();
  const admin = useMemo<CompanyAdminClient | null>(() => {
    if (!isSignedIn || convexUrl === null) return null;
    return makeCompanyAdminClient({
      convexUrl,
      fetchToken: makeClerkConvexTokenFetcher(getToken),
    });
  }, [convexUrl, getToken, isSignedIn]);
  const [currentMembership, setCurrentMembership] = useState<CurrentMembership | null>(null);

  useEffect(() => {
    return () => {
      void admin?.close();
    };
  }, [admin]);

  useEffect(() => {
    let cancelled = false;
    setCurrentMembership(null);
    if (admin === null || companyId === null) return;
    void admin
      .listMine()
      .then((companies) => {
        if (cancelled) return;
        const company = companies.find((candidate) => candidate.id === companyId);
        setCurrentMembership(
          company ? { membershipId: company.membershipId, isOwner: company.isOwner } : null,
        );
      })
      .catch(() => {
        if (!cancelled) setCurrentMembership(null);
      });
    return () => {
      cancelled = true;
    };
  }, [admin, companyId]);

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
