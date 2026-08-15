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
import { useEffect, useMemo, useState, type FormEvent } from "react";

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
import { contactInitials, filterContacts, type ContactRecord } from "./contacts.logic";

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

function AddContactDialog({ onAdd }: { onAdd: (contact: ContactRecord) => void }) {
  const [open, setOpen] = useState(false);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = String(data.get("name") ?? "").trim();
    if (!name) return;
    onAdd({
      id: randomUUID(),
      name,
      role: String(data.get("role") ?? "").trim(),
      company: String(data.get("company") ?? "").trim(),
      email: String(data.get("email") ?? "").trim(),
      phone: String(data.get("phone") ?? "").trim(),
      notes: String(data.get("notes") ?? "").trim(),
      favorite: false,
      createdAt: new Date().toISOString(),
    });
    form.reset();
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" onClick={() => setOpen(true)}>
        <PlusIcon />
        Add contact
      </Button>
      <DialogPopup>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Add contact</DialogTitle>
            <DialogDescription>
              Contacts are saved locally on this device for now.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="grid gap-4 sm:grid-cols-2">
            <Field className="sm:col-span-2">
              <FieldLabel>Name</FieldLabel>
              <Input name="name" autoFocus required autoComplete="name" />
            </Field>
            <Field>
              <FieldLabel>Role</FieldLabel>
              <Input name="role" autoComplete="organization-title" />
            </Field>
            <Field>
              <FieldLabel>Company</FieldLabel>
              <Input name="company" autoComplete="organization" />
            </Field>
            <Field>
              <FieldLabel>Email</FieldLabel>
              <Input name="email" type="email" autoComplete="email" />
            </Field>
            <Field>
              <FieldLabel>Phone</FieldLabel>
              <Input name="phone" type="tel" autoComplete="tel" />
            </Field>
            <Field className="sm:col-span-2">
              <FieldLabel>Notes</FieldLabel>
              <Textarea
                name="notes"
                placeholder="Context, follow-ups, or anything worth remembering"
              />
            </Field>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Keep browsing
            </Button>
            <Button type="submit">Add contact</Button>
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
}: {
  contact: ContactRecord;
  onBack: () => void;
  onDelete: () => void;
  onToggleFavorite: () => void;
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
          <Button
            size="icon"
            variant="ghost"
            aria-label={contact.favorite ? "Remove from favorites" : "Add to favorites"}
            aria-pressed={contact.favorite}
            onClick={onToggleFavorite}
          >
            <StarIcon className={cn(contact.favorite && "fill-amber-400 text-amber-500")} />
          </Button>
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

        <div className="mt-12 border-t border-border/70 pt-5">
          <Button size="sm" variant="destructive-outline" onClick={onDelete}>
            <Trash2Icon />
            Delete contact
          </Button>
        </div>
      </div>
    </ScrollArea>
  );
}

export function ContactsView() {
  const [contacts, setContacts] = useLocalStorage(
    CONTACTS_STORAGE_KEY,
    EMPTY_CONTACTS,
    ContactsSchema,
  );
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const isMobile = useIsMobile();
  const filteredContacts = useMemo(() => filterContacts(contacts, query), [contacts, query]);
  const explicitlySelectedContact = contacts.find(({ id }) => id === selectedId) ?? null;
  const selectedContact =
    explicitlySelectedContact ?? (isMobile ? null : (filteredContacts[0] ?? null));

  useEffect(() => {
    if (selectedContact && selectedId !== selectedContact.id) setSelectedId(selectedContact.id);
  }, [selectedContact, selectedId]);

  const addContact = (contact: ContactRecord) => {
    setContacts((current) => [...current, contact]);
    setSelectedId(contact.id);
  };

  return (
    <WorkspaceViewFrame title="Contacts" actions={<AddContactDialog onAdd={addContact} />}>
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <aside className="flex w-full min-h-0 flex-col border-r border-border/70 sm:w-80 sm:shrink-0">
          <div className="border-b border-border/70 p-3">
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                aria-label="Search contacts"
                placeholder="Search contacts"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="pl-8"
              />
            </div>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            {filteredContacts.length === 0 ? (
              <div className="px-5 py-12 text-center text-sm text-muted-foreground">
                {contacts.length === 0
                  ? "Add your first contact to get started."
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
              onBack={() => setSelectedId(null)}
              onToggleFavorite={() =>
                setContacts((current) =>
                  current.map((contact) =>
                    contact.id === selectedContact.id
                      ? { ...contact, favorite: !contact.favorite }
                      : contact,
                  ),
                )
              }
              onDelete={() => {
                setContacts((current) => current.filter(({ id }) => id !== selectedContact.id));
                setSelectedId(null);
              }}
            />
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ContactRoundIcon />
                </EmptyMedia>
                <EmptyTitle>Your people, close at hand</EmptyTitle>
                <EmptyDescription>
                  Add a contact to keep useful context beside your work.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </main>
      </div>
    </WorkspaceViewFrame>
  );
}
