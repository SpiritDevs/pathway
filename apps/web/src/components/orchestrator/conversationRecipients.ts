export type ConversationRecipient = { id: string; name: string; canDirect: boolean };

export function recipientQuery(text: string, caret: number) {
  const before = text.slice(0, caret);
  const match = /(?:^|\s)@([^@\n]*)$/.exec(before);
  return match ? { start: caret - match[1]!.length - 1, end: caret, query: match[1]! } : null;
}

export function eligibleRecipients<T extends ConversationRecipient>(
  contacts: readonly T[],
  memberIds: readonly string[],
  query = "",
) {
  return contacts.filter(
    (contact) =>
      contact.canDirect &&
      memberIds.includes(contact.id) &&
      contact.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
}

export function recipientTarget<T extends ConversationRecipient>(
  contacts: readonly T[],
  leadId: string,
  selectedId?: string,
  replyId?: string,
  locked = false,
) {
  // A worker reply is bound to its work item; an ordinary reply can be addressed explicitly.
  const id = locked ? (replyId ?? leadId) : (selectedId ?? replyId ?? leadId);
  return contacts.find((contact) => contact.id === id && contact.canDirect);
}
