// @effect-diagnostics nodeBuiltinImport:off - This CLI reads a snapshot before creating its in-memory Effect runtime.
/** Measures the largest company independently, keeping replica identities scoped to one company.
 * Run with `node scripts/benchmark-tasks-read-model.mjs /path/to/snapshot.sqlite`. */
import * as NodeConsole from "node:console";
import * as NodeSqlite from "node:sqlite";
import * as NodeAssert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { CompanyId, MembershipId } from "@spiritdevs/contracts/company";
import {
  AuthorizationEpoch,
  CompanyVersion,
  SyncClientId,
  SyncEntityId,
  SyncOperationId,
} from "@spiritdevs/contracts/cloudSync";
import * as Queue from "effect/Queue";
import {
  cloudEntityCodec,
  issueUpdateOperation,
  makeIssueSyncAdapter,
  makeMemorySyncStore,
  SyncStore,
  SyncTransport,
  SYNC_BOOTSTRAP_GENERATION,
  SYNC_DOCUMENT_SCHEMA_VERSION,
} from "../packages/client-runtime/src/sync/index.ts";
import {
  syncedIssueDomainFromEntities,
  syncedIssueDomainFromReplica,
} from "../packages/client-runtime/src/sync/issueReadModel.ts";
import { makeSyncEngine } from "../packages/client-runtime/src/sync/engine.ts";
import { issueCollectionProjectionFromReplica } from "../packages/backend/src/sync/issueLegacyProjection.ts";

const snapshotPath = process.argv[2];
if (!snapshotPath) throw new Error("Supply a read-only SQLite snapshot path.");
const db = new NodeSqlite.DatabaseSync(snapshotPath, { readOnly: true });
const snapshotRows = db.prepare("SELECT COUNT(*) AS count FROM cloud_sync_entities").get().count;
const rows = db
  .prepare(
    "SELECT entity_kind, entity_id, version, payload FROM cloud_sync_entities WHERE company_id = (SELECT company_id FROM cloud_sync_entities GROUP BY company_id ORDER BY COUNT(*) DESC, company_id LIMIT 1)",
  )
  .all();
db.close();
const storedRows = rows.map((row) => ({
  entityKind: row.entity_kind,
  entityId: SyncEntityId.make(row.entity_id),
  version: CompanyVersion.make(row.version),
  payload: JSON.parse(row.payload),
}));
const entities = storedRows.flatMap((row) => {
  const entity = cloudEntityCodec(row.entityKind)?.decode(row.payload);
  return entity && Option.isSome(entity) ? [entity.value] : [];
});
const view = new Map(entities.map((entity) => [`${entity.entityKind}:${entity.id}`, entity]));
const domain = syncedIssueDomainFromEntities(entities);
const tasks = domain.issues.filter((issue) => issue.deletedAt == null).slice(0, 100);
NodeAssert.equal(tasks.length, 100);
const times = [];
for (let i = 0; i < 50; i++) {
  const start = performance.now();
  const actual = syncedIssueDomainFromEntities(entities);
  const elapsed = performance.now() - start;
  NodeAssert.deepEqual(actual, domain);
  if (i >= 10) times.push(elapsed);
}
times.sort((a, b) => a - b);
const companyId = CompanyId.make("benchmark-company");
const actor = { kind: "member", membershipId: MembershipId.make("benchmark-member") };
const version = CompanyVersion.make(Math.max(...rows.map((row) => row.version)));
const epoch = AuthorizationEpoch.make(1);

const result = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const memory = yield* makeMemorySyncStore();
      yield* memory.service.commit(companyId, {
        checkpoint: {
          schemaVersion: SYNC_DOCUMENT_SCHEMA_VERSION,
          bootstrapGeneration: SYNC_BOOTSTRAP_GENERATION,
          companyId,
          cursor: version,
          authorizationEpoch: epoch,
          bootstrapped: true,
        },
        upsertEntities: storedRows,
      });
      let commits = 0;
      const transport = SyncTransport.of({
        bootstrap: () => Effect.die("Unexpected bootstrap"),
        latestVersion: () => Stream.empty,
        listChanges: () =>
          Effect.succeed({
            _tag: "Changes",
            companyId,
            authorizationEpoch: epoch,
            cursor: version,
            latestVersion: version,
            changes: [],
            hasMore: false,
          }),
        applyOperations: () => Effect.die("Unexpected flush"),
        reserveIssueKeys: () => Effect.die("Unexpected key reservation"),
      });
      const engine = yield* makeSyncEngine({
        companyId,
        clientId: SyncClientId.make("benchmark-client"),
        actor,
        adapter: makeIssueSyncAdapter({ actor, now: () => 0 }),
      }).pipe(
        Effect.provideService(SyncStore, {
          ...memory.service,
          commit: (id, batch) =>
            Effect.sync(() => {
              commits++;
            }).pipe(Effect.andThen(memory.service.commit(id, batch))),
        }),
        Effect.provideService(SyncTransport, transport),
      );
      const publications = yield* Queue.unbounded();
      yield* SubscriptionRef.changes(engine.state).pipe(
        Stream.runForEach((state) => Queue.offer(publications, state)),
        Effect.forkScoped,
      );

      const initial = yield* Queue.take(publications);

      const initialProjection = issueCollectionProjectionFromReplica(
        syncedIssueDomainFromReplica(initial),
      );
      const initialDomains = Array.from({ length: 4 }, () => syncedIssueDomainFromReplica(initial));
      yield* engine.sync;
      let cyclePublications = 0;
      let cyclePasses = 0;
      let cycleReplicaPublications = 0;
      let previousView = initial.view;
      let final = initial;
      for (;;) {
        final = yield* Queue.take(publications);
        cyclePublications++;
        if (previousView !== final.view) cycleReplicaPublications++;
        previousView = final.view;
        const projections = Array.from({ length: 4 }, () => syncedIssueDomainFromReplica(final));
        cyclePasses += new Set(
          projections.filter((projection) => !initialDomains.includes(projection)),
        ).size;

        if (final.phase === "ready") break;
      }
      const finalProjection = issueCollectionProjectionFromReplica(
        syncedIssueDomainFromReplica(final),
      );
      const identitiesRetained = finalProjection.issues.filter(
        (issue, i) => issue === initialProjection.issues[i],
      ).length;
      const inputs = tasks.map((task, i) => ({
        operationId: SyncOperationId.make(`benchmark-${i}`),
        operation: issueUpdateOperation({ issueId: task.id, patch: { priority: "high" } }),
      }));
      commits = 0;
      const start = performance.now();
      const receipts = yield* engine.enqueueBatch(inputs);
      NodeAssert.equal(receipts.filter((receipt) => receipt.accepted).length, 100);

      const bulkMs = performance.now() - start;
      let bulkPublications = 0;
      for (;;) {
        const published = yield* Queue.take(publications);
        bulkPublications++;
        if (published.pending.length === 100) break;
      }
      return {
        initialPassesForFourConsumers: new Set(initialDomains).size,
        cyclePublications,
        cycleReplicaPublications,
        cyclePasses,
        identitiesRetained,
        issueCount: finalProjection.issues.length,
        mapsRetained: {
          view: final.view === initial.view,
          confirmed: final.confirmed === initial.confirmed,
        },
        bulkPublications,
        bulkCommits: commits,
        bulkMs,
      };
    }),
  ),
);
NodeConsole.log(
  JSON.stringify(
    {
      fixture: {
        snapshotRows,
        rows: rows.length,
        decoded: entities.length,
        unique: view.size,
        tasks: domain.issues.length,
        comments: domain.issueComments.length,
      },
      readModelMs: { median: times[20], p95: times[38] },
      ...result,
    },
    null,
    2,
  ),
);
