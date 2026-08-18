import { CompanyId } from "@spiritdevs/contracts/company";
import { useEffect, useRef, useState } from "react";

import { newCompanyDomainId, type CurrentCompanySummary } from "../../../cloud/companyAdmin";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { useCompanySettings } from "./useCompanySettings";

export function CreateCompanyDialog({
  onCreated,
  onOpenChange,
  open,
}: {
  readonly onCreated: (company: CurrentCompanySummary) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
}) {
  const { admin } = useCompanySettings();
  const inputRef = useRef<HTMLInputElement>(null);
  const companyIdRef = useRef(CompanyId.make(newCompanyDomainId()));
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmedName = name.trim();

  useEffect(() => {
    if (!open) return;
    companyIdRef.current = CompanyId.make(newCompanyDomainId());
    setName("");
    setPending(false);
    setError(null);
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const submit = () => {
    if (admin === null || trimmedName.length === 0 || pending) return;
    setPending(true);
    setError(null);
    void admin
      .createCompany({ id: companyIdRef.current, name: trimmedName })
      .then((company) => {
        onCreated(company);
        onOpenChange(false);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Could not create this company.");
      })
      .finally(() => setPending(false));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create company</DialogTitle>
          <DialogDescription>
            Create a separate workspace for its members, teams, issues, and integrations.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id="create-company-form"
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <label className="text-xs font-medium" htmlFor="new-company-name">
              Company name
            </label>
            <Input
              id="new-company-name"
              ref={inputRef}
              autoComplete="organization"
              disabled={pending}
              placeholder="Acme, Inc."
              value={name}
              aria-describedby={error === null ? undefined : "create-company-error"}
              aria-invalid={error !== null}
              onChange={(event) => {
                setName(event.currentTarget.value);
                if (error !== null) setError(null);
              }}
            />
            {error !== null ? (
              <p id="create-company-error" role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">You will be added as the first owner.</p>
            )}
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            form="create-company-form"
            disabled={admin === null || trimmedName.length === 0 || pending}
          >
            {pending ? "Creating…" : "Create company"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
