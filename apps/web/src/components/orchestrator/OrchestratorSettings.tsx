import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import {
  ArchiveIcon,
  ArrowUpRightIcon,
  BotIcon,
  BrainIcon,
  CheckIcon,
  MessageCircleIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  SaveIcon,
  ShieldCheckIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react";
import {
  ORCHESTRATOR_CAPABILITIES,
  OrchestratorConfig,
  defaultOrchestratorConfig,
  type AiOrchestrator,
  type OrchestratorMemory,
} from "@spiritdevs/contracts/aiOrchestrator";
import * as Schema from "effect/Schema";
import type { Value } from "convex/values";
import { companyListAtom } from "../../cloud/activeCompany";
import { useEnvironments } from "../../state/environments";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import {
  Dialog,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  DialogHeader,
  DialogFooter,
} from "../ui/dialog";
import { SettingsPageContainer } from "../settings/settingsLayout";
import { useOrchestrators, useOrchestratorQuery } from "./OrchestratorContext";
import { OrchestratorAvatar, ORCHESTRATOR_COLORS } from "./OrchestratorAvatar";
import { OrchestratorModels } from "./OrchestratorModels";

export const ORCHESTRATOR_SETTINGS = {
  overview: "Overview",
  instructions: "Instructions",
  models: "Models",
  environments: "Environments",
  responsibilities: "Responsibilities",
  permissions: "Permissions",
  memory: "Memory",
  notifications: "Notifications",
  "work-limits": "Work limits",
} as const;
export type OrchestratorSettingsSection = keyof typeof ORCHESTRATOR_SETTINGS;
const inputClass =
  "w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";
const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const readConfig = Schema.decodeUnknownSync(OrchestratorConfig);
export function orchestratorConfigValue(config: OrchestratorConfig): Record<string, Value> {
  return {
    ...config,
    models: config.models.map((choice) => ({
      ...choice,
      selection: {
        instanceId: choice.selection.instanceId,
        model: choice.selection.model,
        ...(choice.selection.options
          ? { options: choice.selection.options.map((option) => ({ ...option })) }
          : {}),
      },
    })),
    environmentIds: [...config.environmentIds],
    capabilities: [...config.capabilities],
    directorSubjects: [...config.directorSubjects],
    managerSubjects: [...config.managerSubjects],
  };
}
function Field({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <label className="grid gap-2 text-sm font-medium">
      {label}
      {children}
      {description && (
        <span className="text-xs font-normal leading-relaxed text-muted-foreground">
          {description}
        </span>
      )}
    </label>
  );
}
function ToggleRow({
  title,
  description,
  checked,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-6 border-b py-4 last:border-b-0">
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">
          {description}
        </span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  );
}
function NewOrchestratorDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const state = useOrchestrators();
  const companies = useAtomValue(companyListAtom);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<OrchestratorConfig["kind"]>("custom");
  const [companyId, setCompanyId] = useState(state.companyId ?? "");
  const [projectId, setProjectId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const choices = useOrchestratorQuery<{
    projects: { id: string; name: string }[];
    members: { subject: string; name: string }[];
  }>(
    state.client,
    state.accountID,
    "aiOrchestrators:configurationChoices",
    companyId ? { companyId } : null,
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Create an orchestrator</DialogTitle>
          <DialogDescription>
            A new colleague to coordinate a project or a particular part of your work.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setSaving(true);
            setError(undefined);
            void state
              .request("aiOrchestrators:create", {
                config: orchestratorConfigValue({
                  ...defaultOrchestratorConfig(name.trim()),
                  kind,
                  companyId: companyId || null,
                  projectId: kind === "project" ? projectId : null,
                }),
              })
              .then((id) => {
                if (typeof id === "string") state.selectSettings(id);
                onClose();
                setName("");
              })
              .catch((cause) => setError(errorMessage(cause)))
              .finally(() => setSaving(false));
          }}
        >
          <div className="grid gap-4 px-6 pb-6">
            <Field label="Name">
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. iOS, Inbox, or Launch"
                required
                maxLength={100}
              />
            </Field>
            <Field label="Role">
              <select
                className={inputClass}
                value={kind}
                onChange={(event) => setKind(event.target.value as OrchestratorConfig["kind"])}
              >
                <option value="custom">Specialist</option>
                <option value="project">Project coordinator</option>
                <option value="personal">Personal assistant</option>
              </select>
            </Field>
            <Field label="Workspace">
              <select
                className={inputClass}
                value={companyId}
                onChange={(event) => {
                  setCompanyId(event.target.value);
                  setProjectId("");
                }}
              >
                <option value="">Personal · across my workspaces</option>
                {companies.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                  </option>
                ))}
              </select>
            </Field>
            {kind === "project" && (
              <Field label="Project">
                <select
                  className={inputClass}
                  value={projectId}
                  onChange={(event) => setProjectId(event.target.value)}
                  required
                >
                  <option value="">Choose a project</option>
                  {choices.value?.projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {(error ?? choices.error) && (
              <p role="alert" className="text-sm text-destructive">
                {error ?? choices.error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={saving || !name.trim() || (kind === "project" && !projectId)}
            >
              {saving ? "Creating…" : "Create orchestrator"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
function MemorySettings({ contact }: { contact: AiOrchestrator }) {
  const state = useOrchestrators();
  const result = useOrchestratorQuery<OrchestratorMemory[]>(
    state.client,
    state.accountID,
    "aiOrchestrators:memories",
    { orchestratorId: contact.id },
  );
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<string>();
  const editingMemory = result.value?.find((memory) => memory.id === editing);
  const memoryContact =
    state.contacts.find((candidate) => candidate.id === editingMemory?.orchestratorId) ?? contact;
  const [scope, setScope] = useState<OrchestratorMemory["scope"]>("orchestrator");
  const [confirmSharing, setConfirmSharing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <div className="space-y-5">
      <p className="text-sm leading-relaxed text-muted-foreground">
        Preferences, decisions, and useful context that stay with {contact.name}. You can correct a
        memory or ask to forget it. Removing a memory also prevents it being learned again from old
        messages.
      </p>
      <form
        className="rounded-xl border p-4 space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          setSaving(true);
          setError(undefined);
          void state
            .request("aiOrchestrators:saveMemory", {
              orchestratorId: memoryContact.id,
              ...(editing ? { id: editing } : {}),
              text,
              scope,
              confirmSharing,
            })
            .then(() => {
              setText("");
              setEditing(undefined);
              setConfirmSharing(false);
            })
            .catch((cause) => setError(errorMessage(cause)))
            .finally(() => setSaving(false));
        }}
      >
        <Field label={editing ? "Correct memory" : "Add a memory"}>
          <textarea
            className={inputClass}
            rows={3}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="e.g. Call me Corey, and give me the main point first."
            maxLength={8000}
          />
        </Field>
        {(memoryContact.shared || scope === "project") && (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirmSharing}
              onChange={(event) => setConfirmSharing(event.target.checked)}
              className="mt-1"
            />
            <span>
              Share this memory with authorized {memoryContact.projectId ? "project" : "workspace"}{" "}
              participants.
            </span>
          </label>
        )}
        <div className="flex flex-wrap justify-between gap-3">
          <select
            className="rounded-lg border bg-background px-3 py-2 text-sm"
            aria-label="Memory scope"
            value={scope}
            onChange={(event) => setScope(event.target.value as OrchestratorMemory["scope"])}
          >
            <option value="orchestrator">Only {memoryContact.name}</option>
            {!memoryContact.shared && (
              <option value="personal">All my private orchestrators</option>
            )}
            {memoryContact.projectId && <option value="project">This project</option>}
          </select>
          <div className="flex gap-2">
            {editing && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setEditing(undefined);
                  setText("");
                }}
              >
                Cancel
              </Button>
            )}
            <Button
              type="submit"
              disabled={
                saving ||
                !text.trim() ||
                ((memoryContact.shared || scope === "project") && !confirmSharing)
              }
            >
              {saving ? "Saving…" : "Save memory"}
            </Button>
          </div>
        </div>
      </form>
      {(error ?? result.error) && (
        <p role="alert" className="text-sm text-destructive">
          {error ?? result.error}
        </p>
      )}
      {result.value?.length === 0 && (
        <div className="py-8 text-center">
          <BrainIcon className="mx-auto size-8 text-muted-foreground/50" />
          <p className="mt-3 text-sm text-muted-foreground">
            A fresh start. Useful memories will appear here.
          </p>
        </div>
      )}
      {result.value?.map((memory) => (
        <div key={memory.id} className="flex gap-4 rounded-xl border p-4">
          <div className="min-w-0 flex-1">
            <p className="whitespace-pre-wrap text-sm">{memory.text}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              {memory.source} ·{" "}
              {memory.scope === "personal"
                ? "All my private orchestrators"
                : memory.scope === "project"
                  ? "Project"
                  : contact.name}
            </p>
          </div>
          <div className="flex items-start gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setEditing(memory.id);
                setText(memory.text);
                setScope(memory.scope);
              }}
            >
              Edit
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Forget memory: ${memory.text.slice(0, 60)}`}
              onClick={() => {
                void state
                  .request("aiOrchestrators:forgetMemory", {
                    orchestratorId: memory.orchestratorId,
                    id: memory.id,
                  })
                  .catch((cause) => setError(errorMessage(cause)));
              }}
            >
              <Trash2Icon className="size-4" />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
const capabilityLabels: Record<(typeof ORCHESTRATOR_CAPABILITIES)[number], string> = {
  "projects.read": "View projects",
  "tasks.read": "View tasks and issues",
  "tasks.manage": "Create and manage tasks",
  "threads.read": "Read agent threads and context",
  "threads.delegate": "Delegate work to agent threads",
  "threads.control": "Send follow-ups and stop delegated work",
  "mail.read": "Read connected email",
  "mail.send": "Compose and send email",
  "time.read": "View time tracking",
  "time.manage": "Manage time entries",
  "environments.read": "Inspect environments and resources",
  "orchestrators.message": "Coordinate with other orchestrators",
  "memory.manage": "Remember useful context",
  "schedules.manage": "Schedule delegated work",
};
function SettingsEditor({
  contact,
  section,
}: {
  contact: AiOrchestrator;
  section: OrchestratorSettingsSection;
}) {
  const state = useOrchestrators();
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const [config, setConfig] = useState(() => readConfig(contact));
  const [base, setBase] = useState(() => ({
    revision: contact.revision,
    config: readConfig(contact),
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const dirty = JSON.stringify(config) !== JSON.stringify(base.config);
  useEffect(() => {
    if (!dirty && contact.revision !== base.revision) {
      const next = readConfig(contact);
      setConfig(next);
      setBase({ revision: contact.revision, config: next });
    }
  }, [contact, dirty, base.revision]);
  const patch = (next: Partial<OrchestratorConfig>) => {
    setConfig((current) => ({ ...current, ...next }));
    setSaved(false);
  };
  const choices = useOrchestratorQuery<{
    projects: { id: string; name: string }[];
    members: { subject: string; name: string }[];
  }>(
    state.client,
    state.accountID,
    "aiOrchestrators:configurationChoices",
    config.companyId && section === "permissions" ? { companyId: config.companyId } : null,
  );
  const changeStatus = (status: AiOrchestrator["status"], stopWork = false) => {
    setError(undefined);
    void state
      .request("aiOrchestrators:setStatus", { id: contact.id, status, stopWork })
      .catch((cause) => setError(errorMessage(cause)));
  };
  let content: ReactNode;
  switch (section) {
    case "overview":
      content = (
        <div className="space-y-7">
          <div className="flex items-center gap-4 rounded-2xl border bg-muted/20 p-5">
            <OrchestratorAvatar contact={config} className="size-14" />
            <div className="flex-1">
              <h3 className="text-lg font-semibold">{config.name}</h3>
              <p className="text-sm text-muted-foreground">
                {config.kind === "project"
                  ? "Project coordinator"
                  : config.kind === "personal"
                    ? "Personal assistant"
                    : "Specialist"}{" "}
                · {contact.status}
              </p>
            </div>
            <Button
              variant="outline"
              onClick={() => {
                void state
                  .request("aiOrchestrators:createChat", {
                    title: contact.name,
                    orchestratorIds: [contact.id],
                    leadId: contact.id,
                    companyIds: state.companyId ? [state.companyId] : [],
                  })
                  .then((id) => {
                    if (typeof id === "string") state.selectChat(id);
                    void navigate({ to: "/orchestrator" });
                  })
                  .catch((cause) => setError(errorMessage(cause)));
              }}
            >
              <MessageCircleIcon />
              Message
            </Button>
          </div>
          <Field label="Name">
            <Input
              value={config.name}
              onChange={(event) => patch({ name: event.target.value })}
              maxLength={100}
            />
          </Field>
          <Field label="Avatar color">
            <span className="flex gap-3">
              {Object.entries(ORCHESTRATOR_COLORS).map(([name, className]) => (
                <button
                  type="button"
                  key={name}
                  aria-label={`${name} avatar`}
                  aria-pressed={config.color === name}
                  onClick={() => patch({ color: name })}
                  className={`${className} flex size-8 items-center justify-center rounded-full text-white ring-offset-background focus-visible:ring-2 ${config.color === name ? "ring-2 ring-ring ring-offset-2" : ""}`}
                >
                  {config.color === name && <CheckIcon className="size-4" />}
                </button>
              ))}
            </span>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border p-4">
              <p className="text-xs text-muted-foreground">Primary model</p>
              <p className="mt-1 text-sm font-medium">
                {config.models[0]?.selection.model ?? "GPT-6 Astra"}
              </p>
            </div>
            <div className="rounded-xl border p-4">
              <p className="text-xs text-muted-foreground">Active work limit</p>
              <p className="mt-1 text-sm font-medium">{config.maxAssignments} assignments</p>
            </div>
          </div>
          <div className="space-y-3 border-t pt-5">
            <p className="text-sm text-muted-foreground">
              Pausing holds new automatic work. Stopping also requests cancellation of queued and
              running work. Archiving keeps conversation history.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => changeStatus(contact.status === "active" ? "paused" : "active")}
              >
                {contact.status === "active" ? <PauseIcon /> : <PlayIcon />}
                {contact.status === "active" ? "Pause" : "Resume"}
              </Button>
              <Button variant="outline" onClick={() => changeStatus("paused", true)}>
                <SquareIcon />
                Stop work
              </Button>
              <Button
                variant="outline"
                onClick={() => changeStatus(contact.status === "archived" ? "paused" : "archived")}
              >
                <ArchiveIcon />
                {contact.status === "archived" ? "Unarchive" : "Archive"}
              </Button>
              <Button
                variant="ghost"
                className="text-destructive"
                onClick={() => setDeleteOpen(true)}
              >
                Delete
              </Button>
            </div>
          </div>
        </div>
      );
      break;
    case "instructions":
      content = (
        <div className="space-y-6">
          <Field
            label="Persona"
            description="Give your orchestrator a voice, a name to use for you, and a preferred way of communicating."
          >
            <textarea
              className={inputClass}
              rows={4}
              value={config.persona}
              onChange={(event) => patch({ persona: event.target.value })}
              maxLength={4000}
            />
          </Field>
          <Field
            label="System instructions"
            description="These instructions guide the orchestrator. Its assigned permissions and delegation-only tools still define what it can do."
          >
            <textarea
              className={`${inputClass} min-h-80 leading-relaxed`}
              value={config.instructions}
              onChange={(event) => patch({ instructions: event.target.value })}
              maxLength={24000}
            />
          </Field>
          <Button
            variant="outline"
            onClick={() => patch({ instructions: defaultOrchestratorConfig().instructions })}
          >
            Restore default instructions
          </Button>
        </div>
      );
      break;
    case "models":
      content = (
        <OrchestratorModels choices={config.models} onChange={(models) => patch({ models })} />
      );
      break;
    case "environments":
      content = (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Choose where {config.name} can coordinate work. Conversations and memory stay available
            across devices. Running work on an offline environment stays marked uncertain until its
            status is known.
          </p>
          <ToggleRow
            title="Use all my authorized environments"
            description="New environments become eligible automatically. Project coordinators still stay within their assigned project."
            checked={config.allEnvironments}
            onChange={(value) =>
              patch({
                allEnvironments: value,
                environmentIds: environments.map((item) => item.environmentId),
              })
            }
          />
          {environments.map((environment) => (
            <label
              key={environment.environmentId}
              className="flex items-center gap-3 rounded-xl border p-4"
            >
              <input
                type="checkbox"
                className="size-4 accent-blue-500"
                checked={
                  config.allEnvironments ||
                  config.environmentIds.includes(environment.environmentId)
                }
                onChange={(event) =>
                  patch({
                    allEnvironments: false,
                    environmentIds: event.target.checked
                      ? [...config.environmentIds, environment.environmentId]
                      : (config.allEnvironments
                          ? environments.map((item) => item.environmentId)
                          : config.environmentIds
                        ).filter((id) => id !== environment.environmentId),
                  })
                }
              />
              <span className="flex-1 text-sm font-medium">{environment.label}</span>
              <span className="text-xs text-muted-foreground">
                {environment.connection.phase === "connected"
                  ? "Connected"
                  : environment.connection.phase === "reconnecting"
                    ? "Reconnecting"
                    : "Offline"}
              </span>
            </label>
          ))}
          {environments.length === 0 && (
            <p className="rounded-xl border p-5 text-sm text-muted-foreground">
              Connect an environment in Settings → Environments.
            </p>
          )}
        </div>
      );
      break;
    case "responsibilities":
      content = (
        <div className="space-y-5">
          <Field
            label="What should this orchestrator take care of?"
            description="Describe ongoing responsibilities, when to check in, and what needs your attention."
          >
            <textarea
              className={`${inputClass} min-h-64 leading-relaxed`}
              value={config.responsibilities}
              onChange={(event) => patch({ responsibilities: event.target.value })}
              placeholder="Coordinate releases, follow up on blocked work, and prepare my morning update…"
              maxLength={12000}
            />
          </Field>
          <Field
            label="Review responsibilities"
            description="Choose how often to review standing work when you are away. Each review uses your selected model and allowance. Open a direct conversation with this contact first."
          >
            <select
              className={inputClass}
              aria-label="Review responsibilities"
              value={config.reviewIntervalMinutes ?? 0}
              onChange={(event) => patch({ reviewIntervalMinutes: Number(event.target.value) })}
            >
              <option value={0}>On events only</option>
              <option value={15}>Every 15 minutes</option>
              <option value={60}>Every hour</option>
              <option value={240}>Every 4 hours</option>
              <option value={1440}>Every day</option>
            </select>
          </Field>
          <ToggleRow
            title="Act proactively"
            description="Respond to events and carry out assigned responsibilities when you are away."
            checked={config.proactive}
            onChange={(proactive) => patch({ proactive })}
          />
        </div>
      );
      break;
    case "permissions":
      content = (
        <div className="space-y-6">
          <div className="flex gap-3 rounded-xl border bg-muted/20 p-4">
            <ShieldCheckIcon className="size-5 shrink-0 text-muted-foreground" />
            <p className="text-sm leading-relaxed">
              {config.name} can act independently within these privileges. Implementation work is
              delegated to agent threads. Permission changes apply to subsequent actions.
            </p>
          </div>
          {config.companyId && (
            <ToggleRow
              title="Share with this workspace"
              description="Workspace members can discover this orchestrator. Direction and management are granted separately below."
              checked={config.shared}
              onChange={(shared) => patch({ shared })}
            />
          )}
          <div>
            <h3 className="mb-3 text-sm font-semibold">Action privileges</h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {ORCHESTRATOR_CAPABILITIES.map((capability) => (
                <label
                  key={capability}
                  className="flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-3 text-sm"
                >
                  <input
                    type="checkbox"
                    className="size-4 accent-blue-500"
                    checked={config.capabilities.includes(capability)}
                    onChange={(event) =>
                      patch({
                        capabilities: event.target.checked
                          ? [...config.capabilities, capability]
                          : config.capabilities.filter((item) => item !== capability),
                      })
                    }
                  />
                  {capabilityLabels[capability]}
                </label>
              ))}
            </div>
          </div>
          <div className="border-t pt-5">
            <h3 className="text-sm font-semibold">Who can direct and manage</h3>
            <p className="mt-1 mb-4 text-sm text-muted-foreground">
              Directors can assign work. Managers can change settings and privileges. You retain
              both as the owner.
            </p>
            {config.shared && choices.value ? (
              <div className="divide-y">
                {choices.value.members
                  .filter((member) => member.subject !== contact.ownerSubject)
                  .map((member) => (
                    <div key={member.subject} className="flex items-center gap-4 py-3 text-sm">
                      <span className="flex-1">{member.name}</span>
                      {(["directorSubjects", "managerSubjects"] as const).map((key) => (
                        <label key={key} className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            className="size-4 accent-blue-500"
                            checked={config[key].includes(member.subject)}
                            onChange={(event) =>
                              patch({
                                [key]: event.target.checked
                                  ? [...config[key], member.subject]
                                  : config[key].filter((subject) => subject !== member.subject),
                              })
                            }
                          />
                          {key === "directorSubjects" ? "Direct" : "Manage"}
                        </label>
                      ))}
                    </div>
                  ))}
              </div>
            ) : (
              <p className="rounded-lg bg-muted/40 p-3 text-sm">
                Private · only you can direct and manage {contact.name}.
              </p>
            )}
            {choices.error && (
              <p role="alert" className="text-sm text-destructive">
                {choices.error}
              </p>
            )}
          </div>
        </div>
      );
      break;
    case "memory":
      content = (
        <div className="space-y-5">
          <ToggleRow
            title="Remember useful context automatically"
            description="Store sourced preferences and decisions. Your explicit instructions take priority over inferred preferences."
            checked={config.rememberAutomatically}
            onChange={(rememberAutomatically) => patch({ rememberAutomatically })}
          />
          <MemorySettings contact={contact} />
        </div>
      );
      break;
    case "notifications":
      content = (
        <div>
          <ToggleRow
            title="Important updates"
            description="Notify me about blockers, decisions, urgent email, and work that needs my attention."
            checked={config.notifyUrgent}
            onChange={(notifyUrgent) => patch({ notifyUrgent })}
          />
          <ToggleRow
            title="Batch routine completions"
            description="Group ordinary updates into a useful summary, keeping the conversation quiet while work progresses."
            checked={config.batchCompletions}
            onChange={(batchCompletions) => patch({ batchCompletions })}
          />
          <Button
            variant="outline"
            className="mt-5"
            onClick={() => {
              void navigate({ to: "/settings/notifications" });
            }}
          >
            Device notifications and quiet hours
            <ArrowUpRightIcon />
          </Button>
        </div>
      );
      break;
    case "work-limits":
      content = (
        <div className="space-y-6">
          <Field
            label="Maximum active assignments"
            description="Additional work waits in the queue. The orchestrator can keep communicating while delegated work is running."
          >
            <Input
              type="number"
              min={1}
              max={32}
              className="max-w-32"
              value={config.maxAssignments}
              onChange={(event) => patch({ maxAssignments: Number(event.target.value) })}
            />
          </Field>
          <p className="text-sm text-muted-foreground">
            Manage conversation allowances in Settings → Providers, under the provider instance.
          </p>
        </div>
      );
      break;
  }
  return (
    <>
      <div className="mb-7 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{ORCHESTRATOR_SETTINGS[section]}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{contact.name} · Orchestrators</p>
        </div>
        <Button
          disabled={!dirty || saving || !contact.canManage}
          onClick={() => {
            setSaving(true);
            setError(undefined);
            void state
              .request("aiOrchestrators:configure", {
                id: contact.id,
                revision: base.revision,
                config: orchestratorConfigValue(config),
              })
              .then((revision) => {
                if (typeof revision === "number") setBase({ revision, config });
                setSaved(true);
              })
              .catch((cause) => setError(errorMessage(cause)))
              .finally(() => setSaving(false));
          }}
        >
          {saved && !dirty ? <CheckIcon /> : <SaveIcon />}
          {saving ? "Saving…" : saved && !dirty ? "Saved" : "Save changes"}
        </Button>
      </div>
      {contact.revision !== base.revision && dirty && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm"
        >
          Settings changed on another device.{" "}
          <Button
            variant="link"
            onClick={() => {
              const next = readConfig(contact);
              setConfig(next);
              setBase({ revision: contact.revision, config: next });
            }}
          >
            Load latest settings
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {error}
        </p>
      )}
      <fieldset disabled={!contact.canManage || saving} className="min-w-0 disabled:opacity-60">
        {content}
      </fieldset>
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Delete {contact.name}?</DialogTitle>
            <DialogDescription>
              This cancels queued coordination, requests a stop for delegated work, and removes its
              private memory. Conversation history shared with other participants is preserved.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Keep orchestrator
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                changeStatus("deleted", true);
                setDeleteOpen(false);
              }}
            >
              Delete orchestrator
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
export function OrchestratorSettings({ section }: { section: OrchestratorSettingsSection }) {
  const state = useOrchestrators();
  const [newOpen, setNewOpen] = useState(false);
  const contact =
    state.contacts.find((item) => item.id === state.settingsId) ??
    state.contacts.find((item) => item.canManage) ??
    state.contacts[0];
  return (
    <SettingsPageContainer className="gap-8">
      <div className="flex items-center gap-3">
        <BotIcon className="size-5 text-muted-foreground" />
        <select
          aria-label="Configure orchestrator"
          className="min-w-0 flex-1 rounded-lg border bg-background p-2 text-sm"
          value={contact?.id ?? ""}
          onChange={(event) => state.selectSettings(event.target.value)}
        >
          {state.contacts.length === 0 && (
            <option value="">
              {state.loading ? "Loading orchestrators…" : "No orchestrators"}
            </option>
          )}
          {state.contacts.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
              {item.status === "archived" ? " · Archived" : ""}
            </option>
          ))}
        </select>
        <Button variant="outline" onClick={() => setNewOpen(true)}>
          <PlusIcon />
          New orchestrator
        </Button>
      </div>
      {state.error && (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {state.error}
        </p>
      )}
      {contact ? (
        <section id={`orchestrators-${section}`} className="min-w-0">
          <SettingsEditor key={contact.id} contact={contact} section={section} />
        </section>
      ) : (
        <p className="py-12 text-center text-sm text-muted-foreground">
          {state.loading ? "Loading your orchestrators…" : "Create an orchestrator to get started."}
        </p>
      )}
      <NewOrchestratorDialog open={newOpen} onClose={() => setNewOpen(false)} />
    </SettingsPageContainer>
  );
}
