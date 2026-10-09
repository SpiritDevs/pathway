import type { BrowserAddress } from "@spiritdevs/contracts";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { useClientSettings } from "~/hooks/useSettings";
import { randomUUID } from "~/lib/utils";

import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settingsLayout";
import { saveBrowserSetting } from "./saveBrowserSetting";

type AddressField = Exclude<keyof BrowserAddress, "id">;

const ADDRESS_FIELDS: ReadonlyArray<{
  readonly key: AddressField;
  readonly label: string;
  readonly type?: string;
  readonly autoComplete: string;
  readonly wide?: boolean;
}> = [
  { key: "fullName", label: "Name", autoComplete: "name" },
  { key: "organization", label: "Organization", autoComplete: "organization" },
  { key: "streetAddress", label: "Street address", autoComplete: "street-address", wide: true },
  { key: "city", label: "City", autoComplete: "address-level2" },
  { key: "region", label: "State or region", autoComplete: "address-level1" },
  { key: "postalCode", label: "Postal code", autoComplete: "postal-code" },
  { key: "country", label: "Country", autoComplete: "country-name" },
  { key: "phone", label: "Phone", type: "tel", autoComplete: "tel" },
  { key: "email", label: "Email", type: "email", autoComplete: "email" },
];

const emptyAddress = (): BrowserAddress => ({
  id: randomUUID(),
  fullName: "",
  organization: "",
  streetAddress: "",
  city: "",
  region: "",
  postalCode: "",
  country: "",
  phone: "",
  email: "",
});

/** One line that tells saved addresses apart. */
export function browserAddressSummary(address: BrowserAddress): string {
  return (
    [address.streetAddress.split("\n")[0], address.city, address.email, address.phone]
      .filter((part) => part && part.trim() !== "")
      .join(", ") || "No details"
  );
}

export function BrowserContactInfoSettings() {
  const saveAddresses = useClientSettings((settings) => settings.browserSaveAddresses);
  const addresses = useClientSettings((settings) => settings.browserAddresses);
  const [editing, setEditing] = useState<BrowserAddress | null>(null);

  const save = (address: BrowserAddress) => {
    const exists = addresses.some((entry) => entry.id === address.id);
    saveBrowserSetting({
      browserAddresses: exists
        ? addresses.map((entry) => (entry.id === address.id ? address : entry))
        : [...addresses, address],
    });
    setEditing(null);
  };

  return (
    <SettingsPageContainer>
      <SettingsSection title="Contact info">
        <SettingsRow
          title="Save and fill addresses"
          description="Offer saved addresses, phone numbers, and email addresses when filling forms in the built-in browser"
          control={
            <Switch
              checked={saveAddresses}
              aria-label="Save and fill addresses"
              onCheckedChange={(checked) => saveBrowserSetting({ browserSaveAddresses: checked })}
            />
          }
        />
      </SettingsSection>
      <SettingsSection
        title="Addresses"
        headerAction={
          <Button size="xs" variant="outline" onClick={() => setEditing(emptyAddress())}>
            <PlusIcon />
            Add
          </Button>
        }
      >
        <div className="px-3 @xl/settings:px-4">
          {addresses.length === 0 ? (
            <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
              Saved addresses will appear here
            </p>
          ) : (
            <ul className="divide-y divide-border/60 rounded-xl border">
              {addresses.map((address) => (
                <li key={address.id} className="flex items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{address.fullName || "Unnamed"}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {browserAddressSummary(address)}
                    </p>
                  </div>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Edit ${address.fullName || "address"}`}
                    onClick={() => setEditing(address)}
                  >
                    <PencilIcon />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Delete ${address.fullName || "address"}`}
                    onClick={() =>
                      saveBrowserSetting({
                        browserAddresses: addresses.filter((entry) => entry.id !== address.id),
                      })
                    }
                  >
                    <Trash2Icon />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SettingsSection>
      {editing ? (
        <AddressDialog
          address={editing}
          isNew={!addresses.some((entry) => entry.id === editing.id)}
          onSave={save}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </SettingsPageContainer>
  );
}

function AddressDialog({
  address,
  isNew,
  onSave,
  onClose,
}: {
  readonly address: BrowserAddress;
  readonly isNew: boolean;
  readonly onSave: (address: BrowserAddress) => void;
  readonly onClose: () => void;
}) {
  const [draft, setDraft] = useState(address);
  const blank = ADDRESS_FIELDS.every((field) => draft[field.key].trim() === "");
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="max-w-lg">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!blank) onSave(draft);
          }}
        >
          <DialogHeader>
            <DialogTitle>{isNew ? "Add address" : "Edit address"}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="grid gap-3 sm:grid-cols-2">
            {ADDRESS_FIELDS.map((field) => (
              <label
                key={field.key}
                className={`space-y-1 text-xs ${field.wide ? "sm:col-span-2" : ""}`}
              >
                {field.label}
                <Input
                  type={field.type ?? "text"}
                  autoComplete={field.autoComplete}
                  value={draft[field.key]}
                  onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value })}
                />
              </label>
            ))}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={blank}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
