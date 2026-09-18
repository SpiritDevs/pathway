# Run Pathway Actions on the native fleet

Pathway's initial fleet rollout uses Apple Silicon Macs. GitHub still owns workflow triggers, checks, artifacts, releases, and job assignment. The fleet supplies native runner capacity and live monitoring. Linux desktop builds, Windows builds/checks, and Intel Mac builds are deferred. The service itself supports Linux hosts.

## Routing and host preparation

Most jobs default to `runs-on: [self-hosted, fleet-macos-arm64]`. Native Apple client jobs additionally require `xcode`. Configure each host through [Actions Fleet](https://github.com/SpiritDevs/actions-fleet), and advertise only capabilities installed on that host. Start with one active job per physical machine. Dedicated, Shared, and Paused modes do not change a workflow's OS requirements.

Each Mac needs Git, Apple Command Line Tools, a C/C++ toolchain, and enough free space for separate checkouts, Electron packaging, Rust, and artifacts. The workflows install the package.json Node version with Vite+, and install Rust where needed. Native dictation also needs CMake 3.24 or newer. Native iPhone/iPad/visionOS jobs require full Xcode, its accepted license, required SDKs and simulator runtimes; Command Line Tools alone are insufficient. Add the `xcode` label only after validating those builds. An unavailable compatible host leaves jobs queued.

Use a dedicated CI macOS account when practical. Jobs execute natively with that account's access. They must use the runner-owned checkout and temporary directories, never an interactive Pathway checkout or live `~/.pathway/userdata`. Do not mix unrelated manually registered runners onto the same physical machine; the fleet's one-job limit covers the capacity it manages.

Optional repository variables accept JSON runner-label arrays:

| Variable                    | Default                                       | Purpose                                                                      |
| --------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------- |
| `FLEET_MACOS_RUNNER`        | `["self-hosted","fleet-macos-arm64"]`         | Portable jobs, desktop releases, dictation.                                  |
| `FLEET_APPLE_RUNNER`        | `["self-hosted","fleet-macos-arm64","xcode"]` | Native Apple client checks.                                                  |
| `FLEET_ENABLE_LINUX_CHECKS` | Unset, disabled                               | Set to `true` only when restoring the Linux Rust check on a compatible host. |
| `FLEET_LINUX_RUNNER`        | `["self-hosted","fleet-linux-x64"]`           | Linux Rust check if explicitly enabled.                                      |

## Restored automation

| Workflow                     | Trigger and initial behavior                                                                                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI                           | Pull requests, main pushes, manual dispatch; portable checks/server shards/release smoke run on Mac. Linux Rust job is skipped by default.                            |
| Native Apple clients         | Relevant pull-request paths and manual dispatch; iPhone, iPad, visionOS on Xcode-labelled Macs.                                                                       |
| Native dictation             | Existing relevant pull-request paths and manual dispatch; Mac lane retained, Windows lane removed.                                                                    |
| Issue Labels                 | Main changes to issue templates/workflow, plus manual dispatch.                                                                                                       |
| PR Size                      | Pull-request target metadata events; manual dispatch synchronizes label definitions.                                                                                  |
| PR Vouch                     | Pull-request target metadata events, new issue comments, relevant main changes, manual dispatch. Vouch labels do not replace fleet admission approval.                |
| Web Preview                  | Same-repository pull requests with `preview:web`, on label/synchronize/reopen. Its existing manual entry does not supply a pull-request payload and skips deployment. |
| Deploy Pathway Connect relay | Existing path-filtered main pushes; production deployment behavior retained.                                                                                          |
| Check private mail storage   | Remains intentionally manual; writes a temporary synthetic file for its check.                                                                                        |
| Release                      | Every three hours at minute 7 for changed nightly commits; stable `v*.*.*` tags excluding nightly tags; manual stable/nightly dispatch.                               |

Required-check policies should match the retained job names. The native dictation matrix keeps its existing Mac check identity, while Windows coverage is deliberately absent. A skipped Linux check is not evidence that Linux code passed. Some server tests also have existing OS guards and do not exercise Linux-only behavior on Mac.

## Release credentials and configuration

GitHub Releases remain automatic for signed/notarized Apple Silicon desktop builds. Nightlies are prereleases and do not replace the stable latest release. Stable releases retain version finalization on main. The desktop builder also deploys the configured Convex backend; release workflows are not build-only experiments.

The following configuration is required. Environment-scoped entries belong to the existing `production` environment, used by the public-config and build jobs. Repository-scoped entries must also be visible to jobs that do not select an environment.

| Scope                                                 | Secrets                                                                                                               | Variables                                                                                                                                           |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository or production environment, desktop signing | `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `MACOS_PROVISIONING_PROFILE` | `APPLE_TEAM_ID`; optional `CLERK_PASSKEY_RP_DOMAINS` override.                                                                                      |
| Production environment, app/backend configuration     | `CONVEX_DEPLOY_KEY`                                                                                                   | `CLERK_PUBLISHABLE_KEY`, `CLERK_JWT_TEMPLATE`, `CLERK_CLI_OAUTH_CLIENT_ID`, `CONVEX_URL`; optional `RELAY_DOMAIN` (default `relay.spiritdevs.com`). |
| Repository or production environment, channel URLs    | —                                                                                                                     | `PATHWAY_WEB_LATEST_DOMAIN` for stable; `PATHWAY_WEB_NIGHTLY_DOMAIN` defaults to `app.pathwayos.dev`. Values are bare hostnames.                    |
| Repository, hosted web deployment and previews        | `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`                                                                  | Optional `VERCEL_TEAM_SLUG`. The Vercel project needs its existing `production` and `beta` targets.                                                 |
| Repository, npm staging                               | `NPM_STAGE_TOKEN`                                                                                                     | —                                                                                                                                                   |
| Repository, stable version finalization               | `RELEASE_APP_ID`, `RELEASE_APP_PRIVATE_KEY`                                                                           | —                                                                                                                                                   |

`APPLE_API_KEY` contains the key contents; the workflow writes a private temporary file. `MACOS_PROVISIONING_PROFILE` is base64-encoded. Both temporary files are removed on step exit. The release App must be installed on this repository, allowed to write contents, and allowed to push the intended version bump under main's branch rules.

The production relay and mail workflows keep their existing credentials. Relay deployment uses `CLOUDFLARE_API_TOKEN`, `AXIOM_TOKEN`, `CLERK_SECRET_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `AXIOM_ORG_ID`, `CONVEX_URL`, and the configured relay/Clerk variables. Enabled APNs/mail integrations additionally require their existing `APNS_*`/`MAIL_*` settings. Mail storage diagnostics require `MAIL_UPLOADTHING_API_KEY`. This migration does not create or rotate those credentials.

Inventory on 2026-09-19 confirmed the desktop signing, Vercel, Convex, and public-config entry names. The separate Pathway Release App is installed only on Pathway, and `RELEASE_APP_ID` / `RELEASE_APP_PRIVATE_KEY` are configured. The owner has also configured the package-scoped `NPM_STAGE_TOKEN` for staged npm publication. Secret-name presence does not prove validity or service access; the real release run must validate it.

## Stage and approve the npm CLI

The initial package declares `os: ["darwin"]` and `cpu: ["arm64"]`, and requires the matching resource-monitor binary. The stable release job builds and stages the package, then exits successfully when staging succeeds. GitHub desktop publication and finalization do not wait for npm approval. A staged package is not publicly published.

Use a package-scoped granular token with **Read and write (stage only)** access, without bypassing 2FA, for `NPM_STAGE_TOKEN`. Grant access only to `@spiritdevs/pathway` and no organization-management permissions. [npm token configuration](https://docs.npmjs.com/creating-and-viewing-access-tokens/). Keep the human approval session separate. The workflow pins npm 11.15.0 for `npm stage publish`, runs it from the prepared package directory, and omits pnpm-only workspace override selectors that npm cannot parse. A staging dry run performs `npm pack --dry-run`, without uploading a staged version.

The package bootstrap is complete. `@spiritdevs/pathway@0.0.42` was staged, approved by the owner with npm 2FA, and verified publicly as `latest` on 2026-09-19 with the reviewed archive integrity. An isolated installation passed `pathway --version` and `--help`. Both compiled server and client use the production sign-in URL. The source package version remains `0.0.41`; choose a fresh stable version greater than `0.0.42` for the next release. Published versions cannot be replaced.

Staging requires an existing package. The following records the completed bootstrap procedure; do not republish `0.0.42`. A new package needs one explicit initial publication by an authorized maintainer with 2FA. Subsequent releases use staging, and the automated workflow never falls back to direct publication.

Prepare a publication as a local archive using the same package metadata and icons as publication. In an isolated checkout, align the source package versions before building; the publish flag changes archive metadata only, not the version already compiled into the server. Preserve and restore any existing source changes after packing. Build with the production public Clerk/Convex/relay configuration, `APP_VERSION=0.0.42`, and `PATHWAY_HOSTED_APP_URL=https://app.pathwayos.app` for the stable channel, then bundle the native resource monitor:

```sh
node scripts/update-release-package-versions.ts 0.0.42
vp run --filter @spiritdevs/pathway build
cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml --target aarch64-apple-darwin
mkdir -p apps/server/dist/resource-monitor/darwin-arm64
cp native/resource-monitor/target/aarch64-apple-darwin/release/pathway-resource-monitor apps/server/dist/resource-monitor/darwin-arm64/
node apps/server/scripts/cli.ts publish --pack --app-version 0.0.42 --pack-destination /absolute/ignored/artifact-directory --verbose
```

`--pack` runs only `npm pack --json --ignore-scripts` in the prepared package directory, omits pnpm-only overrides, and restores the working package metadata and icons afterward. It cannot be combined with `--stage`; `--pack-destination` must be absolute. An optional `--dry-run` lists the archive without creating it. Keep generated tarballs in an ignored artifact directory. No backend deployment, GitHub Release, registry stage, or npm publication occurs during these build/pack commands.

Inspect the archive's `package.json`, bundled client/server files, and executable `dist/resource-monitor/darwin-arm64/pathway-resource-monitor`; verify both compiled versions and the server/client hosted URL, and record its SHA-256. Use a fresh version if an earlier archive was already published. Once reviewed, the npm owner publishes that exact archive using `npm publish /absolute/path/spiritdevs-pathway-0.0.42.tgz --access public --tag latest`, completing npm's required 2FA approval. Building an archive alone is not publication. Subsequent stable versions use the staged workflow above; the unflagged `cli.ts publish` path also remains an explicitly invoked direct publication command.

After a stable run stages a version, sign in to npm as a package maintainer and use:

```sh
npm stage list @spiritdevs/pathway
npm stage view STAGE_ID
npm stage download STAGE_ID
npm stage approve STAGE_ID
npm view @spiritdevs/pathway@VERSION version os cpu dist-tags --json
```

Inspect the downloaded archive's version, Apple Silicon metadata, bundled client/server files, and `dist/resource-monitor/darwin-arm64/pathway-resource-monitor` before approval. Wait for npm’s automated review to change the stage status from `validating` to `staged` before approving; an early approval returns HTTP 409 and must be retried after review. Approval prompts for 2FA. Staged versions occupy their version number; on a rerun, inspect an existing stage rather than assuming another upload can replace it. [npm staged publishing reference](https://docs.npmjs.com/cli/v11/commands/npm-stage/).

## Activation order

1. Keep repository-wide Actions disabled while preparing the migration. The API reported `enabled: false` during discovery even though individual workflow records were `active`. Restoring YAML triggers alone does not enable execution.
2. Finish the fleet pilot, connect Pathway through the GitHub App, and verify outside-contributor revision approval. Enroll at least one compatible Mac; validate Xcode before advertising that label. Confirm no workflow references Blacksmith and leave Linux checks disabled.
3. Install the workflow changes on main, satisfy the credentials above, confirm existing npm package access/bootstrap, and review branch-required check names. Do this before enabling Actions because relay pushes and scheduled releases can deploy immediately afterward.
4. Enable repository-wide Actions. Dispatch CI first, review completed checks and ordered live logs, then explicitly run a nightly. Verify signature/notarization, DMG/ZIP/blockmaps, channel updater YAML, GitHub prerelease status, backend configuration, and the beta hosted web target.
5. Release a deliberate stable version using a `vMAJOR.MINOR.PATCH` tag or a stable manual dispatch with its version input. Confirm latest-release behavior, production web target, main's version bump, and separate npm staging. Approve npm publication only after package inspection.

The prepared changes were validated with actionlint across all ten workflows, targeted CLI lint/typechecking, CLI help, the release smoke script, and 72 tests covering npm preparation, desktop artifact configuration, nightly metadata, previous tags, package version updates, and updater manifests. This does not substitute for a signed real release, native Apple simulator run, multi-host observation, or npm publication approval. No release or registry publication was performed by these checks.

## Outages and manual hosted fallback

When the fleet is unavailable, jobs wait. Repair or unpause a compatible machine first. There is no automatic switch to hosted compute.

For an urgent explicitly approved hosted run, temporarily set the relevant runner variable to `["macos-26"]`. GitHub currently identifies this standard label as Apple Silicon; verify the current image/toolchains and billing conditions before use. Change `FLEET_APPLE_RUNNER` too only if native Apple jobs need the fallback. Do not add `self-hosted` to a hosted-runner label array. [GitHub runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

Changing a runner variable does not migrate a running job. Review queued work, cancel/retry or dispatch deliberately, and remember that release reruns can publish or deploy again. Restore the original fleet variable values (or delete overrides to use their defaults) immediately after the fallback run. Rollback should not silently restore Blacksmith labels or billing.

GitHub artifact/cache storage and provider hosting remain separate costs. The existing Vercel deployment steps request Vercel-side builds; moving their Actions runner does not move that separate build compute onto the fleet.
