import { makeFunctionReference } from "convex/server";
import type {
  BusinessContactPage,
  BusinessContactSearchField,
} from "@spiritdevs/contracts/businessTools";
import { useAtomValue } from "@effect/atom-react";
import { activeCompanyIdAtom, companyListAtom } from "../../cloud/activeCompany";
import {
  companyRegistryMembershipIdsAtom,
  companyRegistryReplicasAtom,
} from "../../cloud/companyRegistryReplica";
import { contactPaginationReducer, initialContactPagination } from "./contactPagination";
import { canManageContactsFromReplica } from "./contactPermissions";
import { useBusinessToolsCloud, useBusinessToolsQuery } from "./businessToolsCloud";
import * as Schema from "effect/Schema";
import {
  Building2Icon,
  ChevronLeftIcon,
  ContactRoundIcon,
  MailIcon,
  MapPinIcon,
  PhoneIcon,
  PlusIcon,
  SearchIcon,
  StarIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useMemo, useReducer, useRef, useState, type FormEvent } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useIsMobile } from "~/hooks/useMediaQuery";
import { cn, randomUUID } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Field, FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Textarea } from "../ui/textarea";
import { WorkspaceViewFrame } from "../workspace/WorkspaceViewFrame";
import { contactInitials, type ContactRecord } from "./contacts.logic";

const CONTACTS_STORAGE_KEY = "pathway:contacts";
const ContactRecordSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  role: Schema.String,
  company: Schema.String,
  email: Schema.String,
  phone: Schema.String,
  notes: Schema.String,
  favorite: Schema.Boolean,
  createdAt: Schema.String,
});
const ContactsSchema = Schema.Array(ContactRecordSchema);
const EMPTY_CONTACTS: readonly ContactRecord[] = [];

function AddContactDialog({
  onAdd,
  contact,
}: {
  onAdd: (contact: ContactRecord, requestId: string) => Promise<void>;
  contact?: ContactRecord;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [identity, setIdentity] = useState(() => ({ id: randomUUID(), requestId: randomUUID() }));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = String(data.get("name") ?? "").trim();
    if (!name) return;
    setSaving(true);
    setError(null);
    try {
      await onAdd(
        {
          id: contact?.id ?? identity.id,
          name,
          role: String(data.get("role") ?? "").trim(),
          company: String(data.get("company") ?? "").trim(),
          email: String(data.get("email") ?? "").trim(),
          phone: String(data.get("phone") ?? "").trim(),
          notes: String(data.get("notes") ?? "").trim(),
          favorite: contact?.favorite ?? false,
          createdAt: contact?.createdAt ?? new Date().toISOString(),
          ...(contact?.revision === undefined ? {} : { revision: contact.revision }),
        },
        identity.requestId,
      );
      form.reset();
      setIdentity({ id: randomUUID(), requestId: randomUUID() });
      setOpen(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" onClick={() => setOpen(true)}>
        <PlusIcon />
        {contact ? "Edit contact" : "Add contact"}
      </Button>
      <DialogPopup>
        <form
          onSubmit={submit}
          onChange={() => setIdentity((current) => ({ ...current, requestId: randomUUID() }))}
        >
          <DialogHeader>
            <DialogTitle>{contact ? "Edit contact" : "Add contact"}</DialogTitle>
            <DialogDescription>
              This contact is shared with members of the selected workspace.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="grid gap-4 sm:grid-cols-2">
            <Field className="sm:col-span-2">
              <FieldLabel>Name</FieldLabel>
              <Input
                defaultValue={contact?.name}
                name="name"
                autoFocus
                required
                autoComplete="name"
              />
            </Field>
            <Field>
              <FieldLabel>Role</FieldLabel>
              <Input defaultValue={contact?.role} name="role" autoComplete="organization-title" />
            </Field>
            <Field>
              <FieldLabel>Company</FieldLabel>
              <Input defaultValue={contact?.company} name="company" autoComplete="organization" />
            </Field>
            <Field>
              <FieldLabel>Email</FieldLabel>
              <Input defaultValue={contact?.email} name="email" type="email" autoComplete="email" />
            </Field>
            <Field>
              <FieldLabel>Phone</FieldLabel>
              <Input defaultValue={contact?.phone} name="phone" type="tel" autoComplete="tel" />
            </Field>
            <Field className="sm:col-span-2">
              <FieldLabel>Notes</FieldLabel>
              <Textarea
                name="notes"
                defaultValue={contact?.notes}
                placeholder="Context, follow-ups, or anything worth remembering"
              />
            </Field>
          </DialogPanel>
          {error ? (
            <p role="alert" className="px-6 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Keep browsing
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save contact"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function ContactAvatar({ name, large = false }: { name: string; large?: boolean }) {
  const palette = [
    "bg-blue-500/12 text-blue-700 dark:text-blue-300",
    "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
    "bg-amber-500/14 text-amber-800 dark:text-amber-300",
    "bg-rose-500/12 text-rose-700 dark:text-rose-300",
  ];
  const color =
    palette[
      [...name].reduce((sum, character) => sum + character.charCodeAt(0), 0) % palette.length
    ];
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full font-semibold tracking-tight",
        large ? "size-16 text-xl" : "size-9 text-xs",
        color,
      )}
    >
      {contactInitials(name)}
    </span>
  );
}

function ContactDetail({
  contact,
  onBack,
  onDelete,
  onToggleFavorite,
  canManage,
}: {
  contact: ContactRecord;
  onBack: () => void;
  onDelete: () => void;
  onToggleFavorite: () => void;
  canManage: boolean;
}) {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto flex w-full max-w-3xl flex-col px-6 py-8 sm:px-10 sm:py-12">
        <Button className="mb-6 w-fit sm:hidden" size="sm" variant="ghost" onClick={onBack}>
          <ChevronLeftIcon />
          All contacts
        </Button>
        <div className="flex items-start gap-5">
          <ContactAvatar name={contact.name} large />
          <div className="min-w-0 flex-1">
            <h1 className="font-heading text-2xl font-semibold tracking-tight">{contact.name}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {[contact.role, contact.company].filter(Boolean).join(" · ") || "No role added"}
            </p>
          </div>
          {canManage ? (
            <Button
              size="icon"
              variant="ghost"
              aria-label={contact.favorite ? "Remove from favorites" : "Add to favorites"}
              aria-pressed={contact.favorite}
              onClick={onToggleFavorite}
            >
              <StarIcon className={cn(contact.favorite && "fill-amber-400 text-amber-500")} />
            </Button>
          ) : null}
        </div>

        <div className="mt-10 grid border-y border-border/70 sm:grid-cols-2 sm:divide-x sm:divide-border/70">
          <div className="space-y-5 py-6 sm:pr-8">
            <p className="text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
              Contact
            </p>
            {contact.email ? (
              <a
                className="flex items-center gap-3 text-sm hover:underline"
                href={`mailto:${contact.email}`}
              >
                <MailIcon className="size-4 text-muted-foreground" />
                <span className="min-w-0 truncate">{contact.email}</span>
              </a>
            ) : null}
            {contact.phone ? (
              <a
                className="flex items-center gap-3 text-sm hover:underline"
                href={`tel:${contact.phone}`}
              >
                <PhoneIcon className="size-4 text-muted-foreground" />
                <span>{contact.phone}</span>
              </a>
            ) : null}
            {!contact.email && !contact.phone ? (
              <p className="text-sm text-muted-foreground">No contact details added.</p>
            ) : null}
          </div>
          <div className="space-y-5 py-6 sm:pl-8">
            <p className="text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
              Work
            </p>
            {contact.company ? (
              <div className="flex items-center gap-3 text-sm">
                <Building2Icon className="size-4 text-muted-foreground" />
                <span>{contact.company}</span>
              </div>
            ) : (
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <MapPinIcon className="size-4" />
                No company added
              </div>
            )}
          </div>
        </div>

        <section className="mt-8">
          <h2 className="text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
            Notes
          </h2>
          <p className="mt-3 max-w-[65ch] whitespace-pre-wrap text-sm leading-6 text-foreground/85">
            {contact.notes || "No notes yet."}
          </p>
        </section>

        {canManage ? (
          <div className="mt-12 border-t border-border/70 pt-5">
            <Button size="sm" variant="destructive-outline" onClick={onDelete}>
              <Trash2Icon />
              Delete contact
            </Button>
          </div>
        ) : null}
      </div>
    </ScrollArea>
  );
}

export function ContactsView() {
  const [legacyContacts] = useLocalStorage(CONTACTS_STORAGE_KEY, EMPTY_CONTACTS, ContactsSchema);
  const companyID = useAtomValue(activeCompanyIdAtom);
  const companies = useAtomValue(companyListAtom);
  const cloud = useBusinessToolsCloud();
  const replicas = useAtomValue(companyRegistryReplicasAtom);
  const memberships = useAtomValue(companyRegistryMembershipIdsAtom);
  const replica = companyID ? replicas.get(companyID) : undefined;
  const membershipID = companyID ? (memberships.get(companyID) ?? null) : null;
  const canManage = useMemo(
    () =>
      Boolean(cloud.client) &&
      canManageContactsFromReplica(replica?.view.values() ?? [], membershipID),
    [cloud.client, replica, membershipID],
  );
  const [query, setQuery] = useState("");
  const [searchField, setSearchField] = useState<BusinessContactSearchField>("name");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const result = useBusinessToolsQuery<BusinessContactPage>(
    cloud.client,
    cloud.accountID,
    "contacts:list",
    companyID ? { companyId: companyID, search: query, searchField, favoritesOnly } : null,
  );
  const latestPage = useRef(result.value);
  const latestScope = useRef(result.key);
  useEffect(() => {
    latestPage.current = result.value;
    latestScope.current = result.key;
    return () => {
      latestPage.current = undefined;
      latestScope.current = "";
    };
  }, [result.value, result.key]);
  const [pagination, dispatchPages] = useReducer(
    contactPaginationReducer,
    initialContactPagination,
  );
  const { history, request: pageRequest } = pagination;
  const currentHistory = history?.base === result.value ? history : null;
  const contacts = currentHistory?.contacts ?? result.value?.contacts ?? [];
  const cursor = currentHistory ? currentHistory.cursor : result.value?.cursor;
  const isDone = currentHistory?.isDone ?? result.value?.isDone ?? true;
  const loadingMore =
    pageRequest !== null && pageRequest.base === result.value && pageRequest.loading;
  const pageError =
    pageRequest !== null && pageRequest.base === result.value ? pageRequest.error : undefined;
  const loadMore = async () => {
    if (!cloud.client || !companyID || !result.value || !cursor || loadingMore) return;
    const base = result.value;
    const generation = pagination.generation;
    dispatchPages({ type: "request", generation, base });
    try {
      const page = await cloud.client.query(
        makeFunctionReference<
          "query",
          {
            companyId: string;
            search: string;
            searchField: BusinessContactSearchField;
            favoritesOnly: boolean;
            cursor: string;
          },
          BusinessContactPage
        >("contacts:list"),
        { companyId: companyID, search: query, searchField, favoritesOnly, cursor },
      );
      if (latestPage.current !== base) return;
      const ids = new Set(contacts.map((row) => row.id));
      dispatchPages({
        type: "loaded",
        generation,
        history: {
          base,
          contacts: [...contacts, ...page.contacts.filter((row) => !ids.has(row.id))],
          cursor: page.cursor,
          isDone: page.isDone,
        },
      });
    } catch (error) {
      if (latestPage.current !== base) return;
      dispatchPages({
        type: "failed",
        generation,
        base,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [confirmImport, setConfirmImport] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const isMobile = useIsMobile();
  const filteredContacts = contacts;
  const detail = useBusinessToolsQuery<ContactRecord | null>(
    cloud.client,
    cloud.accountID,
    "contacts:get",
    companyID && selectedId ? { companyId: companyID, id: selectedId } : null,
  );
  const explicitlySelectedContact =
    detail.value === null || detail.error
      ? null
      : (detail.value ?? contacts.find(({ id }) => id === selectedId) ?? null);
  const selectedContact =
    explicitlySelectedContact ?? (isMobile ? null : (filteredContacts[0] ?? null));

  useEffect(() => {
    if (selectedContact && selectedId !== selectedContact.id) setSelectedId(selectedContact.id);
  }, [selectedContact, selectedId]);

  const addContact = async (contact: ContactRecord, requestId: string) => {
    if (!companyID || !canManage)
      throw new Error("You need projects.manage permission to change contacts in this workspace.");
    const { id, name, role, company, email, phone, notes, favorite } = contact;
    const scope = result.key;
    await cloud.request("contacts:upsert", {
      companyId: companyID,
      id,
      requestId,
      expectedRevision: contact.revision ?? null,
      name,
      role,
      company,
      email,
      phone,
      notes,
      favorite,
    });
    if (latestScope.current !== scope) return;
    dispatchPages({ type: "invalidate" });
    setSelectedId(contact.id);
  };
  const run = (operation: () => Promise<unknown>) => {
    setError(null);
    void operation().catch((error: unknown) =>
      setError(error instanceof Error ? error.message : String(error)),
    );
  };

  return (
    <WorkspaceViewFrame
      title="Contacts"
      actions={
        canManage ? (
          <div className="flex gap-2">
            {selectedContact ? (
              <AddContactDialog
                key={selectedContact.id + selectedContact.revision}
                contact={selectedContact}
                onAdd={addContact}
              />
            ) : null}
            <AddContactDialog onAdd={addContact} />
          </div>
        ) : undefined
      }
    >
      {!companyID ? (
        <p className="p-4 text-sm">
          Select a workspace from the sidebar to view its shared contacts.
        </p>
      ) : null}
      {result.error || error || pageError ? (
        <p role="alert" className="p-4 text-sm text-destructive">
          {error ?? result.error ?? pageError}
        </p>
      ) : null}
      {canManage && legacyContacts.length > 0 ? (
        <div className="flex items-center gap-3 border-b p-3 text-sm">
          <span>{legacyContacts.length} contacts remain stored on this device.</span>
          <Button variant="outline" size="sm" onClick={() => setConfirmImport(true)}>
            Import local contacts…
          </Button>
        </div>
      ) : null}
      <Dialog open={confirmImport && canManage} onOpenChange={setConfirmImport}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              Import contacts into{" "}
              {companies.find((row) => row.id === companyID)?.name ?? "this workspace"}?
            </DialogTitle>
            <DialogDescription>
              Members of this workspace will be able to read these {legacyContacts.length} contacts.
              The originals stay on this device. Repeating an import does not duplicate contacts.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmImport(false)}>
              Cancel
            </Button>
            <Button
              disabled={importing || !canManage}
              onClick={() => {
                if (!canManage || !companyID) return;
                setImporting(true);
                run(async () => {
                  try {
                    for (let index = 0; index < legacyContacts.length; index += 200)
                      await cloud.request("contacts:importLocal", {
                        companyId: companyID!,
                        contacts: legacyContacts
                          .slice(index, index + 200)
                          .map((contact) => ({ ...contact })),
                      });
                    setConfirmImport(false);
                  } finally {
                    setImporting(false);
                  }
                });
              }}
            >
              {importing ? "Importing…" : "Import contacts"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <aside className="flex w-full min-h-0 flex-col border-r border-border/70 sm:w-80 sm:shrink-0">
          <div className="border-b border-border/70 p-3">
            <label className="mb-2 flex items-center gap-2 text-sm">
              Search in
              <select
                aria-label="Contact search field"
                value={searchField}
                onChange={(event) =>
                  setSearchField(event.target.value as BusinessContactSearchField)
                }
                className="min-w-0 flex-1 rounded border bg-background p-1"
              >
                <option value="name">Name</option>
                <option value="role">Role</option>
                <option value="company">Company</option>
                <option value="email">Email</option>
                <option value="phone">Phone</option>
              </select>
            </label>
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                aria-label="Search contacts"
                placeholder="Search the full directory"
                maxLength={240}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="pl-8"
              />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Matches words or a word prefix in the selected field across the entire workspace.
            </p>
            <label className="mt-2 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={favoritesOnly}
                onChange={(event) => setFavoritesOnly(event.target.checked)}
              />
              Favorites only
            </label>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            {filteredContacts.length === 0 ? (
              <div className="px-5 py-12 text-center text-sm text-muted-foreground">
                {!result.value
                  ? "Loading contacts…"
                  : query.trim() || favoritesOnly
                    ? "No contacts match your search."
                    : contacts.length === 0
                      ? canManage
                        ? "Add your first contact to get started."
                        : "This workspace has no contacts yet."
                      : "No contacts match your search."}
              </div>
            ) : (
              <div className="p-2">
                {filteredContacts.map((contact) => (
                  <button
                    key={contact.id}
                    type="button"
                    aria-current={selectedContact?.id === contact.id ? "true" : undefined}
                    className={cn(
                      "flex min-h-14 w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                      selectedContact?.id === contact.id
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-muted/60",
                    )}
                    onClick={() => setSelectedId(contact.id)}
                  >
                    <ContactAvatar name={contact.name} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 text-sm font-medium">
                        <span className="truncate">{contact.name}</span>
                        {contact.favorite ? (
                          <StarIcon className="size-3 fill-amber-400 text-amber-500" />
                        ) : null}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {[contact.role, contact.company].filter(Boolean).join(" · ") ||
                          contact.email ||
                          "Contact"}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            {!isDone ? (
              <Button
                className="m-3"
                variant="outline"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? "Loading…" : "Load more contacts"}
              </Button>
            ) : null}
            {currentHistory ? (
              <Button
                className="m-3"
                variant="ghost"
                onClick={() => dispatchPages({ type: "invalidate" })}
              >
                Refresh directory
              </Button>
            ) : null}
          </ScrollArea>
        </aside>
        <main
          className={cn(
            "min-h-0 min-w-0 flex-1",
            "flex",
            selectedContact
              ? "max-sm:absolute max-sm:inset-0 max-sm:z-10 max-sm:bg-background"
              : "max-sm:hidden",
          )}
        >
          {selectedContact ? (
            <ContactDetail
              contact={selectedContact}
              canManage={canManage}
              onBack={() => setSelectedId(null)}
              onToggleFavorite={() =>
                run(() =>
                  addContact(
                    { ...selectedContact, favorite: !selectedContact.favorite },
                    randomUUID(),
                  ),
                )
              }
              onDelete={() =>
                run(async () => {
                  if (!canManage || !companyID) return;
                  await cloud.request("contacts:remove", {
                    companyId: companyID!,
                    id: selectedContact.id,
                    expectedRevision: selectedContact.revision ?? 0,
                  });
                  dispatchPages({ type: "remove", base: result.value, id: selectedContact.id });
                  setSelectedId(null);
                })
              }
            />
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ContactRoundIcon />
                </EmptyMedia>
                <EmptyTitle>Your people, close at hand</EmptyTitle>
                <EmptyDescription>
                  {canManage
                    ? "Add a contact to keep useful context beside your work."
                    : "Choose a contact to view its details."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </main>
      </div>
    </WorkspaceViewFrame>
  );
}
