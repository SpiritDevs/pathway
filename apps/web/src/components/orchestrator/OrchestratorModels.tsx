import type { ReactNode } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVerticalIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { EnvironmentId, ProviderInstanceId, type ModelSelection } from "@spiritdevs/contracts";
import {
  COORDINATOR_DRIVERS,
  DEFAULT_ORCHESTRATOR_MODEL,
  type OrchestratorModelChoice,
} from "@spiritdevs/contracts/aiOrchestrator";
import {
  createModelSelection,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
} from "@spiritdevs/shared/model";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { getProviderModelCapabilities } from "../../providerModels";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { randomUUID } from "../../lib/utils";

const supportsCoordinator = (driver: string) => COORDINATOR_DRIVERS.some((item) => item === driver);
export function defaultCoordinatorSelection(instanceId = "codex"): ModelSelection {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    model: DEFAULT_ORCHESTRATOR_MODEL,
    options: [{ id: "reasoningEffort", value: "high" }],
  };
}
function ModelRow({
  choice,
  index,
  onChange,
  onRemove,
  worker = false,
  details,
  workerDefault = false,
}: {
  choice: OrchestratorModelChoice;
  index: number;
  onChange: (choice: OrchestratorModelChoice) => void;
  onRemove: () => void;
  worker?: boolean;
  details?: ReactNode;
  workerDefault?: boolean;
}) {
  const { environments } = useEnvironments();
  const environment = environments.find((item) => item.environmentId === choice.environmentId);
  const settings = useEnvironmentSettings(
    choice.environmentId ? EnvironmentId.make(choice.environmentId) : null,
  );
  const providers = environment?.serverConfig?.providers ?? [];
  const provider = providers.find((item) => item.instanceId === choice.selection.instanceId);
  const descriptors = provider
    ? getProviderOptionDescriptors({
        caps: getProviderModelCapabilities(
          provider.models,
          choice.selection.model,
          provider.driver,
        ),
        selections: choice.selection.options,
      })
    : [];
  const sortable = useSortable({ id: choice.id });
  const optionChange = (id: string, value: string | boolean) =>
    onChange({
      ...choice,
      selection: {
        ...choice.selection,
        options: [
          ...(choice.selection.options ?? []).filter((option) => option.id !== id),
          ...(value === "" ? [] : [{ id, value }]),
        ],
      },
    });
  return (
    <div
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
        opacity: sortable.isDragging ? 0.6 : 1,
      }}
      className="rounded-xl border bg-background p-4"
    >
      <div className="flex items-center gap-2 pb-3">
        <button
          ref={sortable.setActivatorNodeRef}
          type="button"
          {...sortable.attributes}
          {...sortable.listeners}
          aria-label={`Move ${worker ? "worker preset" : "model choice"} ${index + 1}`}
          className="touch-none rounded p-1 text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        >
          <GripVerticalIcon className="size-4" />
        </button>
        <span className="flex-1 text-xs font-medium text-muted-foreground">
          {worker
            ? workerDefault
              ? "DEFAULT WORKER"
              : `WORKER PRESET ${index + 1}`
            : index === 0
              ? "PRIMARY MODEL"
              : `FALLBACK ${index}`}
        </span>
        <Button
          size="icon"
          variant="ghost"
          aria-label={`Remove ${worker ? "worker preset" : "model choice"} ${index + 1}`}
          onClick={onRemove}
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      </div>
      {details}
      <div className="flex flex-wrap items-center gap-3">
        <select
          aria-label={`Environment for ${worker ? "worker preset" : "model choice"} ${index + 1}`}
          value={choice.environmentId}
          onChange={(event) => {
            const environmentId = event.target.value;
            const target = environments.find((item) => item.environmentId === environmentId);
            const provider = target?.serverConfig?.providers.find(
              (item) =>
                item.enabled &&
                item.models.length > 0 &&
                (worker || supportsCoordinator(item.driver)),
            );
            const model = provider?.models[0];
            if (provider && model)
              onChange({
                ...choice,
                environmentId,
                selection: createModelSelection(provider.instanceId, model.slug),
              });
          }}
          className="min-w-40 rounded-lg border bg-background px-3 py-2 text-sm"
        >
          <option value="" disabled>
            Choose an environment
          </option>
          {!environment && choice.environmentId && (
            <option value={choice.environmentId}>Unavailable environment</option>
          )}
          {environments.map((item) => (
            <option
              key={item.environmentId}
              value={item.environmentId}
              disabled={
                !item.serverConfig?.providers.some(
                  (provider) =>
                    provider.enabled &&
                    provider.models.length > 0 &&
                    (worker || supportsCoordinator(provider.driver)),
                )
              }
            >
              {item.label}
            </option>
          ))}
        </select>
        <ProviderModelPicker
          activeInstanceId={choice.selection.instanceId}
          model={choice.selection.model}
          lockedProvider={null}
          instanceEntries={sortProviderInstanceEntries(
            applyProviderInstanceSettings(
              deriveProviderInstanceEntries(providers).filter(
                (entry) => worker || supportsCoordinator(entry.driverKind),
              ),
              settings,
            ),
          )}
          modelOptionsByInstance={getCustomModelOptionsByInstance(
            settings,
            providers,
            choice.selection.instanceId,
            choice.selection.model,
          )}
          onInstanceModelChange={(instanceId, model) =>
            onChange({ ...choice, selection: createModelSelection(instanceId, model) })
          }
          triggerAriaLabel={`${worker ? "Worker preset" : "Model choice"} ${index + 1}`}
          triggerVariant="outline"
        />
        {descriptors.map((descriptor) =>
          descriptor.type === "select" ? (
            <label
              key={descriptor.id}
              className="flex items-center gap-2 text-xs text-muted-foreground"
            >
              {descriptor.label}
              <select
                className="rounded-lg border bg-background p-2 text-sm text-foreground"
                value={String(
                  choice.selection.options?.find((option) => option.id === descriptor.id)?.value ??
                    "",
                )}
                onChange={(event) => optionChange(descriptor.id, event.target.value)}
              >
                <option value="">Provider default</option>
                {descriptor.options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label key={descriptor.id} className="flex items-center gap-2 text-xs">
              <Switch
                checked={getProviderOptionCurrentValue(descriptor) === true}
                onCheckedChange={(value) => optionChange(descriptor.id, value)}
              />
              {descriptor.label}
            </label>
          ),
        )}
        {!provider && (
          <span className="text-xs text-muted-foreground">
            {choice.selection.options?.find((option) => option.id === "reasoningEffort")?.value ===
            "high"
              ? "High reasoning · "
              : ""}
            Connect this environment to see its model options.
          </span>
        )}
      </div>
    </div>
  );
}
export function OrchestratorModels({
  choices,
  onChange,
  worker = false,
  renderDetails,
}: {
  worker?: boolean;
  renderDetails?: (choice: OrchestratorModelChoice) => ReactNode;
  choices: readonly OrchestratorModelChoice[];
  onChange: (choices: readonly OrchestratorModelChoice[]) => void;
}) {
  const { environments } = useEnvironments();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {worker
          ? "Give the coordinator useful choices for different tasks. The first preset on each environment is its worker default. Reorder to change that default. Explicit task choices take precedence; unavailable choices fail without switching models."
          : "These models reason about your conversations. Drag to set the coordinator's primary model and ordered fallbacks. Worker choices are configured separately below."}
      </p>
      {choices.length === 0 && !worker && (
        <div className="rounded-xl border bg-muted/25 p-5">
          <p className="font-medium">
            GPT-6 Astra{" "}
            <span className="text-sm font-normal text-muted-foreground">· High reasoning</span>
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            The default for new orchestrators. Choose an environment to enable it.
          </p>
        </div>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={({ active, over }) => {
          if (over && active.id !== over.id)
            onChange(
              arrayMove(
                [...choices],
                choices.findIndex((choice) => choice.id === active.id),
                choices.findIndex((choice) => choice.id === over.id),
              ),
            );
        }}
      >
        <SortableContext
          items={choices.map((choice) => choice.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="space-y-3">
            {choices.map((choice, index) => (
              <ModelRow
                key={choice.id}
                choice={choice}
                worker={worker}
                workerDefault={
                  choices.findIndex((item) => item.environmentId === choice.environmentId) === index
                }
                details={renderDetails?.(choice)}
                index={index}
                onChange={(next) =>
                  onChange(choices.map((item) => (item.id === choice.id ? next : item)))
                }
                onRemove={() => onChange(choices.filter((item) => item.id !== choice.id))}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      <Button
        variant="outline"
        disabled={
          choices.length >= 12 ||
          (worker &&
            !environments.some((environment) =>
              environment.serverConfig?.providers.some(
                (p) =>
                  p.enabled &&
                  p.installed &&
                  p.availability !== "unavailable" &&
                  p.status !== "error" &&
                  p.status !== "disabled" &&
                  p.auth.status !== "unauthenticated" &&
                  p.models.length > 0,
              ),
            ))
        }
        onClick={() => {
          if (worker) {
            for (const environment of environments) {
              const provider = environment.serverConfig?.providers.find(
                (provider) =>
                  provider.enabled &&
                  provider.installed &&
                  provider.availability !== "unavailable" &&
                  provider.status !== "error" &&
                  provider.status !== "disabled" &&
                  provider.auth.status !== "unauthenticated" &&
                  provider.models.length > 0,
              );
              const model =
                provider?.models.find((model) => model.isDefault) ?? provider?.models[0];
              if (provider && model) {
                onChange([
                  ...choices,
                  {
                    id: randomUUID(),
                    environmentId: environment.environmentId,
                    selection: createModelSelection(provider.instanceId, model.slug),
                  },
                ]);
                return;
              }
            }
            return;
          }
          const environment = environments.find((item) =>
            item.serverConfig?.providers.some((provider) => provider.driver === "codex"),
          );
          const provider = environment?.serverConfig?.providers.find(
            (item) => item.driver === "codex",
          );
          onChange([
            ...choices,
            {
              id: randomUUID(),
              environmentId: environment?.environmentId ?? "",
              selection: defaultCoordinatorSelection(provider?.instanceId),
            },
          ]);
        }}
      >
        <PlusIcon />
        {worker ? "Add worker preset" : choices.length ? "Add fallback" : "Choose primary model"}
      </Button>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {worker
          ? "Without a worker preset, default delegation uses the project's saved model, then the environment text-generation model. Connect an environment to add a preset. Reasoning options come from its model catalog."
          : "Model fallback respects the same work allowance. An account with a separate allowance needs its own allocation."}
      </p>
    </div>
  );
}
