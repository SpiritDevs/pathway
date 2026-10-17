/** Keeps navigation evidence readable without recording signed asset URLs or URL credentials. */
export function rendererDiagnosticText(text: string): string {
  return text
    .replace(/(?:https?|pathway(?:-dev)?):\/\/[^\s"'<>]+|\/api\/assets\/[^\s"'<>]+/g, (value) => {
      if (value.startsWith("/")) return value.split(/[?#]/, 1)[0] ?? "";
      try {
        const url = new URL(value);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.href;
      } catch {
        return "[invalid URL]";
      }
    })
    .replace(/\/api\/assets\/[^/\s"'<>?#]+/g, "/api/assets/[redacted]")
    .slice(0, 4_096);
}
