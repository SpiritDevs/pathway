import type { OrchestratorWorkerModel } from "@spiritdevs/contracts/aiOrchestrator";
import { OrchestratorModels } from "./OrchestratorModels";

const field = "w-full rounded-lg border bg-background px-3 py-2 text-sm text-foreground";
export function OrchestratorWorkerModels({
  choices,
  onChange,
}: {
  choices: readonly OrchestratorWorkerModel[];
  onChange: (choices: readonly OrchestratorWorkerModel[]) => void;
}) {
  const patch = (id: string, change: Partial<OrchestratorWorkerModel>) =>
    onChange(choices.map((choice) => (choice.id === id ? { ...choice, ...change } : choice)));
  return (
    <section className="space-y-3">
      <h3 className="text-base font-medium">Delegated workers</h3>
      <p className="text-sm text-muted-foreground">
        The coordinator matches each task to available agents, models and reasoning settings. Start
        with a routine worker for focused tasks, then add a preset for difficult work. These
        preferences guide selection; they do not grant tools or additional allowance.
      </p>
      <OrchestratorModels
        worker
        choices={choices}
        onChange={(next) =>
          onChange(
            next.map((choice) => ({
              name: "Worker",
              guidance: "",
              cost: "unknown" as const,
              ...choices.find((item) => item.id === choice.id),
              ...choice,
            })),
          )
        }
        renderDetails={(base) => {
          const choice = choices.find((choice) => choice.id === base.id)!;
          return (
            <div className="mb-4 space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-xs text-muted-foreground">
                  Name
                  <input
                    className={field}
                    value={choice.name}
                    maxLength={80}
                    onChange={(event) => patch(choice.id, { name: event.target.value })}
                  />
                </label>
                <label className="space-y-1 text-xs text-muted-foreground">
                  Relative cost, your estimate
                  <select
                    className={field}
                    value={choice.cost}
                    onChange={(event) => {
                      const cost = event.target.value;
                      if (
                        cost === "unknown" ||
                        cost === "lower" ||
                        cost === "standard" ||
                        cost === "higher"
                      )
                        patch(choice.id, { cost });
                    }}
                  >
                    <option value="unknown">Unknown</option>
                    <option value="lower">Lower</option>
                    <option value="standard">Standard</option>
                    <option value="higher">Higher</option>
                  </select>
                </label>
              </div>
              <label className="block space-y-1 text-xs text-muted-foreground">
                When to use
                <textarea
                  className={field}
                  rows={2}
                  maxLength={1000}
                  value={choice.guidance}
                  placeholder="For example: focused edits and tests. Escalate when requirements are unclear or the first attempt fails."
                  onChange={(event) => patch(choice.id, { guidance: event.target.value })}
                />
              </label>
            </div>
          );
        }}
      />
    </section>
  );
}
