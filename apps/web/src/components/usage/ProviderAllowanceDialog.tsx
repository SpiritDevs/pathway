import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProviderInstanceId, ProviderUsageDriver } from "@spiritdevs/contracts";
import {
  allowanceScopeKey,
  type ProviderAllowanceScope,
} from "@spiritdevs/contracts/providerAllowanceBudget";
import { activeCompanyIdAtom, companyListAtom } from "../../cloud/activeCompany";
import { useThreadShells } from "../../state/entities";
import { useOrchestrators } from "../orchestrator/OrchestratorContext";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogDescription,
} from "../ui/dialog";
import { AllowanceBudgets } from "./AllowanceBudgets";

export type AllowanceProviderTarget = {
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
  provider: ProviderUsageDriver;
  displayName: string;
};

export function ProviderAllowanceContent({ target }: { target: AllowanceProviderTarget }) {
  const active = useAtomValue(activeCompanyIdAtom);
  const companies = useAtomValue(companyListAtom);
  const threads = useThreadShells();
  const orchestrators = useOrchestrators();
  const [selectedCompany, setSelectedCompany] = useState("");
  const [selectedScope, setSelectedScope] = useState("");
  const companyId =
    companies.find((company) => company.id === (selectedCompany || active))?.id ?? companies[0]?.id;
  const work: { scope: ProviderAllowanceScope; title: string; label: string }[] = [
    ...threads
      .filter(
        (thread) =>
          thread.environmentId === target.environmentId && !thread.deletedAt && !thread.temporary,
      )
      .map((thread) => ({
        scope: {
          kind: "thread" as const,
          environmentId: thread.environmentId,
          threadId: thread.id,
        },
        title: thread.title,
        label: `Thread · ${thread.title}`,
      })),
    ...orchestrators.chats
      .filter(
        (chat) =>
          chat.ownerSubject === orchestrators.accountID &&
          (chat.companyIds.length === 0 ||
            (companyId !== undefined && chat.companyIds.includes(companyId))),
      )
      .map((chat) => ({
        scope: { kind: "chat" as const, chatId: chat.id },
        title: chat.title,
        label: `Conversation · ${chat.title}`,
      })),
  ];
  const selected = work.find((item) => allowanceScopeKey(item.scope) === selectedScope);
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="grid gap-2 text-sm font-medium">
          Workspace
          <select
            className="h-9 min-w-0 rounded-md border border-input bg-background px-3 text-sm font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={companyId ?? ""}
            onChange={(event) => {
              setSelectedCompany(event.target.value);
              setSelectedScope("");
            }}
          >
            {companies.map((company) => (
              <option key={company.id} value={company.id}>
                {company.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-2 text-sm font-medium">
          Thread or conversation
          <select
            className="h-9 min-w-0 rounded-md border border-input bg-background px-3 text-sm font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={selected ? selectedScope : ""}
            onChange={(event) => setSelectedScope(event.target.value)}
          >
            <option value="">Choose work to manage</option>
            {work.map((item) => (
              <option key={allowanceScopeKey(item.scope)} value={allowanceScopeKey(item.scope)}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {companyId && selected ? (
        <AllowanceBudgets
          key={`${companyId}:${selectedScope}`}
          companyId={companyId}
          title={selected.title}
          scopes={[selected.scope]}
          target={target}
        />
      ) : (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          Choose a workspace and a thread or conversation to manage its allowance for{" "}
          {target.displayName}.
        </p>
      )}
    </div>
  );
}

export function ProviderAllowanceDialog(target: AllowanceProviderTarget) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Manage allowance
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-h-[85dvh] sm:max-w-2xl">
          <DialogHeader className="pr-12">
            <DialogTitle>{target.displayName} allowance</DialogTitle>
            <DialogDescription>
              Start with this provider and include fallback accounts in the allowance for your work.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {open && (
              <ProviderAllowanceContent
                key={`${target.environmentId}:${target.instanceId}:${target.provider}`}
                target={target}
              />
            )}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}
