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
}: {
  choice: OrchestratorModelChoice;
  index: number;
  onChange: (choice: OrchestratorModelChoice) => void;
  onRemove: () => void;
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
          { id, value },
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
          aria-label={`Move model choice ${index + 1}`}
          className="touch-none rounded p-1 text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        >
          <GripVerticalIcon className="size-4" />
        </button>
        <span className="flex-1 text-xs font-medium text-muted-foreground">
          {index === 0 ? "PRIMARY MODEL" : `FALLBACK ${index}`}
        </span>
        <Button
          size="icon"
          variant="ghost"
          aria-label={`Remove model choice ${index + 1}`}
          onClick={onRemove}
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <select
          aria-label={`Environment for model choice ${index + 1}`}
          value={choice.environmentId}
          onChange={(event) => onChange({ ...choice, environmentId: event.target.value })}
          className="min-w-40 rounded-lg border bg-background px-3 py-2 text-sm"
        >
          <option value="">Choose an environment</option>
          {!environment && choice.environmentId && (
            <option value={choice.environmentId}>Unavailable environment</option>
          )}
          {environments.map((item) => (
            <option key={item.environmentId} value={item.environmentId}>
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
              deriveProviderInstanceEntries(providers).filter((entry) =>
                supportsCoordinator(entry.driverKind),
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
          triggerAriaLabel={`Model choice ${index + 1}`}
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
                value={String(getProviderOptionCurrentValue(descriptor) ?? "")}
                onChange={(event) => optionChange(descriptor.id, event.target.value)}
              >
                <option value="" disabled>
                  Default
                </option>
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
}: {
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
        Drag choices into your preferred order. Each choice keeps its own model and performance
        settings. Pathway tries the same model on an eligible environment before moving to the next
        fallback.
      </p>
      {choices.length === 0 && (
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
        disabled={choices.length >= 12}
        onClick={() => {
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
        {choices.length ? "Add fallback" : "Choose primary model"}
      </Button>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Model fallback respects the same work allowance. An account with a separate allowance needs
        its own allocation.
      </p>
    </div>
  );
}
