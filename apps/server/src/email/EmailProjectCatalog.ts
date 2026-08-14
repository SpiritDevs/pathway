import type { ProjectId } from "@spiritdevs/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectService from "../project/ProjectService.ts";

export interface EmailProject {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string | null;
}

export class EmailProjectCatalog extends Context.Service<
  EmailProjectCatalog,
  {
    readonly list: Effect.Effect<ReadonlyArray<EmailProject>, ProjectService.ProjectOperationError>;
    readonly streamChanges: Stream.Stream<void>;
  }
>()("@spiritdevs/pathway/email/EmailProjectCatalog") {}

export const layer = Layer.effect(
  EmailProjectCatalog,
  Effect.gen(function* () {
    const projects = yield* ProjectService.ProjectService;
    const engine = yield* OrchestrationEngineService;
    return EmailProjectCatalog.of({
      list: projects.snapshot.pipe(
        Effect.map((snapshot) =>
          snapshot.projects.map((project) => ({
            projectId: project.id,
            title: project.title,
            workspaceRoot: project.workspaceRoot,
          })),
        ),
      ),
      streamChanges: engine.streamDomainEvents.pipe(
        Stream.filter((event) => event.type === "project.created"),
        Stream.map(() => undefined),
      ),
    });
  }),
);

export const layerTest = (projects: ReadonlyArray<EmailProject>) =>
  Layer.succeed(
    EmailProjectCatalog,
    EmailProjectCatalog.of({
      list: Effect.succeed(projects),
      streamChanges: Stream.empty,
    }),
  );
