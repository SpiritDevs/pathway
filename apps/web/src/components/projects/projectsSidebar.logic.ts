export function projectKeyFromProjectsPathname(pathname: string): string | null {
  const match = /^\/projects\/([^/]+)\/?$/.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}
