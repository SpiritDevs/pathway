# SnapShots

A SnapShot captures a window, screen, or region and opens an editor. Draw arrows, shapes, and text
to explain what matters, then copy the image, save it to your chat draft, or download it.
Window captures carry the app name and window title, and when available the app icon and the
window's accessibility data (its controls, text, and their positions in the image). Agents can use
that data to reason about the screenshot.

SnapShots are off by default and available in the desktop app on macOS, Windows, and Linux with
Wayland. X11 sessions are not supported. SnapShots settings are only shown in the desktop app,
not in a web browser.

## Turning it on

Open **Settings** > **SnapShots** and turn the feature on. Setup has two steps: allow capture, then
choose a shortcut. Each step shows only what your desktop needs. **Finish later** turns capture back
off but keeps anything you already installed, so you can resume where you left off.

- **macOS** asks for Screen Recording during setup. It asks for Accessibility only when **Include
  app text** is on.
- **Windows** needs no setup or permission.
- **Linux** depends on your desktop. See [Linux desktops](#linux-desktops).

On macOS, choose **Allow** beside **Screen Recording** or **Accessibility**. A small panel stays
visible while System Settings opens. Drag the app from that panel into the permission list, then
turn on its switch. You can also click the app to show it in Finder. Use the back arrow or return to
Pathway to recheck access, and repeat for the other permission. If macOS asks you to quit and reopen
Pathway after allowing Screen Recording, do so, then resume setup.

Turning capture off releases the shortcuts. It does not uninstall a helper or extension you installed.

## Taking a capture

Choose a capture action from the command palette or **Settings** > **SnapShots** > **Capture…**,
or press its shortcut from any app:

- **Capture active window** captures the window you are working in. Its default shortcut on macOS
  and Windows is both Shift keys together.
- **Capture current screen** captures everything visible on the display containing your pointer.
- **Capture region** lets you drag a rectangle around part of the screen. Press Escape to cancel.

Screen and region capture are available on macOS and Windows. Linux desktops currently support
window capture only. Screen and region shortcuts start unassigned; choose your own in Settings.

Pressing the window shortcut while Pathway is in front captures Pathway itself. If capture is off,
the command palette actions open capture settings.

## Editing and sharing

Every capture opens the editor. Use the toolbar to add arrows, rectangles, circles, freehand marks,
highlights, or text. Select a mark to move or delete it, change the colour and line width, and use
undo and redo to revise your work. Crop removes the parts of the image you do not need.

Choose one of the three actions when you are finished:

- **Copy** copies the annotated image to your clipboard.
- **Save to chat** adds the annotated image to your draft. It does not send the message. If no thread
  is open, Pathway starts a draft in the current project or selected environment.
- **Download** saves the annotated image as a PNG.

PNG exports keep the captured resolution unless they exceed the export size limit; larger images
are reduced to fit.

Each action closes the editor after it succeeds. If an action fails, the editor stays open so you
can retry. Cropping removes app text metadata and retains the capture details, so hidden text is
not shared outside the selected area. Screen and region captures do not include unrelated app text.

Captured originals are kept on disk until you complete an editor action, so a capture survives
closing the app mid-way. Pending captures reopen for the same signed-in account after the next
launch. Signing out pauses capture; another account cannot receive your pending captures.
A failed action keeps the pending capture so it can be retried. Use **Saved captures** in
SnapShots settings to discard a pending copy. Discarding it does not remove an image already in a draft.

## Changing shortcuts

Each capture action has its own shortcut in Settings. Select its shortcut, press the new keys, then
**Save**. Use **Clear** to remove a screen or region shortcut while keeping the action available in
the capture menu and command palette. On macOS and Windows you can use
a modifier pair such as Command+Command or Ctrl+Ctrl, or a key chord. Pathway refuses shortcuts
that collide with another capture action, its own keybindings, or an operating system reservation.

On Linux, choose a key chord; modifier pairs are not supported. On Niri and Hyprland the shortcut
lives in your compositor config, so **Change shortcut** reopens setup to review the change.

## Include app text

**Include app text** controls whether window captures include accessibility data. Screen and region
captures include only their image and capture details. Turn it off to attach screenshots only.
On macOS this also drops the Accessibility permission requirement.

Availability depends on the app. Some apps expose only their window controls, not the document or
terminal contents. If an app is slow to answer, Pathway attaches the screenshot without the data
rather than waiting.

On GNOME, browsers may need app accessibility enabled in the desktop's accessibility settings before
they expose text. Restart the browser after enabling it.

An icon beside the app name on an attachment shows whether accessibility data was included. Select
it to inspect what was captured.

## Sound and flash

Settings controls the capture sound and the brief flash on the captured window. Each can be turned
off independently. Available effects depend on your desktop.

## Linux desktops

SnapShots work on Wayland sessions. Each desktop provides capture differently, and setup names your
current desktop and shows only what it needs. Preferences carry across desktops, but each desktop's
helper and shortcut approval are separate.

**GNOME.** Install the bundled **Pathway SnapShots** extension during setup. It is installed
per-user, offline, and needs no administrator password. Sign out and back in after the first
install so GNOME discovers it, then enable it from setup or from GNOME's Extensions app. If GNOME
has disabled all user extensions, turn them on there first. Disable or remove the extension in
GNOME's Extensions app to revoke access.

**KDE Plasma 6.** Install the bundled capture helper during setup; no sign-out is needed. If the
shortcut does not fire, check Pathway under **System Settings** > **Keyboard** > **Shortcuts**. If a
shortcut using Shift and a number does not work on your keyboard layout, use a letter chord instead.
Remove the helper from **Manage capture** > **Access** > **Advanced**.

**Hyprland and Omarchy.** Install the bundled helper during setup, then choose a shortcut and select
**Review changes**. Pathway shows the exact change it will make to your Hyprland config. **Save
shortcut** writes only that change, keeps a backup, and reloads Hyprland. Approve the screen-sharing
prompt for the helper if one appears. On Omarchy, bind in your own config, not the shipped defaults.
Some Hyprland versions return an "access denied" image instead of an error when capture is blocked;
check the helper's screen-sharing permission.

**Niri.** Choose a shortcut and select **Review changes**. Pathway shows the exact binding it will
add to your Niri config, validates the result, keeps a backup, and saves it when you approve. Niri
reloads the config on its own. The binding needs the `gdbus` command, normally part of your
distribution's GLib tools. Remove the line from your config to release the key.

**Other Wayland desktops.** Pathway uses the desktop's screenshot portal when it can capture the
active window. Otherwise Settings shows **Manual capture only** and the shortcut opens the desktop's
window picker. Picker captures do not include accessibility data.

Apps running through XWayland inside a Wayland session can still be captured.

## Remote environments and other clients

Capture runs on the computer running the Pathway desktop app. When your thread uses a remote
environment, the captured image and its details are sent with your message to that environment.
The shortcut does not capture the remote machine's screen.

You can view sent captures in the web app and native Apple app, including their app and window
information and available app text. Browser and mobile clients do not register desktop capture
shortcuts. Remove a capture from the draft before sending if you do not want to share it.
