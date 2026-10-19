import {
  PersonalConversation,
  type ConversationShare,
  type ConversationShareAccess,
} from "@spiritdevs/contracts";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";

export type ConversationAddress = { environmentId: string; threadId: string };
export type ConversationRecipient = {
  companyId: string;
  companyName: string;
  userId: string;
  name: string;
};
const refs = {
  list: makeFunctionReference<"query", Record<string, never>, unknown>("conversationShares:list"),
  recipients: makeFunctionReference<"query", ConversationAddress, ConversationRecipient[]>(
    "conversationShares:recipients",
  ),
  shares: makeFunctionReference<"query", ConversationAddress, ConversationShare[]>(
    "conversationShares:listShares",
  ),
  share: makeFunctionReference<
    "mutation",
    ConversationAddress & {
      companyId: string;
      recipientUserId: string;
      access: ConversationShareAccess;
    },
    string
  >("conversationShares:share"),
  revoke: makeFunctionReference<"mutation", { shareId: string }, null>("conversationShares:revoke"),
  connect: makeFunctionReference<
    "action",
    { shareId: string },
    { token: string; environmentId: string; expiresAt: number }
  >("conversationShares:issueConnectGrant"),
};

export const personalConversationsAtom = Atom.make<ReadonlyArray<PersonalConversation>>([]).pipe(
  Atom.keepAlive,
);
const decodePersonalConversations = Schema.decodeUnknownOption(Schema.Array(PersonalConversation));

export interface ConversationSharingMutations {
  recipients: (address: ConversationAddress) => Promise<ConversationRecipient[]>;
  shares: (address: ConversationAddress) => Promise<ConversationShare[]>;
  share: (
    input: ConversationAddress & {
      companyId: string;
      recipientUserId: string;
      access: ConversationShareAccess;
    },
  ) => Promise<string>;
  revoke: (shareId: string) => Promise<null>;
  issueConnectGrant: (
    shareId: string,
  ) => Promise<{ token: string; environmentId: string; expiresAt: number }>;
}

export const conversationSharingMutationsAtom = Atom.make<ConversationSharingMutations | null>(
  null,
).pipe(Atom.keepAlive);

/** Reuses the signed-in account's existing cloud connection and clears personal state on teardown. */
export function subscribePersonalConversations(client: ConvexClient): () => void {
  const mutations: ConversationSharingMutations = {
    recipients: (address) => client.query(refs.recipients, address),
    shares: (address) => client.query(refs.shares, address),
    share: (input) => client.mutation(refs.share, input),
    revoke: (shareId) => client.mutation(refs.revoke, { shareId }),
    issueConnectGrant: (shareId) => client.action(refs.connect, { shareId }),
  };
  appAtomRegistry.set(conversationSharingMutationsAtom, mutations);
  const stop = client.onUpdate(
    refs.list,
    {},
    (value) => {
      const decoded = decodePersonalConversations(value);
      appAtomRegistry.set(personalConversationsAtom, Option.isSome(decoded) ? decoded.value : []);
    },
    () => appAtomRegistry.set(personalConversationsAtom, []),
  );
  return () => {
    stop();
    if (appAtomRegistry.get(conversationSharingMutationsAtom) === mutations) {
      appAtomRegistry.set(conversationSharingMutationsAtom, null);
      appAtomRegistry.set(personalConversationsAtom, []);
    }
  };
}
