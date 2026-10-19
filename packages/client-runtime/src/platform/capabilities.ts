import {
  type AuthClientPresentationMetadata,
  type AuthEnvironmentScope,
  type DesktopSshEnvironmentBootstrap,
  type DesktopSshEnvironmentTarget,
  EnvironmentId,
} from "@spiritdevs/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Stream from "effect/Stream";

import type { ConnectionAttemptError } from "../connection/model.ts";

export interface PreparedSshEnvironment {
  readonly bootstrap: DesktopSshEnvironmentBootstrap;
  readonly bearerToken: string;
}

export interface ProvisionedSshEnvironment extends PreparedSshEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export class CloudSession extends Context.Service<
  CloudSession,
  {
    readonly clerkToken: Effect.Effect<string, ConnectionAttemptError>;
  }
>()("@spiritdevs/client-runtime/platform/capabilities/CloudSession") {}

export type ApplicationActivityState = "active" | "inactive";

/**
 * Platform-owned application foreground state. Shared services use this to
 * keep global data fresh without polling while a browser tab or mobile app is
 * backgrounded.
 */
export class ApplicationActivity extends Context.Service<
  ApplicationActivity,
  {
    readonly status: Effect.Effect<ApplicationActivityState>;
    readonly changes: Stream.Stream<ApplicationActivityState>;
  }
>()("@spiritdevs/client-runtime/platform/capabilities/ApplicationActivity") {}

export class RelayDeviceIdentity extends Context.Service<
  RelayDeviceIdentity,
  {
    readonly deviceId: Effect.Effect<Option.Option<string>, ConnectionAttemptError>;
    /** Environment hosted by this client, absent for web and mobile-only clients. */
    readonly environmentId: Effect.Effect<Option.Option<EnvironmentId>, ConnectionAttemptError>;
  }
>()("@spiritdevs/client-runtime/platform/capabilities/RelayDeviceIdentity") {}

export class ClientPresentation extends Context.Service<
  ClientPresentation,
  {
    readonly metadata: AuthClientPresentationMetadata;
    readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  }
>()("@spiritdevs/client-runtime/platform/capabilities/ClientPresentation") {}

export class PrimaryEnvironmentAuth extends Context.Service<
  PrimaryEnvironmentAuth,
  {
    readonly bearerToken: Effect.Effect<Option.Option<string>, ConnectionAttemptError>;
  }
>()("@spiritdevs/client-runtime/platform/capabilities/PrimaryEnvironmentAuth") {}

export class SshEnvironmentGateway extends Context.Service<
  SshEnvironmentGateway,
  {
    readonly provision: (
      target: DesktopSshEnvironmentTarget,
    ) => Effect.Effect<ProvisionedSshEnvironment, ConnectionAttemptError>;
    readonly prepare: (input: {
      readonly connectionId: string;
      readonly expectedEnvironmentId: EnvironmentId;
      readonly target: DesktopSshEnvironmentTarget;
    }) => Effect.Effect<PreparedSshEnvironment, ConnectionAttemptError>;
    readonly disconnect: (
      target: DesktopSshEnvironmentTarget,
    ) => Effect.Effect<void, ConnectionAttemptError>;
  }
>()("@spiritdevs/client-runtime/platform/capabilities/SshEnvironmentGateway") {}
