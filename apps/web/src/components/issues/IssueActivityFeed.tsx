/**
 * The change log, read back as a story.
 *
 * Every mutation writes an `issue_events` row, which is why this list is also the audit trail for
 * agent writes: an agent that completes or deletes something leaves the same row a person does,
 * named by its provider.
 *
 * @module components/issues/IssueActivityFeed
 */
import type { IssueEvent } from "@spiritdevs/contracts";
import { useMemo } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { formatChatTimestampTooltip, formatRelativeTimeLabel } from "~/timestampFormat";
import { PROVIDER_CLIENT_DEFINITIONS } from "../settings/providerDriverMeta";
import { IssueAssigneeGlyph } from "./IssueGlyphs";
import { describeIssueEvent, sortIssueEvents, type IssueEventNaming } from "./issueDetail.logic";
import { useIssueMemberDirectory } from "./issueMemberDirectory";

const PROVIDER_LABELS: ReadonlyMap<string, string> = new Map(
  PROVIDER_CLIENT_DEFINITIONS.map((definition) => [definition.value, definition.label]),
);

/** The feed's glyph column: a person, a provider mark, or the dashed circle a system write gets. */
function ActorGlyph({
  actor,
  memberNames,
}: {
  actor: IssueEvent["actor"];
  memberNames: ReadonlyMap<string, string>;
}) {
  return (
    <IssueAssigneeGlyph
      assignee={actor.kind === "system" ? null : actor}
      className="mt-px size-5 shrink-0"
      label={actor.kind === "member" ? memberNames.get(actor.membershipId) : undefined}
    />
  );
}

export function IssueActivityFeed({
  events,
  projectTitles,
  issueKeys,
}: {
  events: ReadonlyArray<IssueEvent>;
  projectTitles: ReadonlyMap<string, string>;
  issueKeys: ReadonlyMap<string, string>;
}) {
  const directory = useIssueMemberDirectory();
  const naming = useMemo<IssueEventNaming>(
    () => ({
      projectTitles,
      providerLabels: PROVIDER_LABELS,
      memberNames: directory.names,
      issueKeys,
    }),
    [directory.names, issueKeys, projectTitles],
  );
  const ordered = useMemo(() => sortIssueEvents(events), [events]);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);

  if (ordered.length === 0) {
    return <p className="text-[13px] text-muted-foreground">No activity recorded yet.</p>;
  }

  return (
    <ol className="flex flex-col gap-2">
      {ordered.map((event) => {
        const described = describeIssueEvent(event, naming);
        return (
          <li className="flex items-start gap-2 text-[13px]" key={event.id}>
            <ActorGlyph actor={event.actor} memberNames={directory.names} />
            <p className="min-w-0 flex-1 text-muted-foreground">
              <span className="font-medium text-foreground">{described.actor}</span>{" "}
              {described.summary}{" "}
              <time
                className="whitespace-nowrap text-muted-foreground/70"
                dateTime={event.createdAt}
                title={formatChatTimestampTooltip(event.createdAt, timestampFormat)}
              >
                {formatRelativeTimeLabel(event.createdAt)}
              </time>
            </p>
          </li>
        );
      })}
    </ol>
  );
}
