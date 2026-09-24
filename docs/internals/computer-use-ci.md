# Computer Use CI

Computer Use ships native code that the main CI jobs never compile. Three workflows cover it. Each
is path-filtered, so it only runs when its own sources change.

| Workflow              | Runner                 | What it proves                                                                                                                                                                                                                   |
| --------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pathway-helper.yml`  | fleet macOS            | `native/pathway-helper` passes its native tests and builds as the universal release binary. The binary keeps its signing identifier and exits with `EX_USAGE` on a bad flag.                                                     |
| `kwin-plugin.yml`     | fleet Linux, container | The KWin fixture tests pass. The plugin builds against the KWin that Fedora 43 and 44, Debian trixie, Ubuntu 26.04, openSUSE Tumbleweed and Arch ship. Each leg uploads its `.so` with a JSON sidecar describing what it linked. |
| `cua-linux-check.yml` | fleet Linux            | The Linux host, admission and protocol tests pass. The pinned Cua source builds on Linux with both Pathway patches, and its browser and cursor tests pass.                                                                       |

The Linux jobs run only when the repository variable `FLEET_ENABLE_LINUX_CHECKS` is `true`, the
same gate as the Rust job in `ci.yml`. `kwin-plugin.yml` runs each job in a distribution
container, so the Linux runner needs Docker. It also runs on a monthly schedule, because KWin
changes when the distributions update, not when this repository does.

## Differences from Synara

These workflows mirror Synara's `kwin-plugin-prebuilds.yml` and `cua-linux-check.yml`, with these
gaps:

- **No arm64 KWin legs.** Synara builds every distribution on both x64 and arm64. Pathway's fleet
  has no arm64 Linux runner, so only x64 builds. Add the arm64 legs once a runner exists. Arch
  stays x64-only either way, because Arch publishes no arm64 image.
- **No prebuilt manifest.** Synara runs an assemble job
  (`scripts/assemble-kwin-plugin-prebuilds.mjs`) that folds the sidecars into
  `prebuilt/manifest.json`, and its release bundles the result. Pathway has no assemble script and
  no server code that selects a prebuilt, so the KWin workflow is a build check. When prebuilts
  ship, add the assemble job and a `workflow_call` trigger for release to use.
- **No Electron X11 smoke.** Synara's Linux job ends by building `.github/scripts/cua-linux-smoke.ts`
  and running it in Electron on a disposable Xvfb display. The script drives a real Chrome through
  the Linux host: it clicks, types, checks that native input and visible launches are refused,
  injects Escape through `xdotool`, and checks that the browser dies with the host. Pathway's Linux
  host is Effect-based (`makeLinuxCuaDriverHost`), so the script has to be rewritten, not copied.
  The job also needs `xvfb xauth xdotool dbus-x11 acl` and the trusted Chrome reinstall step from
  Synara's workflow.

## Hyprland

Pathway has no Hyprland Computer Use plugin yet. `native/hyprland-snap-shot` is the snapshot tool,
not the plugin. When Synara's `computer-use-hyprland` is ported, its lane will need the following:

- **Source.** A `native/computer-use-hyprland` directory with the Makefile targets `test`
  (compositor-free fixtures) and `authprobe` (the session-auth gate compiled against real
  sdbus-c++), and a `scripts/install-and-load.sh --build-only` that prints the built `.so`.
- **Container.** A digest-pinned `archlinux` image on the fleet Linux runner, gated on
  `FLEET_ENABLE_LINUX_CHECKS`. Arch ships Hyprland's development headers in the compositor
  package. Hyprland only loads a plugin built from its exact commit, so there is no prebuild
  matrix. Users compile the plugin on their own machine.
- **Fixture toolchain (blocking).**
  `pacman -Syu --noconfirm gcc make pkgconf python git sdbus-cpp cairo libjpeg-turbo libpng coreutils util-linux gawk grep`,
  then `make test` and `make authprobe`.
- **Plugin build (headers may be missing).** A `continue-on-error` step runs
  `pacman -S --noconfirm hyprland cairo pixman libdrm libxkbcommon libjpeg-turbo libpng` and
  `pkg-config --exists hyprland`. If that step fails, emit a warning and skip the build. If the
  headers installed, `--build-only` must succeed.
- **Triggers.** Pull requests and `main` pushes that touch the plugin directory or the workflow.
  Synara also runs the KWin pointer-cleanup fixture in this lane. Pathway does not need that,
  because `kwin-plugin.yml` already runs every KWin fixture.
