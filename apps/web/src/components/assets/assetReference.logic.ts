/** Stable identity only. Signed delivery URLs never become message references. */
export function parseAssetReference(
  value: string | undefined,
): { companyId: string; assetId: string } | null {
  const match = /^pathway-asset:([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)$/.exec(value ?? "");
  return match?.[1] && match[2] ? { companyId: match[1], assetId: match[2] } : null;
}
