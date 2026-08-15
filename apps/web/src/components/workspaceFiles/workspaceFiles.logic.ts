import type { ProjectEntry } from "@t3tools/contracts";

export interface FileManagerItem extends ProjectEntry {
  readonly name: string;
}

function normalizeDirectory(directory: string): string {
  return directory.replace(/^\/+|\/+$/g, "");
}

export function fileManagerBreadcrumbs(
  directory: string,
): readonly { label: string; path: string }[] {
  const segments = normalizeDirectory(directory).split("/").filter(Boolean);
  return [
    { label: "Files", path: "" },
    ...segments.map((label, index) => ({ label, path: segments.slice(0, index + 1).join("/") })),
  ];
}

export function parentDirectory(directory: string): string {
  return normalizeDirectory(directory).split("/").filter(Boolean).slice(0, -1).join("/");
}

export function listFileManagerItems(
  entries: readonly ProjectEntry[],
  directory: string,
  query: string,
): readonly FileManagerItem[] {
  const normalizedDirectory = normalizeDirectory(directory);
  const prefix = normalizedDirectory ? `${normalizedDirectory}/` : "";
  const needle = query.trim().toLocaleLowerCase();
  const found = new Map<string, FileManagerItem>();

  for (const entry of entries) {
    const path = entry.path.replace(/^\/+|\/+$/g, "");
    if (needle) {
      if (!path.toLocaleLowerCase().includes(needle)) continue;
      found.set(path, { ...entry, path, name: path.split("/").at(-1) ?? path });
      continue;
    }
    if (!path.startsWith(prefix) || path === normalizedDirectory) continue;
    const remainder = path.slice(prefix.length);
    const [name, ...tail] = remainder.split("/");
    if (!name) continue;
    const childPath = `${prefix}${name}`;
    const kind = tail.length > 0 ? "directory" : entry.kind;
    found.set(childPath, { path: childPath, name, kind });
  }

  return [...found.values()].toSorted(
    (left, right) =>
      Number(right.kind === "directory") - Number(left.kind === "directory") ||
      left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }),
  );
}

export function formatFileSize(byteLength: number): string {
  if (byteLength < 1_024) return `${byteLength} B`;
  if (byteLength < 1_048_576)
    return `${(byteLength / 1_024).toFixed(byteLength < 10_240 ? 1 : 0)} KB`;
  return `${(byteLength / 1_048_576).toFixed(byteLength < 10_485_760 ? 1 : 0)} MB`;
}
