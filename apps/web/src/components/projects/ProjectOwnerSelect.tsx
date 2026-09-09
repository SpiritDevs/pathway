import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { activeCompanyIdAtom, companyListAtom } from "~/cloud/activeCompany";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { defaultProjectOwner, projectOwnerOptions } from "./projectOwner.logic";

/** A creation choice is independent of the profile's visibility filter. */
export function useProjectOwner(initialOwner?: string) {
  const companies = useAtomValue(companyListAtom);
  const activeCompanyId = useAtomValue(activeCompanyIdAtom);
  const [selectedOwner, setSelectedOwner] = useState<string | null>(initialOwner ?? null);
  const options = projectOwnerOptions(companies);
  const owner = options.some((option) => option.id === selectedOwner)
    ? selectedOwner!
    : defaultProjectOwner(companies, activeCompanyId);
  return { owner, setSelectedOwner, options };
}

export function ProjectOwnerSelect({
  owner,
  options,
  onChange,
  disabled = false,
}: {
  readonly owner: string;
  readonly options: ReturnType<typeof projectOwnerOptions>;
  readonly onChange: (owner: string) => void;
  readonly disabled?: boolean;
}) {
  if (options.length <= 1) return null;
  return (
    <div className="flex items-center gap-3 border-b px-4 py-2">
      <span className="text-xs text-muted-foreground">Workspace</span>
      <Select
        value={owner}
        onValueChange={(value) => value !== null && onChange(value)}
        disabled={disabled}
      >
        <SelectTrigger
          aria-label="Project workspace"
          className="min-w-0 flex-1 border-0 bg-transparent shadow-none"
        >
          <SelectValue>{options.find((option) => option.id === owner)?.name}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.name}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}
