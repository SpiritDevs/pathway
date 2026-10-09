import {
  type BrowserAgentAccess,
  type BrowserAgentSitePolicy,
  normalizeBrowserSitePattern,
  setBrowserAgentSitePolicy,
} from "@spiritdevs/contracts";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useClientSettings } from "~/hooks/useSettings";

import { searchableSetting } from "../settingsSearch";
import { SettingsSection } from "../settingsLayout";
import { saveBrowserSetting } from "./saveBrowserSetting";

type AccessKey = keyof BrowserAgentAccess;
const USE_DEFAULT = "default";

const ACCESS_COLUMNS: ReadonlyArray<{
  readonly key: AccessKey;
  readonly label: string;
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
}> = [
  {
    key: "browse",
    label: "Browse",
    options: [
      { value: "allow", label: "Always allow" },
      { value: "approval", label: "Requires approval" },
      { value: "block", label: "Block" },
    ],
  },
  {
    key: "download",
    label: "Download",
    options: [
      { value: "allow", label: "Allow" },
      { value: "block", label: "Block" },
    ],
  },
  {
    key: "cdp",
    label: "Debug (CDP)",
    options: [
      { value: "allow", label: "Allow" },
      { value: "block", label: "Block" },
    ],
  },
];

function AccessSelect({
  column,
  value,
  allowDefault,
  onChange,
  ariaLabel,
}: {
  readonly column: (typeof ACCESS_COLUMNS)[number];
  readonly value: string;
  readonly allowDefault: boolean;
  readonly onChange: (value: string) => void;
  readonly ariaLabel: string;
}) {
  const options = allowDefault
    ? [{ value: USE_DEFAULT, label: "Use default" }, ...column.options]
    : column.options;
  return (
    <Select value={value} onValueChange={(next) => onChange(next as string)}>
      <SelectTrigger size="sm" className="w-full min-w-0" aria-label={ariaLabel}>
        <SelectValue>{options.find((option) => option.value === value)?.label}</SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {options.map((option) => (
          <SelectItem hideIndicator key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** A site's custom access, without its pattern. */
const customAccess = (site: BrowserAgentSitePolicy): Partial<BrowserAgentAccess> => {
  const { pattern: _pattern, ...access } = site;
  return access;
};

const GRID = "grid grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))_1.75rem] items-center gap-2";

export function BrowserAgentPermissionsSection() {
  const permissions = useClientSettings((settings) => settings.browserAgentPermissions);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  const setDefault = (key: AccessKey, value: string) =>
    saveBrowserSetting({
      browserAgentPermissions: {
        ...permissions,
        defaults: { ...permissions.defaults, [key]: value },
      },
    });

  const setSiteAccess = (site: BrowserAgentSitePolicy, key: AccessKey, value: string) => {
    const { [key]: _previous, ...rest } = customAccess(site);
    saveBrowserSetting({
      browserAgentPermissions: setBrowserAgentSitePolicy(
        permissions,
        site.pattern,
        value === USE_DEFAULT ? rest : { ...rest, [key]: value },
      ),
    });
  };

  return (
    <SettingsSection
      {...searchableSetting("browser-agent-permissions")}
      headerAction={
        <Button size="xs" variant="outline" onClick={() => setAdding(true)}>
          <PlusIcon />
          Add site
        </Button>
      }
    >
      <div className="space-y-2 px-3 @xl/settings:px-4">
        <p className="text-[13px] text-muted-foreground/80">
          Choose default permissions and add exceptions for specific sites
        </p>
        <div className="overflow-x-auto">
          <div className="min-w-[36rem] space-y-1.5 text-sm">
            <div className={`${GRID} px-1 text-xs font-medium text-muted-foreground`}>
              <span>Site</span>
              {ACCESS_COLUMNS.map((column) => (
                <span key={column.key}>{column.label}</span>
              ))}
              <span />
            </div>
            <div className={`${GRID} rounded-lg bg-muted/40 px-1 py-1.5`}>
              <span className="font-medium">Default</span>
              {ACCESS_COLUMNS.map((column) => (
                <AccessSelect
                  key={column.key}
                  column={column}
                  value={permissions.defaults[column.key]}
                  allowDefault={false}
                  ariaLabel={`Default ${column.label} permission`}
                  onChange={(value) => setDefault(column.key, value)}
                />
              ))}
              <span />
            </div>
            {permissions.sites.map((site) => (
              <div key={site.pattern} className={`${GRID} px-1`}>
                <span className="truncate" title={site.pattern}>
                  {site.pattern}
                </span>
                {ACCESS_COLUMNS.map((column) => (
                  <AccessSelect
                    key={column.key}
                    column={column}
                    value={site[column.key] ?? USE_DEFAULT}
                    allowDefault
                    ariaLabel={`${column.label} permission for ${site.pattern}`}
                    onChange={(value) => setSiteAccess(site, column.key, value)}
                  />
                ))}
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Remove custom permissions for ${site.pattern}`}
                  onClick={() => setRemoving(site.pattern)}
                >
                  <Trash2Icon />
                </Button>
              </div>
            ))}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Only sites with custom permissions appear here
        </p>
      </div>

      {adding ? <AddSitePermissionDialog onClose={() => setAdding(false)} /> : null}

      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove custom permissions for {removing}?</AlertDialogTitle>
            <AlertDialogDescription>
              This resets this site's custom permissions to their defaults
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (removing !== null) {
                  saveBrowserSetting({
                    browserAgentPermissions: setBrowserAgentSitePolicy(permissions, removing, null),
                  });
                }
                setRemoving(null);
              }}
            >
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}

function AddSitePermissionDialog({ onClose }: { readonly onClose: () => void }) {
  const permissions = useClientSettings((settings) => settings.browserAgentPermissions);
  const [site, setSite] = useState("");
  const [access, setAccess] = useState<BrowserAgentAccess>(permissions.defaults);
  const [moreOptions, setMoreOptions] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = () => {
    const pattern = normalizeBrowserSitePattern(site);
    if (pattern === null) {
      setError("Enter a valid origin, such as https://example.com or https://*.example.com");
      return;
    }
    const custom = Object.fromEntries(
      Object.entries(access).filter(
        ([key, value]) => permissions.defaults[key as AccessKey] !== value,
      ),
    ) as Partial<BrowserAgentAccess>;
    if (Object.keys(custom).length === 0) {
      setError(
        "These permissions match the defaults, so adding this site would not change anything",
      );
      return;
    }
    const existing = permissions.sites.find((entry) => entry.pattern === pattern);
    saveBrowserSetting({
      browserAgentPermissions: setBrowserAgentSitePolicy(permissions, pattern, {
        ...(existing ? customAccess(existing) : {}),
        ...custom,
      }),
    });
    onClose();
  };

  const columns = moreOptions ? ACCESS_COLUMNS : ACCESS_COLUMNS.slice(0, 1);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="max-w-md">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
        >
          <DialogHeader>
            <DialogTitle>Add site permission</DialogTitle>
            <DialogDescription>Choose what access agents have on a site</DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <label className="block space-y-1.5 text-sm font-medium">
              Site
              <Input
                autoFocus
                placeholder="https://example.com"
                value={site}
                aria-invalid={error !== null}
                onChange={(event) => {
                  setSite(event.target.value);
                  setError(null);
                }}
              />
            </label>
            {columns.map((column) => (
              <div key={column.key} className="space-y-1.5 text-sm font-medium">
                <span>{column.label}</span>
                <AccessSelect
                  column={column}
                  value={access[column.key]}
                  allowDefault={false}
                  ariaLabel={`${column.label} permission`}
                  onChange={(value) => {
                    setAccess((current) => ({ ...current, [column.key]: value }));
                    setError(null);
                  }}
                />
              </div>
            ))}
            {moreOptions ? null : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="-ms-2 text-muted-foreground"
                onClick={() => setMoreOptions(true)}
              >
                More options
              </Button>
            )}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Add</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
