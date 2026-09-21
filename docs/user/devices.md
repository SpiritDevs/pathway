# Devices

Open an iOS Simulator or Android Emulator beside a conversation to view its screen and use its controls.

1. Open the conversation's right-panel menu and choose **Device**.
2. Enable device support for that environment and complete setup.
3. Choose a simulator or emulator. A stopped device starts when selected.

You can also manage device support and remote device hosts in **Settings → Integrations → Devices**. Choose the environment you want to configure. iOS requires Xcode on a Mac; Android requires Android SDK command-line tools and an emulator. Start a newly created iOS Simulator once in Xcode before refreshing the device list.

Device support and agent control are separate choices. Leave **Agent device access** off to use manual controls only. Turn it on to let agents discover, open, inspect and control devices. Turning it off revokes access for existing agent sessions too.

The control rail provides navigation, rotation, screenshots and device settings. Supported streams offer a 3D view; smaller layouts and unsupported browsers use the flat screen view. Foldable controls appear when the device helper reports support for them. iPhone Duo support is experimental; display orientation and touch behavior are still being validated.

Hiding a device view stops its stream. Closing the panel leaves the simulator or emulator running. Choose **Power off** to shut it down. Disabling device support stops Pathway's device helpers; it does not delete your simulators or their data.

Remote device hosts use SSH. Their Xcode or Android installation belongs to that host. Pathway provides discovery, streaming and controls; your project remains responsible for builds, app installation and development-server forwarding.
