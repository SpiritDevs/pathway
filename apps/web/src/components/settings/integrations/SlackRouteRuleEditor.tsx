import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { cn, randomUUID } from "~/lib/utils";

import {
  appendSlackConditionNode,
  removeSlackConditionNode,
  slackConditionSummary,
  slackRuleRequiresProject,
  updateSlackConditionNode,
  type SlackAssignmentPolicy,
  type SlackConditionGroup,
  type SlackConditionLeaf,
  type SlackConditionNode,
  type SlackCycleOption,
  type SlackInvestigationPolicy,
  type SlackProjectOption,
  type SlackRoutingRule,
  type SlackStatusOption,
  type SlackTeamOption,
} from "./slackWorkspaceWizard.logic";

const NONE_VALUE = "__none__";
const COMPANY_VALUE = "__company__";
const TRIAGE_VALUE = "__triage__";
const EMPTY_CYCLES: readonly SlackCycleOption[] = [];

function createViewId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function newConditionLeaf(type: SlackConditionLeaf["type"]): SlackConditionLeaf {
  const id = createViewId("condition");
  switch (type) {
    case "prefix":
      return { id, type, prefixes: [] };
    case "reaction":
      return { id, type, emoji: "" };
    case "botMention":
    case "everyMessage":
      return { id, type };
  }
}

function replaceLeafType(
  node: SlackConditionLeaf,
  type: SlackConditionLeaf["type"],
): SlackConditionLeaf {
  return { ...newConditionLeaf(type), id: node.id };
}

interface ConditionTreeEditorProps {
  readonly root: SlackConditionGroup;
  readonly group: SlackConditionGroup;
  readonly depth: number;
  readonly disabled: boolean;
  readonly onChange: (condition: SlackConditionGroup) => void;
  readonly onDeleteGroup?: () => void;
}

function ConditionTreeEditor({
  root,
  group,
  depth,
  disabled,
  onChange,
  onDeleteGroup,
}: ConditionTreeEditorProps) {
  const replaceNode = (node: SlackConditionNode) => {
    onChange(updateSlackConditionNode(root, node.id, node) as SlackConditionGroup);
  };

  return (
    <div className={cn("space-y-2", depth > 0 && "border-s border-border ps-3")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Match</span>
        <Select
          disabled={disabled}
          onValueChange={(value) =>
            replaceNode({ ...group, operator: value === "any" ? "any" : "all" })
          }
          value={group.operator}
        >
          <SelectTrigger className="w-28" size="xs">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="any">Any</SelectItem>
          </SelectPopup>
        </Select>
        <span className="text-xs text-muted-foreground">of these conditions</span>
        <span className="flex-1" />
        <Button
          disabled={disabled}
          onClick={() =>
            onChange(appendSlackConditionNode(root, group.id, newConditionLeaf("prefix")))
          }
          size="xs"
          type="button"
          variant="ghost"
        >
          <PlusIcon /> Condition
        </Button>
        <Button
          disabled={disabled}
          onClick={() =>
            onChange(
              appendSlackConditionNode(root, group.id, {
                id: createViewId("group"),
                type: "group",
                operator: "all",
                children: [],
              }),
            )
          }
          size="xs"
          type="button"
          variant="ghost"
        >
          <PlusIcon /> Group
        </Button>
        {onDeleteGroup ? (
          <Button
            aria-label="Delete condition group"
            disabled={disabled}
            onClick={onDeleteGroup}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <Trash2Icon />
          </Button>
        ) : null}
      </div>

      {group.children.length === 0 ? (
        <button
          className="w-full rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground outline-none hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring"
          disabled={disabled}
          onClick={() =>
            onChange(appendSlackConditionNode(root, group.id, newConditionLeaf("prefix")))
          }
          type="button"
        >
          Add the first condition
        </button>
      ) : (
        <div className="space-y-2">
          {group.children.map((node) =>
            node.type === "group" ? (
              <ConditionTreeEditor
                disabled={disabled}
                depth={depth + 1}
                group={node}
                key={node.id}
                onChange={onChange}
                onDeleteGroup={() => onChange(removeSlackConditionNode(root, node.id))}
                root={root}
              />
            ) : (
              <ConditionLeafEditor
                disabled={disabled}
                key={node.id}
                node={node}
                onChange={replaceNode}
                onDelete={() => onChange(removeSlackConditionNode(root, node.id))}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function ConditionLeafEditor({
  node,
  disabled,
  onChange,
  onDelete,
}: {
  readonly node: SlackConditionLeaf;
  readonly disabled: boolean;
  readonly onChange: (node: SlackConditionLeaf) => void;
  readonly onDelete: () => void;
}) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border/70 bg-background/40 p-2">
      <Select
        disabled={disabled}
        onValueChange={(value) =>
          onChange(replaceLeafType(node, value as SlackConditionLeaf["type"]))
        }
        value={node.type}
      >
        <SelectTrigger className="w-32 shrink-0" size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value="prefix">Starts with</SelectItem>
          <SelectItem value="reaction">Reaction</SelectItem>
          <SelectItem value="botMention">Bot mention</SelectItem>
          <SelectItem value="everyMessage">Every message</SelectItem>
        </SelectPopup>
      </Select>
      <div className="min-w-0 flex-1">
        {node.type === "prefix" ? (
          <div className="space-y-1">
            <Input
              aria-label="Message prefixes"
              disabled={disabled}
              onChange={(event) =>
                onChange({
                  ...node,
                  prefixes: event.currentTarget.value.split(/[,\n]/).map((prefix) => prefix.trim()),
                })
              }
              placeholder="bug:, support:, request:"
              size="sm"
              value={node.prefixes.join(", ")}
            />
            <p className="text-[11px] text-muted-foreground">
              Comma-separated, case-insensitive. The longest matching prefix is removed.
            </p>
          </div>
        ) : node.type === "reaction" ? (
          <Input
            aria-label="Slack reaction"
            disabled={disabled}
            onChange={(event) => onChange({ ...node, emoji: event.currentTarget.value })}
            placeholder="ticket"
            size="sm"
            value={node.emoji}
          />
        ) : (
          <p className="px-1 py-1 text-xs text-muted-foreground">
            {node.type === "botMention"
              ? "Matches messages that mention the connected Slack bot."
              : "Matches any message not claimed by an earlier route."}
          </p>
        )}
      </div>
      <Button
        aria-label="Delete condition"
        disabled={disabled}
        onClick={onDelete}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        <Trash2Icon />
      </Button>
    </div>
  );
}

export interface SlackRouteRuleEditorProps {
  readonly rule: SlackRoutingRule;
  readonly index: number;
  readonly ruleCount: number;
  readonly expanded: boolean;
  readonly disabled?: boolean;
  readonly teams: readonly SlackTeamOption[];
  readonly projects: readonly SlackProjectOption[];
  readonly statuses: readonly SlackStatusOption[];
  readonly cycles?: readonly SlackCycleOption[];
  readonly error?: string | null;
  readonly onChange: (rule: SlackRoutingRule) => void;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly onMove: (direction: "up" | "down") => void;
  readonly onDelete: () => void;
}

export function SlackRouteRuleEditor({
  rule,
  index,
  ruleCount,
  expanded,
  disabled = false,
  teams,
  projects,
  statuses,
  cycles = EMPTY_CYCLES,
  error,
  onChange,
  onExpandedChange,
  onMove,
  onDelete,
}: SlackRouteRuleEditorProps) {
  const teamStatuses = statuses.filter((status) => status.teamId === rule.teamId);
  const teamCycles = cycles.filter((cycle) => cycle.teamId === rule.teamId);

  return (
    <section
      aria-label={`Route ${index + 1}: ${rule.name || "Untitled"}`}
      className={cn(
        "overflow-hidden rounded-xl border bg-card/30",
        error && "border-destructive/40",
      )}
    >
      <div className="flex min-h-12 items-center gap-2 px-3 py-2">
        <button
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onExpandedChange(!expanded)}
          type="button"
        >
          {expanded ? (
            <ChevronDownIcon className="size-4" />
          ) : (
            <ChevronRightIcon className="size-4" />
          )}
          <span className="grid min-w-0 gap-0.5">
            <span className="truncate text-sm font-medium">
              {index + 1}. {rule.name || "Untitled route"}
            </span>
            <span className="truncate text-[11px] text-muted-foreground">
              {slackConditionSummary(rule.condition)} ·{" "}
              {rule.teamId
                ? (teams.find((team) => team.id === rule.teamId)?.name ?? "Team")
                : "Company-wide"}
            </span>
          </span>
        </button>
        <Button
          aria-label={`Move ${rule.name || "route"} up`}
          disabled={disabled || index === 0}
          onClick={() => onMove("up")}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <ArrowUpIcon />
        </Button>
        <Button
          aria-label={`Move ${rule.name || "route"} down`}
          disabled={disabled || index === ruleCount - 1}
          onClick={() => onMove("down")}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <ArrowDownIcon />
        </Button>
        <Button
          aria-label={`Delete ${rule.name || "route"}`}
          disabled={disabled}
          onClick={onDelete}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <Trash2Icon />
        </Button>
      </div>

      {expanded ? (
        <div className="space-y-5 border-t border-border/60 px-3 py-4">
          <label className="block space-y-1">
            <span className="text-xs font-medium">Route name</span>
            <Input
              disabled={disabled}
              onChange={(event) => onChange({ ...rule, name: event.currentTarget.value })}
              placeholder="Support requests"
              value={rule.name}
            />
          </label>

          <fieldset className="space-y-2">
            <legend className="text-xs font-medium">When a Slack message matches</legend>
            <ConditionTreeEditor
              disabled={disabled}
              depth={0}
              group={rule.condition}
              onChange={(condition) => onChange({ ...rule, condition })}
              root={rule.condition}
            />
            <p className="text-[11px] text-muted-foreground">
              Routes run top to bottom. The first matching route creates one issue; unmatched
              messages are ignored.
            </p>
          </fieldset>

          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="col-span-full text-xs font-medium">Send the issue to</legend>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Team</span>
              <Select
                disabled={disabled}
                onValueChange={(value) =>
                  onChange({
                    ...rule,
                    teamId: value === COMPANY_VALUE ? null : value,
                    cycleId: null,
                    initialPlacement: { kind: "triage" },
                    investigation:
                      rule.investigation.kind === "status"
                        ? { kind: "off" }
                        : rule.investigation.kind === "off"
                          ? rule.investigation
                          : { ...rule.investigation, successStatusId: null },
                  })
                }
                value={rule.teamId ?? COMPANY_VALUE}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={COMPANY_VALUE}>Company-wide</SelectItem>
                  {teams.map((team) => (
                    <SelectItem key={team.id} value={team.id}>
                      {team.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Project</span>
              <Select
                disabled={disabled}
                onValueChange={(value) =>
                  onChange({ ...rule, projectId: value === NONE_VALUE ? null : value })
                }
                value={rule.projectId ?? NONE_VALUE}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={NONE_VALUE}>No project</SelectItem>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Initial status</span>
              <Select
                disabled={disabled}
                onValueChange={(value) => {
                  if (value === null) return;
                  onChange({
                    ...rule,
                    initialPlacement:
                      value === TRIAGE_VALUE
                        ? { kind: "triage" }
                        : { kind: "status", statusId: value },
                  });
                }}
                value={
                  rule.initialPlacement.kind === "triage"
                    ? TRIAGE_VALUE
                    : rule.initialPlacement.statusId
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={TRIAGE_VALUE}>Triage</SelectItem>
                  {teamStatuses.map((status) => (
                    <SelectItem key={status.id} value={status.id}>
                      {status.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              {!rule.teamId && teamStatuses.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  No company-wide workflow statuses are available.
                </p>
              ) : null}
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Cycle</span>
              <Select
                disabled={disabled || teamCycles.length === 0}
                onValueChange={(value) =>
                  onChange({ ...rule, cycleId: value === NONE_VALUE ? null : value })
                }
                value={rule.cycleId ?? NONE_VALUE}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={NONE_VALUE}>No cycle</SelectItem>
                  {teamCycles.map((cycle) => (
                    <SelectItem key={cycle.id} value={cycle.id}>
                      {cycle.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </label>
          </fieldset>

          {error ? (
            <p className="flex items-start gap-1.5 text-xs text-destructive" role="alert">
              <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" /> {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export interface SlackRuleAutomationEditorProps {
  readonly rule: SlackRoutingRule;
  readonly index: number;
  readonly disabled?: boolean;
  readonly projects: readonly SlackProjectOption[];
  readonly statuses: readonly SlackStatusOption[];
  readonly onChange: (rule: SlackRoutingRule) => void;
}

export function SlackRuleAutomationEditor({
  rule,
  index,
  disabled = false,
  projects,
  statuses,
  onChange,
}: SlackRuleAutomationEditorProps) {
  const teamStatuses = statuses.filter((status) => status.teamId === rule.teamId);
  const investigationTiming =
    rule.investigation.kind === "status" ? "status" : rule.investigation.kind;
  const successStatusId =
    rule.investigation.kind === "off" ? null : rule.investigation.successStatusId;

  const setInvestigation = (timing: "off" | "immediate" | "status") => {
    const next: SlackInvestigationPolicy =
      timing === "off"
        ? { kind: "off" }
        : timing === "immediate"
          ? { kind: "immediate", successStatusId }
          : { kind: "status", triggerStatusId: teamStatuses[0]?.id ?? "", successStatusId };
    onChange({
      ...rule,
      investigation: next,
      assignment:
        timing === "off" && rule.assignment === "after-investigation" ? "off" : rule.assignment,
    });
  };
  const setSuccessStatus = (value: string | null) => {
    if (value === null || rule.investigation.kind === "off") return;
    const successStatusId = value === NONE_VALUE ? null : value;
    onChange({
      ...rule,
      investigation:
        rule.investigation.kind === "immediate"
          ? { kind: "immediate", successStatusId }
          : { ...rule.investigation, successStatusId },
    });
  };

  return (
    <section className="space-y-3 border-b border-border/60 pb-4 last:border-b-0 last:pb-0">
      <div>
        <h4 className="text-sm font-medium">
          {index + 1}. {rule.name || "Untitled route"}
        </h4>
        <p className="text-[11px] text-muted-foreground">
          Configure what happens after the issue is created.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-xs font-medium">Investigate</span>
          <Select
            disabled={disabled}
            onValueChange={(value) => setInvestigation(value as "off" | "immediate" | "status")}
            value={investigationTiming}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="off">Off</SelectItem>
              <SelectItem value="immediate">Immediately</SelectItem>
              <SelectItem value="status">When status changes</SelectItem>
            </SelectPopup>
          </Select>
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium">Assign</span>
          <Select
            disabled={disabled}
            onValueChange={(value) =>
              onChange({ ...rule, assignment: value as SlackAssignmentPolicy })
            }
            value={rule.assignment}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="off">Off</SelectItem>
              <SelectItem value="immediate">Immediately</SelectItem>
              <SelectItem disabled={rule.investigation.kind === "off"} value="after-investigation">
                After investigation
              </SelectItem>
            </SelectPopup>
          </Select>
        </label>
        {rule.investigation.kind === "status" ? (
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">Start investigation at</span>
            <Select
              disabled={disabled || teamStatuses.length === 0}
              onValueChange={(value) => {
                if (value === null || rule.investigation.kind !== "status") return;
                onChange({
                  ...rule,
                  investigation: { ...rule.investigation, triggerStatusId: value },
                });
              }}
              value={rule.investigation.triggerStatusId}
            >
              <SelectTrigger>
                <SelectValue placeholder="Choose status" />
              </SelectTrigger>
              <SelectPopup>
                {teamStatuses.map((status) => (
                  <SelectItem key={status.id} value={status.id}>
                    {status.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </label>
        ) : null}
        {rule.investigation.kind !== "off" ? (
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">After a successful investigation</span>
            <Select
              disabled={disabled || teamStatuses.length === 0}
              onValueChange={setSuccessStatus}
              value={rule.investigation.successStatusId ?? NONE_VALUE}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value={NONE_VALUE}>Keep current status</SelectItem>
                {teamStatuses.map((status) => (
                  <SelectItem key={status.id} value={status.id}>
                    {status.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              Failed investigations never move the issue.
            </p>
          </label>
        ) : null}
      </div>

      {slackRuleRequiresProject(rule) ? (
        <div
          className={cn(
            "flex items-start gap-2 rounded-lg px-3 py-2 text-xs",
            rule.projectId
              ? "bg-muted/40 text-muted-foreground"
              : "bg-warning/8 text-warning-foreground",
          )}
        >
          <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {rule.projectId
              ? `Runs through ${projects.find((project) => project.id === rule.projectId)?.name ?? "the selected project"}. Assignment waits while investigation is retrying or blocked.`
              : "Choose a project in Route issues before enabling automation."}
          </span>
        </div>
      ) : null}
    </section>
  );
}
