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

## Tools

The **Tools** button opens a drawer for the open device. It shows the
foreground app and lets you switch light and dark mode, change text size,
change accessibility settings, overlay accessibility element frames on the
screen, set a location, and grant or revoke app permissions. iOS also offers
color filters, VoiceOver, and a test push notification; Android adds
orientation and network controls. The drawer only shows what the platform
supports, and each control shows the value read back from the device.

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
