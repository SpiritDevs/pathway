import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@spiritdevs/contracts";
import { activeCompanyIdAtom, companyListAtom } from "../../cloud/activeCompany";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPopup, DialogTitle, DialogDescription } from "../ui/dialog";
import { AllowanceBudgets } from "./AllowanceBudgets";

function ThreadAllowanceContent({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const active = useAtomValue(activeCompanyIdAtom);
  const companies = useAtomValue(companyListAtom);
  const [selected, setSelected] = useState("");
  const companyId = selected || active;
  return (
    <div className="space-y-5">
      <label className="grid gap-2 text-sm">
        Workspace
        <select
          className="rounded-lg border bg-background px-3 py-2"
          value={companyId ?? ""}
          onChange={(event) => setSelected(event.target.value)}
        >
          {companies.map((company) => (
            <option key={company.id} value={company.id}>
              {company.name}
            </option>
          ))}
        </select>
      </label>
      {companyId && (
        <AllowanceBudgets
          key={`${companyId}:${threadId}`}
          companyId={companyId}
          title="Agent thread allowance"
          scopes={[{ kind: "thread", environmentId, threadId }]}
        />
      )}
    </div>
  );
}
export function ThreadAllowanceDialog(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button className="mx-3 mb-3" variant="outline" size="sm" onClick={() => setOpen(true)}>
        Manage allowance
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Thread allowance</DialogTitle>
            <DialogDescription>
              Limit account consumption for this thread and its delegated work.
            </DialogDescription>
          </DialogHeader>
          {open && <ThreadAllowanceContent {...props} />}
        </DialogPopup>
      </Dialog>
    </>
  );
}
