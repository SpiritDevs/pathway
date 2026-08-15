export interface ContactRecord {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly company: string;
  readonly email: string;
  readonly phone: string;
  readonly notes: string;
  readonly favorite: boolean;
  readonly createdAt: string;
}

export function contactInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0]?.at(0) ?? "";
  const last = words.length > 1 ? (words.at(-1)?.at(0) ?? "") : "";
  return `${first}${last}`.toUpperCase();
}

export function filterContacts(
  contacts: readonly ContactRecord[],
  query: string,
): readonly ContactRecord[] {
  const needle = query.trim().toLocaleLowerCase();
  return contacts
    .filter((contact) => {
      if (!needle) return true;
      return [contact.name, contact.role, contact.company, contact.email, contact.phone].some(
        (value) => value.toLocaleLowerCase().includes(needle),
      );
    })
    .toSorted(
      (left, right) =>
        Number(right.favorite) - Number(left.favorite) || left.name.localeCompare(right.name),
    );
}
