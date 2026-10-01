# Devices

The Device panel shows a live iOS Simulator or Android Emulator next to a
conversation, so you can watch an agent verify mobile work and use the device
yourself.

## Open a device

Open the conversation's right-panel menu and choose **Device**. On first use,
the panel walks through setup: starting device support, checking iOS and
Android support, and choosing whether agents may control devices. Opening the
panel alone does not download or start anything. If device support is already
installed, setup says so and reuses it.

Choose a running device to watch it, or choose **Start** next to a stopped
device to boot it. The panel shows a loading state until the first frame
arrives. If the stream drops, choose **Reconnect**.

Simulators run on the machine that hosts the environment. iOS needs macOS
with Xcode. Android needs the SDK Platform-Tools, Android Emulator, and
Command-line Tools, plus a virtual device created in Android Studio's Device
Manager. Pathway detects standard SDK locations; set `ANDROID_HOME` for a
custom location. The panel explains missing dependencies. After installing
them, restart the environment and refresh devices.

The screen is interactive: click and drag to touch, type while the screen is
focused, and use the control rail for Home, Back, and Recents on Android,
rotation, screenshots, and power off. Only a visible device view streams
video. Hiding the panel or switching to another window pauses the stream;
the device keeps running. Closing the panel leaves the simulator or emulator
running until you choose **Power off**.

Choose **3D view** to inspect supported devices while the live screen stays
interactive. Drag or use a trackpad to turn the device, and flick to spin it.
**Restore 3D view** returns the device to a screen-facing position. On iPhone
Duo, use the fold and stance controls to change its pose, or pinch over the
device to adjust the hinge. Turning the model to the other screen switches the
live display and touch input to that screen. On supported Android foldables,
use **Fold device** and **Unfold device** beside the screen, in either view.
Small panels and browsers without 3D support use the flat screen view.

## Taking control

One person or agent controls a device at a time. Everyone else watches: the
live screen stays visible, but touch, typing, hardware buttons, rotation, fold
changes, device tools, and power off are unavailable. The bar at the top of
the panel says who is in control: you, this conversation's agent, an agent in
another conversation (choose **Open thread** to go there), someone else, or
nobody.

Choose **Take control** to use the device yourself, even while the previous
controller's input is finishing. The button reads **Taking control…** until
that input finishes, and the device becomes interactive once the environment
confirms you are in control.
Taking control from an agent pauses its device use.

While you are in control, choose **Release control** to go back to watching,
or **Resume agent** to hand the device back to this conversation's agent.
Resume agent waits for the environment to confirm your control has ended,
then asks the agent to continue. If that can't be confirmed, the agent is not
asked, and the panel says why. Hiding the panel, switching to another browser
tab, minimizing the window, or closing the device also releases control.
Moving focus to another window while Pathway stays visible does not.

If the connection to the environment drops, your control ends and the panel
switches to watching. Choose **Take control** again once it reconnects.

If someone else takes control, or your control ends some other way, the panel
says so and returns to watching. Choose **Take control** again to continue.
If Pathway can't confirm the last input on a device finished, the panel says
so and offers **Restart device tools**, even when the tools are current. After
the restart, take control again. A restart that leaves one device unconfirmed
keeps its error and **Retry** in the Devices settings and the Device panel
until that device recovers or you dismiss the error. Other devices on the same
host are not held up.

Environments running an older Pathway release don't support control. Their
device panels stay interactive for everyone, as before.

## Tools

The **Tools** button opens a drawer for the open device. It shows the
foreground app and lets you switch light and dark mode, change text size,
change accessibility settings, overlay accessibility element frames on the
screen, set a location, and grant or revoke app permissions. iOS also offers
color filters, VoiceOver, and a test push notification; Android adds
orientation and network controls. The drawer only shows what the platform
supports, and each control shows the value read back from the device.

## Build and run on a simulator

With an iOS simulator open, choose **Run on _simulator_…** below the screen.
Pathway reads the conversation's project, or its worktree when it has one,
and lists its Xcode projects, workspaces and schemes. Pick a scheme and,
optionally, a configuration or app target. Then choose **Run** to build,
install and launch the app on that simulator, **Build** to build only, or
**Test** to run the scheme's tests. You can also open the command palette and
choose **Run on simulator**. If no simulator is open yet, the panel asks you
to pick one first.

The build card shows each step as it happens: resolving, building,
installing, launching and running. It also streams the build output. Errors
and warnings appear above the log. Click a file location to open it at that
line in your editor. The card keeps the most recent output and tells you when
earlier output was trimmed. **Cancel** stops the build. Once a build finishes,
fails or is cancelled, choose **Run again** to repeat it or **Change
settings** to pick something else. Hiding the panel doesn't stop a build, and
reopening it shows the latest one, including builds an agent started.

Builds run on the Mac that hosts the conversation's environment, so they work
the same from the web app, desktop, or a remote connection. Some setups can't
build:

- Simulators on SSH device hosts can't receive builds yet.
- Environments that aren't running on a Mac can't build for iOS.
- Without a full Xcode installation, the panel links to Xcode setup.
- Expo projects need their native `ios/` project generated with Expo
  prebuild first. Install React Native CocoaPods dependencies before
  building. Release builds bundle JavaScript; Debug builds need your
  project's Metro server running.

"Running" means the app launched. Pathway doesn't keep watching it after
that.

## Agents and devices

Device support and agent control are separate choices. Leave **Agent device
access** off to use the controls yourself only. Turn it on to let agents
discover, open, inspect, and control devices. iOS taps build a small test
runner on first use, which takes a couple of minutes once per environment.
Restart an existing agent session after granting access. Turning access off
revokes it for current agent sessions too; your own Device panel is
unaffected.

## Settings

Manage devices in **Settings → Integrations → Devices**. Choose the
environment you want to configure. Turning off **Device support** stops
Pathway's device helpers; it does not delete your simulators or their data.

## Remote connections

The device stream goes through the environment connection, so it works over
the local network and Pathway Connect. Live video needs a secure page (HTTPS
or localhost); on a plain-HTTP remote address, iOS falls back to a slower
still-image stream and Android cannot show video.

## SSH device hosts

Add a host under **Device hosts** in the Devices settings. Enter an SSH alias
or `user@host`, with an optional identity file and port. These resolve on the
environment's machine, so use the SSH configuration and keys available there.
Password prompts are not supported.

**Test connection** checks SSH, Node, npm, and platform tools without
installing anything. A host that resolves to the environment's own machine is
skipped, since its devices are already local. The first device listing
installs the required device tools on the host. Node 22 or newer and npm must
be available to non-interactive SSH commands.

The device picker labels devices by host when several hosts are configured.
Connections recover after interruptions. Removing a host closes its device
sessions and stops Pathway's helpers there when reachable; simulators keep
running.

Pathway provides discovery, streaming, and control. Arrange app builds,
installation, and connections to development servers such as Metro
separately. A simulator on another machine cannot reach a development server
on your environment's localhost without forwarding or another reachable
address.

## Device tool updates

The environment manages its device tools on its own machine and on its SSH
hosts. Required versions install automatically the next time the tools are
used. In the Devices settings, **Check versions** reads installed versions
without installing tools or starting devices, and **Update** installs the
required version ahead of time.

To get newer tool versions on a remote environment, update Pathway on that
environment. Updating only the app you connect from does not update it. An
offline host keeps its installed tools, but an update needs network access
before device support can start; Pathway does not fall back to an older
version. Reconnect the host and choose **Retry** if installation fails. Your
device and agent-access settings are kept.

## Keeping environments in sync

Each Pathway release pins its device tool versions and recommends an Xcode
version and simulator runtimes. When several environments share devices, keep
their tools on the same versions.

**Settings → Integrations → Devices** compares every connected environment,
including relay and Pathway Connect ones, side by side: Xcode, installed
runtimes, Device Hub, and agent-device. Each host shows **Current**,
**Update available**, **Restart to apply**, or **Not checked**. **Check all**
refreshes versions everywhere without installing or starting anything.
**Update** installs the pinned tools on one host, and **Update all** updates
every host that is behind. Each host reports its own progress and errors, so a
failed host can be retried on its own.

Updates install tools but do not restart running device helpers. A host showing
**Restart to apply** has a **Restart** button, in Settings and in the Devices
panel, that restarts its helpers in place. Open devices stay connected and keep
their owner. On environments running an older Pathway without that button,
finish active work, then turn **Device support** off and on for that
environment. An environment marked **Older release** runs a Pathway version
that pins older tools; update Pathway there to match. Xcode and runtime
recommendations are advisory. Install those yourself with Xcode or Android
Studio.

The Device panel shows a short notice when the environment's tools are behind
its release, with an **Update** button.

A simulator can only be used by one environment at a time. A device another
environment is using shows **In use by** that environment and cannot be
started or opened until that environment turns off device support or stops.
Conversations in the same environment can share a device.
