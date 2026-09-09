import { useAtomValue } from "@effect/atom-react";
import { managedRelaySessionAtom } from "@spiritdevs/client-runtime/relay";
import { DEFAULT_STORAGE_POLICY, StoragePolicy } from "@spiritdevs/contracts";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useState } from "react";

const decodePolicy = Schema.decodeUnknownSync(Schema.fromJsonString(StoragePolicy));

/** A saved template never enables deletion on an environment until explicitly applied. */
export function useStorageDefaultPolicy() {
  const accountId = useAtomValue(managedRelaySessionAtom)?.accountId ?? null;
  const [saved, setSaved] = useState<{ accountId: string; policy: StoragePolicy } | null>(null);
  useEffect(() => {
    if (!accountId) return;
    try {
      const raw = localStorage.getItem(`pathway:storage-default-policy:${accountId}`);
      setSaved({ accountId, policy: raw ? decodePolicy(raw) : DEFAULT_STORAGE_POLICY });
    } catch {
      setSaved({ accountId, policy: DEFAULT_STORAGE_POLICY });
    }
  }, [accountId]);
  const saveDefaultPolicy = useCallback(
    (policy: StoragePolicy) => {
      if (!accountId) throw new Error("Sign in to save cleanup defaults.");
      localStorage.setItem(`pathway:storage-default-policy:${accountId}`, JSON.stringify(policy));
      setSaved({ accountId, policy });
    },
    [accountId],
  );
  return {
    defaultPolicy: saved?.accountId === accountId ? saved.policy : DEFAULT_STORAGE_POLICY,
    saveDefaultPolicy,
    canSave: accountId !== null,
  };
}
