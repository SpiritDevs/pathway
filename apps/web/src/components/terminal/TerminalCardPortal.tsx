import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";

export function TerminalCardPortal({
  children,
  detached,
}: {
  children: ReactNode;
  detached: boolean;
}) {
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!detached) return;
    setHost(document.querySelector<HTMLElement>("[data-terminal-card-host]"));
  }, [detached]);

  if (!detached) return children;
  if (host === null) return null;

  return createPortal(children, host);
}
