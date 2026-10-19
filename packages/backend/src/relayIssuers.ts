export interface RelayJwtProvider {
  readonly issuer: string;
  readonly jwks: string;
}

function normalizeIssuer(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function relayJwtProviders(
  primaryIssuer: string,
  primaryJwks: string,
  additionalIssuers = "",
): readonly RelayJwtProvider[] {
  const primary = normalizeIssuer(primaryIssuer);
  const additional = additionalIssuers
    .split(",")
    .map(normalizeIssuer)
    .filter((issuer) => issuer.length > 0 && issuer !== primary);

  return [
    { issuer: primary, jwks: primaryJwks.trim() },
    ...Array.from(new Set(additional), (issuer) => ({
      issuer,
      jwks: `${issuer}/.well-known/jwks.json`,
    })),
  ];
}

export function configuredRelayIssuers(): ReadonlySet<string> {
  const primaryIssuer = process.env.PATHWAY_RELAY_JWT_ISSUER;
  const primaryJwks = process.env.PATHWAY_RELAY_JWKS_URL;
  if (primaryIssuer === undefined || primaryJwks === undefined) return new Set();

  return new Set(
    relayJwtProviders(
      primaryIssuer,
      primaryJwks,
      process.env.PATHWAY_RELAY_JWT_ADDITIONAL_ISSUERS,
    ).map(({ issuer }) => issuer),
  );
}
