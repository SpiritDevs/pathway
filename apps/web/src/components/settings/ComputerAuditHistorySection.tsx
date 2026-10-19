import {
  COMPUTER_AUDIT_HISTORY_MAX_LIMIT,
  type ComputerAuditHistoryEntry,
  type ComputerGetAuditHistoryResult,
  type EnvironmentId,
} from "@spiritdevs/contracts";
import { ChevronDownIcon, MonitorIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { describeComputerToolCall } from "../../lib/computerToolPresentation";
import { cn } from "../../lib/utils";
import { computerEnvironment } from "../../state/computer";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  COMPUTER_AUDIT_EFFECT_LABELS,
  COMPUTER_AUDIT_HISTORY_PAGE_SIZE,
  computerAuditHistoryEntries,
  nextComputerAuditHistoryPage,
  type ComputerAuditHistoryPageRequest,
} from "./ComputerAuditHistorySection.logic";
import type { ComputerScopeAccess } from "./ComputerSettingsPanel.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

type AuditHistoryState = {
  readonly pages: readonly ComputerGetAuditHistoryResult[];
  readonly fetching: "first" | "next" | null;
  readonly failed: boolean;
};

const INITIAL_STATE: AuditHistoryState = { pages: [], fetching: null, failed: false };

function AuditHistoryShell({
  open,
  onToggle,
  children,
}: {
  readonly open: boolean;
  readonly onToggle: (() => void) | null;
  readonly children?: ReactNode;
}) {
  return (
    <SettingsSection
      {...searchableSetting("computer-audit-history")}
      headerAction={
        onToggle ? (
          <Button size="xs" variant="ghost" aria-expanded={open} onClick={onToggle}>
            <ChevronDownIcon className={cn("size-3.5", open && "rotate-180")} aria-hidden />
            {open ? "Hide history" : "Show history"}
          </Button>
        ) : null
      }
    >
      {children}
    </SettingsSection>
  );
}

/**
 * The environment's Computer action log. Needs `access:read`: without it the
 * RPC is never called and the section says who can read it. No polling:
 * history is read only after the user opens it, and refreshed on request.
 */
export function ComputerAuditHistorySection({
  environmentId,
  readAccess,
}: {
  readonly environmentId: EnvironmentId;
  readonly readAccess: ComputerScopeAccess;
}) {
  const [open, setOpen] = useState(false);
  // Until the session answers, offer nothing rather than a button that may be refused.
  if (readAccess === "pending") return <AuditHistoryShell open={false} onToggle={null} />;
  if (readAccess === "denied") {
    return (
      <AuditHistoryShell open={false} onToggle={null}>
        <SettingsRow
          title="Admin connection required"
          description="Audit history requires an admin connection (access:read) for this environment."
        />
      </AuditHistoryShell>
    );
  }
  return (
    <AuditHistoryShell open={open} onToggle={() => setOpen((value) => !value)}>
      {open ? <ComputerAuditHistoryBody environmentId={environmentId} /> : null}
    </AuditHistoryShell>
  );
}

function ComputerAuditHistoryBody({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const loadPage = useAtomCommand(computerEnvironment.auditHistory, { reportFailure: false });
  const [state, setState] = useState<AuditHistoryState>(INITIAL_STATE);
  // Each reset starts a new generation, so a page from before a refresh cannot
  // land in the history that replaced it.
  const generationRef = useRef(0);

  const fetchPage = useCallback(
    (request: ComputerAuditHistoryPageRequest, kind: "first" | "next") => {
      const generation = generationRef.current;
      setState((current) => ({ ...current, fetching: kind, failed: false }));
      void loadPage({ environmentId, input: request }).then((result) => {
        if (generation !== generationRef.current) return;
        setState((current) =>
          result._tag === "Success"
            ? { pages: [...current.pages, result.value], fetching: null, failed: false }
            : { ...current, fetching: null, failed: true },
        );
      });
    },
    [environmentId, loadPage],
  );

  const reset = useCallback(() => {
    generationRef.current += 1;
    setState(INITIAL_STATE);
    fetchPage({ limit: COMPUTER_AUDIT_HISTORY_PAGE_SIZE }, "first");
  }, [fetchPage]);

  useEffect(() => {
    reset();
    return () => {
      generationRef.current += 1;
    };
  }, [reset]);

  const pages = state.pages;
  const lastPage = pages.at(-1);
  const nextPage = lastPage ? nextComputerAuditHistoryPage(lastPage, pages) : undefined;
  const status = pages[0]?.status;
  const isFetching = state.fetching !== null;

  return (
    <div className="space-y-3">
      <p className="@xl/settings:px-4 px-3 text-xs text-muted-foreground">
        Recent actions across chats on this server. Read-only observations, typed text, page
        contents, and file paths are not included.
      </p>
      {state.fetching === "first" ? (
        <p className="@xl/settings:px-4 px-3 text-xs text-muted-foreground" role="status">
          Loading recent actions…
        </p>
      ) : null}
      {state.failed ? (
        <p className="@xl/settings:px-4 px-3 text-xs text-destructive" role="alert">
          Could not load recent actions. Refresh to try again.
        </p>
      ) : null}
      {status ? (
        <ComputerAuditHistoryList
          entries={computerAuditHistoryEntries(pages)}
          status={status}
          truncated={pages.some((page) => page.truncated)}
        />
      ) : null}
      <div className="@xl/settings:px-4 flex flex-wrap items-center gap-2 px-3">
        <Button size="xs" variant="outline" disabled={isFetching} onClick={reset}>
          Refresh history
        </Button>
        {nextPage && !state.failed ? (
          <Button
            size="xs"
            variant="outline"
            disabled={isFetching}
            onClick={() => fetchPage(nextPage, "next")}
          >
            {state.fetching === "next" ? "Loading…" : "Load older actions"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function ComputerAuditHistoryList(props: {
  readonly entries: readonly ComputerAuditHistoryEntry[];
  readonly status: ComputerGetAuditHistoryResult["status"];
  readonly truncated: boolean;
}) {
  const noteClassName = "@xl/settings:px-4 px-3 text-xs text-muted-foreground";
  return (
    <>
      {props.entries.length > 0 ? (
        <div role="list" aria-label="Recent Computer actions">
          {props.entries.map((entry) => (
            <div role="listitem" key={entry.id}>
              <SettingsRow
                title={
                  <span className="flex items-center gap-2">
                    <MonitorIcon className="size-4 shrink-0" aria-hidden />
                    {describeComputerToolCall({ toolName: entry.tool, args: undefined })?.summary ??
                      "Computer action"}
                  </span>
                }
                description={<time dateTime={entry.ts}>{new Date(entry.ts).toLocaleString()}</time>}
                control={
                  <span className="text-xs text-muted-foreground">
                    {COMPUTER_AUDIT_EFFECT_LABELS[entry.effect]}
                  </span>
                }
              />
            </div>
          ))}
        </div>
      ) : (
        <p className={noteClassName}>
          {props.status === "disabled"
            ? "Action history is not enabled on this server."
            : props.truncated
              ? "Older retained actions are no longer available. Refresh to see recent actions."
              : "No recorded actions yet."}
        </p>
      )}
      {props.truncated && props.entries.length > 0 ? (
        <p className={noteClassName}>
          Some earlier actions are unavailable. This is not a complete history.
        </p>
      ) : null}
      {props.entries.length >= COMPUTER_AUDIT_HISTORY_MAX_LIMIT ? (
        <p className={noteClassName}>
          Showing the latest {COMPUTER_AUDIT_HISTORY_MAX_LIMIT} loaded actions.
        </p>
      ) : null}
    </>
  );
}
