import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";

export function resolveTerminalCardHostSelector(fullWidth: boolean): string {
  return fullWidth ? "[data-terminal-full-width-host]" : "[data-terminal-card-host]";
}

export function TerminalCardPortal({
  children,
  detached,
  fullWidth,
}: {
  children: ReactNode;
  detached: boolean;
  fullWidth: boolean;
}) {
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!detached) return;
    setHost(document.querySelector<HTMLElement>(resolveTerminalCardHostSelector(fullWidth)));
  }, [detached, fullWidth]);

  if (!detached) return children;
  if (host === null) return null;

  return createPortal(children, host);
}
