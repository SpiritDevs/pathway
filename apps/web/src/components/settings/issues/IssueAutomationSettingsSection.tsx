import { useAtomValue } from "@effect/atom-react";
import type {
  IssueAutomationAuditRule,
  IssueAutomationRoutingRule,
  IssueAutomationSettings,
  ModelSelection,
} from "@spiritdevs/contracts";
import type { CompanyId } from "@spiritdevs/contracts/company";
import {
  ISSUE_AUTOMATION_MAX_AUDITORS_PER_RULE,
  ISSUE_AUTOMATION_MAX_AUDIT_RULES,
  ISSUE_AUTOMATION_MAX_REVIEW_WORKERS,
  ISSUE_AUTOMATION_MAX_ROUTING_RULES,
  ProviderDriverKind,
} from "@spiritdevs/contracts";
import { createModelSelection } from "@spiritdevs/shared/model";
import { ChevronDownIcon, ChevronUpIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { getCustomModelOptionsByInstance } from "~/modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "~/providerInstances";
import { primaryServerProvidersAtom } from "~/state/server";
import { useCompanyIssuesStore } from "~/state/issues";
import { useCompanySettings } from "../company/useCompanySettings";
import { ProviderModelPicker } from "../../chat/ProviderModelPicker";
import { TraitsPicker } from "../../chat/TraitsPicker";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { SettingsRow, SettingsSection } from "../settingsLayout";
import { searchableSetting } from "../settingsSearch";

const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");
const NO_STATUS = "__no_status__";

function RuleTextInput({
  label,
  placeholder,
  value,
  onCommit,
}: {
  label: string;
  placeholder: string;
  value: string;
  onCommit: (value: string) => void;
}) {
  return (
    <Input
      aria-label={label}
      defaultValue={value}
      key={value}
      onBlur={(event) => {
        const next = event.currentTarget.value.trim();
        if (next.length === 0) {
          event.currentTarget.value = value;
          return;
        }
        if (next !== value) onCommit(next);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          event.currentTarget.value = value;
          event.currentTarget.blur();
        }
      }}
      placeholder={placeholder}
      size="sm"
    />
  );
}

function AutomationModelPicker({
  label,
  selection,
  onChange,
}: {
  label: string;
  selection: ModelSelection;
  onChange: (selection: ModelSelection) => void;
}) {
  const settings = usePrimarySettings();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
  );
  const entry = entries.find((candidate) => candidate.instanceId === selection.instanceId);
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    serverProviders,
    selection.instanceId,
    selection.model,
  );

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <ProviderModelPicker
        activeInstanceId={selection.instanceId}
        instanceEntries={entries}
        lockedProvider={null}
        model={selection.model}
        modelOptionsByInstance={modelOptionsByInstance}
        onInstanceModelChange={(instanceId, model) =>
          onChange(createModelSelection(instanceId, model))
        }
        triggerAriaLabel={`${label} model`}
        triggerClassName="min-w-40 max-w-none flex-1 text-foreground/90 hover:text-foreground"
        triggerVariant="outline"
      />
      <TraitsPicker
        allowPromptInjectedEffort={false}
        model={selection.model}
        modelOptions={selection.options}
        models={entry?.models ?? []}
        onModelOptionsChange={(options) =>
          onChange(createModelSelection(selection.instanceId, selection.model, options))
        }
        onPromptChange={() => {}}
        prompt=""
        provider={entry?.driverKind ?? DEFAULT_DRIVER_KIND}
        triggerClassName="min-w-28 max-w-none text-foreground/90 hover:text-foreground"
        triggerVariant="outline"
      />
    </div>
  );
}

function StatusTransitionSelect({
  statuses,
  label,
  automaticLabel,
  value,
  onChange,
}: {
  statuses: ReturnType<typeof useCompanyIssuesStore>["store"]["statuses"];
  label: string;
  automaticLabel: string;
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  const selected = statuses.find((status) => status.id === value);
  return (
    <label className="space-y-1">
      <span className="block text-[11px] font-medium text-muted-foreground">{label}</span>
      <Select
        onValueChange={(next) => next !== null && onChange(next === NO_STATUS ? null : next)}
        value={value ?? NO_STATUS}
      >
        <SelectTrigger size="sm">
          <SelectValue>{selected?.name ?? automaticLabel}</SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          <SelectItem value={NO_STATUS}>{automaticLabel}</SelectItem>
          {statuses.map((status) => (
            <SelectItem key={status.id} value={status.id}>
              {status.name}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </label>
  );
}

function RoutingRuleCard({
  rule,
  onChange,
  onDelete,
  onMoveDown,
  onMoveUp,
}: {
  rule: IssueAutomationRoutingRule;
  onChange: (rule: IssueAutomationRoutingRule) => void;
  onDelete: () => void;
  onMoveDown: (() => void) | null;
  onMoveUp: (() => void) | null;
}) {
  return (
    <div className="space-y-2 rounded-md border border-border/60 bg-background/30 p-2.5">
      <div className="@xl/settings:grid-cols-[minmax(9rem,0.55fr)_minmax(14rem,1fr)_auto] grid gap-2">
        <RuleTextInput
          label="Auto-assignment rule name"
          onCommit={(name) => onChange({ ...rule, name })}
          placeholder="UI work"
          value={rule.name}
        />
        <RuleTextInput
          label={`Condition for ${rule.name}`}
          onCommit={(condition) => onChange({ ...rule, condition })}
          placeholder="UI, frontend, styling, or accessibility work"
          value={rule.condition}
        />
        {/*
          Grid items stretch, so once the container is too narrow for the
          three-column rule layout these controls land on a row of their own and
          would otherwise span its full width. Keep them at their own size,
          trailing the fields they act on.
        */}
        <div className="flex items-center gap-0.5 justify-self-end">
          <Button
            aria-label={`Move ${rule.name} up`}
            disabled={onMoveUp === null}
            onClick={onMoveUp ?? undefined}
            size="icon-xs"
            variant="ghost"
          >
            <ChevronUpIcon className="size-3.5" />
          </Button>
          <Button
            aria-label={`Move ${rule.name} down`}
            disabled={onMoveDown === null}
            onClick={onMoveDown ?? undefined}
            size="icon-xs"
            variant="ghost"
          >
            <ChevronDownIcon className="size-3.5" />
          </Button>
          <Button
            aria-label={`Delete ${rule.name}`}
            onClick={onDelete}
            size="icon-xs"
            variant="ghost"
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        </div>
      </div>
      <AutomationModelPicker
        label={rule.name}
        onChange={(modelSelection) => onChange({ ...rule, modelSelection })}
        selection={rule.modelSelection}
      />
    </div>
  );
}

function AuditRuleCard({
  rule,
  defaultSelection,
  onChange,
  onDelete,
}: {
  rule: IssueAutomationAuditRule;
  defaultSelection: ModelSelection;
  onChange: (rule: IssueAutomationAuditRule) => void;
  onDelete: () => void;
}) {
  return (
    <div className="space-y-2.5 rounded-md border border-border/60 bg-background/30 p-2.5">
      <div className="@xl/settings:grid-cols-[minmax(9rem,0.55fr)_minmax(14rem,1fr)_auto] grid gap-2">
        <RuleTextInput
          label="Audit rule name"
          onCommit={(name) => onChange({ ...rule, name })}
          placeholder="Implementation review"
          value={rule.name}
        />
        <RuleTextInput
          label={`Condition for ${rule.name}`}
          onCommit={(condition) => onChange({ ...rule, condition })}
          placeholder="All completed implementation work"
          value={rule.condition}
        />
        <Button
          aria-label={`Delete ${rule.name}`}
          className="justify-self-end"
          onClick={onDelete}
          size="icon-xs"
          variant="ghost"
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      </div>
      <div className="space-y-1.5">
        {rule.auditors.map((auditor, index) => (
          <div className="flex items-center gap-1.5" key={auditor.id}>
            <div className="min-w-0 flex-1">
              <AutomationModelPicker
                label={`${rule.name} auditor ${index + 1}`}
                onChange={(next) =>
                  onChange({
                    ...rule,
                    auditors: rule.auditors.map((candidate, candidateIndex) =>
                      candidateIndex === index ? { ...candidate, modelSelection: next } : candidate,
                    ),
                  })
                }
                selection={auditor.modelSelection}
              />
            </div>
            <Button
              aria-label={`Remove auditor ${index + 1} from ${rule.name}`}
              disabled={rule.auditors.length === 1}
              onClick={() =>
                onChange({
                  ...rule,
                  auditors: rule.auditors.filter((_, candidateIndex) => candidateIndex !== index),
                })
              }
              size="icon-xs"
              variant="ghost"
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          </div>
        ))}
        <Button
          disabled={rule.auditors.length >= ISSUE_AUTOMATION_MAX_AUDITORS_PER_RULE}
          onClick={() =>
            onChange({
              ...rule,
              auditors: [
                ...rule.auditors,
                {
                  id: `auditor-${Date.now()}-${rule.auditors.length}`,
                  modelSelection: defaultSelection,
                },
              ],
            })
          }
          size="xs"
          variant="outline"
        >
          <PlusIcon className="size-3.5" /> Add auditor
        </Button>
      </div>
    </div>
  );
}

export function IssueAutomationSettingsSection({
  automation: externalAutomation,
  companyId: externalCompanyId,
  onSave,
}: {
  readonly automation?: IssueAutomationSettings | undefined;
  readonly companyId?: CompanyId | null | undefined;
  readonly onSave?: ((settings: IssueAutomationSettings) => void) | undefined;
} = {}) {
  const { contentCompanyId } = useCompanySettings();
  const companyId = externalCompanyId === undefined ? contentCompanyId : externalCompanyId;
  const { store } = useCompanyIssuesStore(companyId);
  const statuses = store.statuses;
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const automation = externalAutomation ?? settings.issueAutomation;
  const save = (next: IssueAutomationSettings) =>
    onSave === undefined ? updateSettings({ issueAutomation: next }) : onSave(next);
  const patch = (next: Partial<IssueAutomationSettings>) => save({ ...automation, ...next });
  const moveRoutingRule = (from: number, to: number) => {
    const routingRules = [...automation.routingRules];
    const current = routingRules[from];
    const replacement = routingRules[to];
    if (current === undefined || replacement === undefined) return;
    routingRules[from] = replacement;
    routingRules[to] = current;
    patch({ routingRules });
  };

  return (
    <SettingsSection {...searchableSetting("issue-intake-automation")}>
      <SettingsRow
        description="Channels with Auto-assign enabled use these ordered, natural-language rules. The routing model chooses the first matching worker rule and every matching audit rule; the decision and exact model are saved on the issue."
        title="Auto-assignment"
        control={
          <AutomationModelPicker
            label="Routing"
            onChange={(routingModelSelection) => patch({ routingModelSelection })}
            selection={automation.routingModelSelection}
          />
        }
      />

      <div className="@xl/settings:px-4 space-y-2 px-3">
        <div>
          <p className="text-xs font-medium text-foreground">Worker rules</p>
          <p className="text-[11px] text-muted-foreground">First matching rule wins.</p>
        </div>
        {automation.routingRules.map((rule, index) => (
          <RoutingRuleCard
            key={rule.id}
            onChange={(next) =>
              patch({
                routingRules: automation.routingRules.map((candidate, candidateIndex) =>
                  candidateIndex === index ? next : candidate,
                ),
              })
            }
            onDelete={() =>
              patch({
                routingRules: automation.routingRules.filter(
                  (_, candidateIndex) => candidateIndex !== index,
                ),
              })
            }
            onMoveDown={
              index === automation.routingRules.length - 1
                ? null
                : () => moveRoutingRule(index, index + 1)
            }
            onMoveUp={index === 0 ? null : () => moveRoutingRule(index, index - 1)}
            rule={rule}
          />
        ))}
        <Button
          disabled={automation.routingRules.length >= ISSUE_AUTOMATION_MAX_ROUTING_RULES}
          onClick={() =>
            patch({
              routingRules: [
                ...automation.routingRules,
                {
                  id: `routing-${Date.now()}-${automation.routingRules.length}`,
                  name: "New worker rule",
                  condition: "Describe when this worker should be used",
                  modelSelection: automation.routingModelSelection,
                },
              ],
            })
          }
          size="xs"
          variant="outline"
        >
          <PlusIcon className="size-3.5" /> Add worker rule
        </Button>
      </div>

      <SettingsRow
        description="Used when no worker rule matches. Leave this disabled to keep unmatched issues unassigned."
        title="Fallback worker"
        control={
          automation.fallbackModelSelection === null ? (
            <Button
              onClick={() => patch({ fallbackModelSelection: automation.routingModelSelection })}
              size="sm"
              variant="outline"
            >
              Configure fallback
            </Button>
          ) : (
            <div className="flex items-center gap-1.5">
              <AutomationModelPicker
                label="Fallback worker"
                onChange={(fallbackModelSelection) => patch({ fallbackModelSelection })}
                selection={automation.fallbackModelSelection}
              />
              <Button
                aria-label="Remove fallback worker"
                onClick={() => patch({ fallbackModelSelection: null })}
                size="icon-xs"
                variant="ghost"
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </div>
          )
        }
      />

      <div className="@xl/settings:px-4 space-y-2 px-3 pt-2">
        <div>
          <p className="text-xs font-medium text-foreground">Audit rules</p>
          <p className="text-[11px] text-muted-foreground">
            Every model on a matching rule reviews independently. Any blocking finding returns the
            issue to work with all findings; all auditors must pass before completion.
          </p>
        </div>
        {automation.auditRules.map((rule, index) => (
          <AuditRuleCard
            defaultSelection={automation.routingModelSelection}
            key={rule.id}
            onChange={(next) =>
              patch({
                auditRules: automation.auditRules.map((candidate, candidateIndex) =>
                  candidateIndex === index ? next : candidate,
                ),
              })
            }
            onDelete={() =>
              patch({
                auditRules: automation.auditRules.filter(
                  (_, candidateIndex) => candidateIndex !== index,
                ),
              })
            }
            rule={rule}
          />
        ))}
        <Button
          disabled={automation.auditRules.length >= ISSUE_AUTOMATION_MAX_AUDIT_RULES}
          onClick={() =>
            patch({
              auditRules: [
                ...automation.auditRules,
                {
                  id: `audit-${Date.now()}-${automation.auditRules.length}`,
                  name: "Implementation review",
                  condition: "All completed implementation work",
                  auditors: [
                    {
                      id: `auditor-${Date.now()}-0`,
                      modelSelection: automation.routingModelSelection,
                    },
                  ],
                },
              ],
            })
          }
          size="xs"
          variant="outline"
        >
          <PlusIcon className="size-3.5" /> Add audit rule
        </Button>
      </div>

      <div className="@xl/settings:px-4 space-y-2 px-3 pt-2">
        <div>
          <p className="text-xs font-medium text-foreground">Review workers</p>
          <p className="text-[11px] text-muted-foreground">
            When an audit requests changes, these workers run in order on the linked work thread.
            The last worker returns the issue to review. With none configured, the original worker
            handles remediation.
          </p>
        </div>
        {automation.reviewWorkers.map((worker, index) => (
          <div
            className="flex min-w-0 items-center gap-1.5 rounded-md border border-border/60 bg-background/30 p-2.5"
            key={worker.id}
          >
            <div className="min-w-0 flex-1">
              <AutomationModelPicker
                label={`Review worker ${index + 1}`}
                onChange={(modelSelection) =>
                  patch({
                    reviewWorkers: automation.reviewWorkers.map((candidate, candidateIndex) =>
                      candidateIndex === index ? { ...candidate, modelSelection } : candidate,
                    ),
                  })
                }
                selection={worker.modelSelection}
              />
            </div>
            <Button
              aria-label={`Remove review worker ${index + 1}`}
              onClick={() =>
                patch({
                  reviewWorkers: automation.reviewWorkers.filter(
                    (_, candidateIndex) => candidateIndex !== index,
                  ),
                })
              }
              size="icon-xs"
              variant="ghost"
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          </div>
        ))}
        <Button
          disabled={automation.reviewWorkers.length >= ISSUE_AUTOMATION_MAX_REVIEW_WORKERS}
          onClick={() =>
            patch({
              reviewWorkers: [
                ...automation.reviewWorkers,
                {
                  id: `review-worker-${Date.now()}-${automation.reviewWorkers.length}`,
                  modelSelection: automation.routingModelSelection,
                },
              ],
            })
          }
          size="xs"
          variant="outline"
        >
          <PlusIcon className="size-3.5" /> Add review worker
        </Button>
      </div>

      <div className="@xl/settings:grid-cols-2 @xl/settings:px-4 grid gap-2 px-3 pt-2">
        <StatusTransitionSelect
          statuses={statuses}
          automaticLabel="First Started status"
          label="When work starts"
          onChange={(workStartedStatusId) =>
            patch({ statusTransitions: { ...automation.statusTransitions, workStartedStatusId } })
          }
          value={automation.statusTransitions.workStartedStatusId}
        />
        <StatusTransitionSelect
          statuses={statuses}
          automaticLabel="First Review status"
          label="When work finishes / review begins"
          onChange={(workFinishedStatusId) =>
            patch({ statusTransitions: { ...automation.statusTransitions, workFinishedStatusId } })
          }
          value={automation.statusTransitions.workFinishedStatusId}
        />
        <StatusTransitionSelect
          statuses={statuses}
          automaticLabel="Next status after review"
          label="When every audit passes"
          onChange={(auditPassedStatusId) =>
            patch({ statusTransitions: { ...automation.statusTransitions, auditPassedStatusId } })
          }
          value={automation.statusTransitions.auditPassedStatusId}
        />
        <StatusTransitionSelect
          statuses={statuses}
          automaticLabel="Previous Started status"
          label="When an audit requests changes"
          onChange={(auditChangesRequestedStatusId) =>
            patch({
              statusTransitions: { ...automation.statusTransitions, auditChangesRequestedStatusId },
            })
          }
          value={automation.statusTransitions.auditChangesRequestedStatusId}
        />
      </div>

      <SettingsRow
        description="After this many failed review cycles, findings remain on the issue and automation stops rather than looping forever."
        title="Remediation limit"
        control={
          <Input
            aria-label="Maximum remediation cycles"
            className="w-20"
            max={10}
            min={0}
            onChange={(event) => {
              const value = Number.parseInt(event.currentTarget.value, 10);
              if (Number.isFinite(value))
                patch({ maxRemediationCycles: Math.max(0, Math.min(10, value)) });
            }}
            size="sm"
            type="number"
            value={automation.maxRemediationCycles}
          />
        }
      />
    </SettingsSection>
  );
}
