// @effect-diagnostics globalDate:off -- Convex mutations are not Effect programs; the transaction clock is `Date.now()`.
/**
 * The synchronization surface: `bootstrap`, `latestVersion`, `listChanges`, `applyOperations`, and
 * `reserveIssueKeys`.
 *
 * Clients subscribe only to `latestVersion` — one small row — and drain bounded change pages from
 * their persisted cursor when it advances. Subscribing to the pages themselves would resend a
 * company's history on every edit.
 *
 * The five signatures are the ones `contracts/cloudSync` declares in `SYNC_FUNCTIONS`, and every
 * request and response here mirrors its `Sync*Request`/`Sync*Response` shapes. The contract is the
 * source of truth; this module is what changes when they disagree.
 *
 * @module sync
 */
import { v } from "convex/values";

import { reserveIssueKeyBlock, ISSUE_KEY_BLOCK_SIZE, formatIssueKey } from "../src/issueKeys.ts";
import {
  bootstrapKindAfter,
  decodeBootstrapCursor,
  encodeBootstrapCursor,
  initialBootstrapState,
  type BootstrapCursorState,
  type BootstrapEntityKind,
} from "../src/sync/bootstrap.ts";
import {
  changeRetainUntil,
  clampPageLimit,
  measureSerializedBytes,
  takeChangePage,
} from "../src/sync/changeFeed.ts";
import {
  assignVersions,
  partitionByExistingReceipts,
  replayStoredReceipt,
  validateOperationBatch,
  type OperationReceipt,
  type StoredOperationReceipt,
  type SyncOperationEnvelope,
} from "../src/sync/operations.ts";
import {
  SYNC_BOOTSTRAP_PAGE_SIZE,
  SYNC_MAX_CHANGE_PAGE_BYTES,
  SYNC_MAX_CHANGES_PER_PAGE,
  type SyncChangeKind,
  type SyncEntityKind,
  type SyncOperationKind,
  type SyncRejectionCode,
} from "../src/sync/protocol.ts";
import { isChangeVisible } from "../src/sync/visibility.ts";
import type { Doc, Id } from "./_generated/dataModel.js";
import { mutation, query } from "./_generated/server.js";
import type { MutationCtx } from "./_generated/server.js";
import { requireCloudSyncEnabled } from "./lib/capability.ts";
import { backendError } from "./lib/errors.ts";
import { actorRecord, requireCompanyActor, type CompanyActor } from "./lib/identity.ts";
import { emptyBootstrapCache, readBootstrapRows, ISSUE_DOMAIN_APPLY } from "./lib/issueApply.ts";
import {
  domainIdArg,
  operationReceiptResult,
  syncChangeResult,
  syncOperationArg,
} from "./lib/validators.ts";

/**
 * The head every client subscribes to. Deliberately tiny: it carries the version and the
 * authorization epoch and nothing else, so a busy company does not push payloads at idle clients.
 */
export const latestVersion = query({
  args: { companyId: domainIdArg },
  returns: v.object({ version: v.number(), authorizationEpoch: v.number() }),
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const actor = await requireCompanyActor(ctx, args.companyId);
    return {
      version: actor.company.syncVersion,
      authorizationEpoch: actor.company.authorizationEpoch,
    };
  },
});

/**
 * One drained page of the change feed, filtered by current authorization, or the instruction to
 * start over. The result is the `SyncListChangesResponse` union from the contracts, tagged so the
 * two outcomes cannot be confused with each other.
 *
 * `Changes.cursor` advances over rows the caller may not read. A page that filtering empties is a
 * normal result, not an end-of-feed signal: without that, one unreadable team would wedge a
 * member's sync forever.
 *
 * `CursorExpired` means the changes that would have carried the caller forward have been pruned at
 * the 90-day retention line, so no amount of draining can close the gap and the client bootstraps.
 */
export const listChanges = query({
  args: {
    companyId: domainIdArg,
    cursor: v.number(),
    limit: v.optional(v.number()),
  },
  returns: v.union(
    v.object({
      _tag: v.literal("Changes"),
      changes: v.array(syncChangeResult),
      cursor: v.number(),
      hasMore: v.boolean(),
      latestVersion: v.number(),
      authorizationEpoch: v.number(),
    }),
    v.object({
      _tag: v.literal("CursorExpired"),
      latestVersion: v.number(),
      authorizationEpoch: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const actor = await requireCompanyActor(ctx, args.companyId);
    // Clamped at both ends: Convex validates `limit` as a number, so a client asking for zero or a
    // negative page would otherwise be handed an empty page at its own cursor with `hasMore` set,
    // and drain forever without ever making progress.
    const limit = clampPageLimit(args.limit, SYNC_MAX_CHANGES_PER_PAGE);

    // A cursor of N means "I have everything through N", so the next row the client needs is N+1.
    // If the oldest surviving row is past that, the versions in between were pruned and are gone.
    const oldest = await ctx.db
      .query("syncChanges")
      .withIndex("by_company_and_version", (q) => q.eq("companyId", actor.company._id))
      .order("asc")
      .first();
    const expired =
      oldest === null ? args.cursor < actor.company.syncVersion : args.cursor < oldest.version - 1;
    if (expired) {
      return {
        _tag: "CursorExpired" as const,
        latestVersion: actor.company.syncVersion,
        authorizationEpoch: actor.company.authorizationEpoch,
      };
    }

    // Over-read so filtering cannot produce a short page while unread rows remain.
    const rows = await ctx.db
      .query("syncChanges")
      .withIndex("by_company_and_version", (q) =>
        q.eq("companyId", actor.company._id).gt("version", args.cursor),
      )
      .order("asc")
      .take(SYNC_MAX_CHANGES_PER_PAGE);

    const toEnvelope = (row: Doc<"syncChanges">) => ({
      version: row.version,
      entityKind: row.entityKind,
      entityId: row.entityId,
      changeKind: row.changeKind,
      payload: row.payload,
    });

    const page = takeChangePage(rows, args.cursor, {
      maxRows: limit,
      // Measured over the whole envelope in UTF-8 bytes, because that is what crosses the wire —
      // the ids and kinds ride along with the payload, and a non-ASCII payload costs more bytes
      // than it has characters.
      sizeOf: (row) => measureSerializedBytes(toEnvelope(row)),
      isVisible: (row) => isChangeVisible(actor.permissions, row),
    });

    // One row bigger than a whole page still ships, alone, because the alternative is a feed that
    // can never move past it. It is loud about it so an entity that outgrew the ceiling shows up
    // in the logs instead of quietly blowing the response budget on every drain.
    if (page.oversizedRow !== null) {
      // @effect-diagnostics-next-line globalConsole:off - Convex functions run in Convex's V8 runtime with no Effect runtime; console is its log stream.
      console.warn("sync.listChanges delivered an oversized change alone", {
        companyId: args.companyId,
        version: page.oversizedRow.version,
        bytes: page.oversizedRow.bytes,
        maxBytes: SYNC_MAX_CHANGE_PAGE_BYTES,
      });
    }

    return {
      _tag: "Changes" as const,
      changes: page.changes.map(toEnvelope),
      cursor: page.cursor,
      hasMore: page.hasMore || rows.length === SYNC_MAX_CHANGES_PER_PAGE,
      latestVersion: actor.company.syncVersion,
      authorizationEpoch: actor.company.authorizationEpoch,
    };
  },
});

/**
 * Full paginated seed for a client with no usable cursor — a new device, or one whose cursor
 * predates the retained feed.
 *
 * The walk order and cursor token live in `src/sync/bootstrap`; the row readers and payload
 * encoders are shared with the apply handlers in `lib/issueApply`, so a bootstrapped entity is
 * byte-for-byte what an incremental upsert of it would carry.
 *
 * `version` is the company head captured on the *first* page and carried in the cursor token: a
 * write landing mid-seed bears a higher version, so an incremental drain from that head re-delivers
 * it as an idempotent upsert (or a tombstone for a row the seed still included) — no gap, no
 * double-apply hazard. Deleted and unreadable rows consume walk budget without being delivered,
 * exactly as `listChanges` advances its cursor over rows the caller may not read.
 */
export const bootstrap = query({
  args: {
    companyId: domainIdArg,
    cursor: v.union(v.string(), v.null()),
    pageSize: v.optional(v.number()),
  },
  returns: v.object({
    version: v.number(),
    authorizationEpoch: v.number(),
    entities: v.array(syncChangeResult),
    cursor: v.union(v.string(), v.null()),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const actor = await requireCompanyActor(ctx, args.companyId);

    let state: BootstrapCursorState;
    if (args.cursor === null) {
      state = initialBootstrapState(actor.company.syncVersion);
    } else {
      const decoded = decodeBootstrapCursor(args.cursor);
      // A token this build cannot read — tampered, or minted by a deployment with a different
      // walk — must restart the seed, not resume from a position that means something else now.
      if (decoded === null) {
        throw backendError("invalid-arguments", "Unrecognized bootstrap cursor.");
      }
      state = decoded;
    }

    const pageSize = clampPageLimit(args.pageSize, SYNC_BOOTSTRAP_PAGE_SIZE);
    const cache = emptyBootstrapCache();
    const entities: {
      version: number;
      entityKind: string;
      entityId: string;
      changeKind: SyncChangeKind;
      payload: unknown;
    }[] = [];
    let bytes = 0;

    let kind: BootstrapEntityKind | null = state.entityKind;
    let afterId = state.afterId;
    // Every scanned row — delivered, deleted, or unreadable — costs one unit, so a call's total
    // reads are bounded by the page size no matter how much of a table filtering hides.
    let budget = pageSize;
    let pageFull = false;

    while (kind !== null && !pageFull && budget > 0) {
      const limit = budget;
      const rows = await readBootstrapRows(ctx, actor.company, kind, afterId, limit, cache);
      for (const row of rows) {
        if (
          !row.deleted &&
          isChangeVisible(actor.permissions, { entityKind: kind, teamIds: row.teamIds })
        ) {
          const envelope = {
            version: row.version,
            entityKind: kind as string,
            entityId: row.id,
            changeKind: "upsert" as const,
            payload: row.payload,
          };
          const size = measureSerializedBytes(envelope);
          // The first entity ships regardless of size — a row bigger than a whole page must still
          // be deliverable, alone — but is not consumed here if the page already holds anything,
          // so the next call re-reads it at the top of its page.
          if (entities.length > 0 && bytes + size > SYNC_MAX_CHANGE_PAGE_BYTES) {
            pageFull = true;
            break;
          }
          entities.push(envelope);
          bytes += size;
        }
        afterId = row.id;
        budget -= 1;
      }
      // A short read means the table is exhausted; move to the next kind from its top.
      if (!pageFull && rows.length < limit) {
        kind = bootstrapKindAfter(kind);
        afterId = "";
      }
    }

    // Snapshot the walk position as consts so the null check narrows for the cursor encoding.
    const restKind = kind;
    return {
      version: state.snapshotVersion,
      authorizationEpoch: actor.company.authorizationEpoch,
      entities,
      cursor:
        restKind === null
          ? null
          : encodeBootstrapCursor({
              snapshotVersion: state.snapshotVersion,
              entityKind: restKind,
              afterId,
            }),
      isDone: restKind === null,
    };
  },
});

/**
 * Leases a block of issue numbers. Blocks are never recycled: a client that dies holding one
 * leaves a gap, which is the cheap outcome compared with two issues sharing a key.
 */
export const reserveIssueKeys = mutation({
  args: {
    companyId: domainIdArg,
    clientId: v.string(),
    blockSize: v.optional(v.number()),
  },
  returns: v.object({
    prefix: v.string(),
    blockStart: v.number(),
    blockEnd: v.number(),
    firstKey: v.string(),
  }),
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const actor = await requireCompanyActor(ctx, args.companyId);
    const size = clampPageLimit(args.blockSize, ISSUE_KEY_BLOCK_SIZE);

    const reservation = reserveIssueKeyBlock(actor.company.nextIssueNumber, size);
    const now = Date.now();

    await ctx.db.patch(actor.company._id, {
      nextIssueNumber: reservation.nextIssueNumber,
      updatedAt: now,
    });
    await ctx.db.insert("issueKeyReservations", {
      companyId: actor.company._id,
      clientId: args.clientId,
      membershipId: actor.kind === "member" ? actor.membership._id : null,
      environmentId: actor.kind === "environment" ? actor.registration.environmentId : null,
      blockStart: reservation.block.blockStart,
      blockEnd: reservation.block.blockEnd,
      createdAt: now,
    });

    return {
      prefix: actor.company.issueKeyPrefix,
      blockStart: reservation.block.blockStart,
      blockEnd: reservation.block.blockEnd,
      firstKey: formatIssueKey(actor.company.issueKeyPrefix, reservation.block.blockStart),
    };
  },
});

// ---------------------------------------------------------------------------
// Operation application
// ---------------------------------------------------------------------------

/** The tables whose rows carry a `version` column the change feed stamps. */
type VersionedTable =
  | "issues"
  | "issueStatuses"
  | "issueLabels"
  | "issueMilestones"
  | "issueCycles"
  | "issueTodos"
  | "issueRelations"
  | "issueComments"
  | "issueAttachments"
  | "issueViews"
  | "issueThreadLinks"
  | "issueAuditEvents";

/** One authoritative entity write, ready to become a change-feed row once versions are assigned. */
export interface DomainChange {
  readonly entityKind: SyncEntityKind;
  readonly entityId: string;
  readonly changeKind: SyncChangeKind;
  /** Empty means company-wide; any listed team exposes the whole payload. */
  readonly teamIds: readonly string[];
  /**
   * The written row, so the batch can stamp its `version` column once the run is assigned — that
   * stamp is what `bootstrap` hands out as the row's version, closing the seed→drain handoff.
   */
  readonly versionDocId: Id<VersionedTable> | null;
  readonly payload: unknown;
}

export type DomainOutcome =
  | { readonly status: "applied"; readonly changes: readonly DomainChange[] }
  | { readonly status: "rejected"; readonly code: SyncRejectionCode; readonly message: string };

/**
 * Applies one operation's authoritative entity changes and returns what the feed should carry.
 * A handler must not touch `syncChanges`, `syncOperationReceipts`, or the company head — versions
 * are assigned once for the whole batch, after every operation has been applied.
 */
export type DomainApply = (
  ctx: MutationCtx,
  actor: CompanyActor,
  operation: SyncOperationEnvelope,
) => Promise<DomainOutcome>;

/**
 * One handler per issue-domain {@link SyncOperationKind}, from `lib/issueApply`. Kinds outside the
 * issue domain have no handler yet and are refused as `unknown-operation`, which receipts per
 * operation instead of failing the batch.
 */
const DOMAIN_APPLY: Partial<Record<SyncOperationKind, DomainApply>> = ISSUE_DOMAIN_APPLY;

async function applyDomainOperation(
  ctx: MutationCtx,
  actor: CompanyActor,
  operation: SyncOperationEnvelope,
): Promise<DomainOutcome> {
  const apply = DOMAIN_APPLY[operation.kind as SyncOperationKind];
  if (apply === undefined) {
    return {
      status: "rejected",
      code: "unknown-operation",
      message: `No handler for operation kind ${operation.kind}.`,
    };
  }
  return await apply(ctx, actor, operation);
}

/**
 * Applies a batch of client operations.
 *
 * The envelope work is all here: authorize once, drop operations whose receipts already exist,
 * apply the rest, then assign one contiguous run of company versions and append the change feed.
 * Convex serializes the mutation and retries it under OCC, so a losing attempt re-reads the head
 * and re-derives its range rather than interleaving with a winner.
 *
 * @see https://docs.convex.dev/database/advanced/occ
 */
export const applyOperations = mutation({
  args: {
    companyId: domainIdArg,
    operations: v.array(syncOperationArg),
  },
  returns: v.object({
    receipts: v.array(operationReceiptResult),
    versionFrom: v.number(),
    versionTo: v.number(),
    authorizationEpoch: v.number(),
  }),
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const actor = await requireCompanyActor(ctx, args.companyId);

    const operations: readonly SyncOperationEnvelope[] = args.operations;
    const validation = validateOperationBatch(operations, args.companyId);
    if (!validation.ok) throw backendError(validation.code, validation.message);

    // Dedupe against stored receipts. An operation id present here has already been decided, no
    // matter how many times the client resends it after a dropped response.
    const existingReceipts = new Map<string, StoredOperationReceipt>();
    for (const operation of operations) {
      const receipt = await ctx.db
        .query("syncOperationReceipts")
        .withIndex("by_company_and_operation", (q) =>
          q.eq("companyId", actor.company._id).eq("operationId", operation.operationId),
        )
        .unique();
      if (receipt !== null) {
        existingReceipts.set(operation.operationId, {
          status: receipt.status,
          firstVersion: receipt.firstVersion,
          lastVersion: receipt.lastVersion,
          rejectionCode: receipt.rejectionCode,
          rejectionMessage: receipt.rejectionMessage,
        });
      }
    }
    const partition = partitionByExistingReceipts(operations, new Set(existingReceipts.keys()));

    const headBefore = actor.company.syncVersion;
    const now = Date.now();
    const receipts: OperationReceipt[] = [];

    // A resend replays whatever the first attempt decided: an operation rejected then is rejected
    // now, with the same code and message, rather than reading as an acceptance the client drops.
    for (const operation of partition.duplicates) {
      // `duplicates` is exactly the operations whose ids came out of this map, so the lookup only
      // needs narrowing.
      const stored = existingReceipts.get(operation.operationId);
      if (stored === undefined) continue;
      receipts.push(
        replayStoredReceipt({
          operationId: operation.operationId,
          stored,
          headVersion: headBefore,
        }),
      );
    }

    const applied: {
      readonly operation: SyncOperationEnvelope;
      readonly changes: readonly DomainChange[];
    }[] = [];
    const rejected: {
      readonly operation: SyncOperationEnvelope;
      readonly code: SyncRejectionCode;
      readonly message: string;
    }[] = [];

    for (const operation of partition.fresh) {
      const outcome = await applyDomainOperation(ctx, actor, operation);
      if (outcome.status === "rejected") {
        rejected.push({ operation, code: outcome.code, message: outcome.message });
        continue;
      }
      applied.push({ operation, changes: outcome.changes });
    }

    // One contiguous run for the whole batch, in submission order.
    let changeCount = 0;
    for (const entry of applied) changeCount += entry.changes.length;
    const assignment = assignVersions(headBefore, changeCount);

    let cursor = 0;
    const feedActor = actorRecord(actor);
    for (const entry of applied) {
      const startIndex = cursor;
      for (const change of entry.changes) {
        const version = assignment.versions[cursor];
        if (version === undefined) break;
        // Stamp the authoritative row with the version its feed entry carries, so the
        // `by_company_and_version` indexes and the bootstrap consistency argument stay true.
        if (change.versionDocId !== null) {
          await ctx.db.patch(change.versionDocId, { version });
        }
        await ctx.db.insert("syncChanges", {
          companyId: actor.company._id,
          version,
          entityKind: change.entityKind,
          entityId: change.entityId,
          changeKind: change.changeKind,
          teamIds: [...change.teamIds],
          payload: change.payload,
          operationId: entry.operation.operationId,
          actor: feedActor,
          createdAt: now,
          retainUntil: changeRetainUntil(now),
        });
        cursor += 1;
      }
      // An operation that changed nothing still receipts, at the unchanged head.
      const wroteChanges = cursor > startIndex;
      const firstVersion = wroteChanges
        ? (assignment.versions[startIndex] ?? headBefore)
        : headBefore;
      const lastVersion = wroteChanges
        ? (assignment.versions[cursor - 1] ?? headBefore)
        : headBefore;
      receipts.push({
        operationId: entry.operation.operationId,
        status: "accepted",
        duplicate: false,
        firstVersion,
        lastVersion,
      });
      await ctx.db.insert("syncOperationReceipts", {
        companyId: actor.company._id,
        operationId: entry.operation.operationId,
        clientId: entry.operation.clientId,
        localSequence: entry.operation.localSequence,
        actor: feedActor,
        status: "accepted",
        firstVersion,
        lastVersion,
        rejectionCode: null,
        rejectionMessage: null,
        createdAt: now,
        retainUntil: changeRetainUntil(now),
      });
    }

    // Rejections are receipted too: the client's panel needs a durable reason, and a resend of a
    // rejected operation must not silently apply later.
    for (const entry of rejected) {
      receipts.push({
        operationId: entry.operation.operationId,
        status: "rejected",
        duplicate: false,
        code: entry.code,
        message: entry.message,
      });
      await ctx.db.insert("syncOperationReceipts", {
        companyId: actor.company._id,
        operationId: entry.operation.operationId,
        clientId: entry.operation.clientId,
        localSequence: entry.operation.localSequence,
        actor: feedActor,
        status: "rejected",
        firstVersion: null,
        lastVersion: null,
        rejectionCode: entry.code,
        rejectionMessage: entry.message,
        createdAt: now,
        retainUntil: changeRetainUntil(now),
      });
    }

    if (assignment.nextHead !== headBefore) {
      await ctx.db.patch(actor.company._id, {
        syncVersion: assignment.nextHead,
        updatedAt: now,
      });
    }

    return {
      receipts,
      versionFrom: headBefore,
      versionTo: assignment.nextHead,
      authorizationEpoch: actor.company.authorizationEpoch,
    };
  },
});
