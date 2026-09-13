import type { ComponentProps } from "react";

export function GhosttyIcon(props: ComponentProps<"svg">) {
  return (
    <svg viewBox="0 0 32 32" fill="none" {...props}>
      <image href="/ghostty.png" width="32" height="32" />
    </svg>
  );
}
