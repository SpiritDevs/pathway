# Computer

Computer lets an agent see and use the apps on a computer: it reads windows, clicks, types and
scrolls, while you watch a live preview in the chat. The computer it uses is always the machine
running the environment, not the device you are typing on. Ask from your phone or a browser, and
the agent works on the Mac that hosts your environment.

Computer currently works when the environment is a Mac running the Pathway server, such as the
Pathway desktop app. On other environments, `/computer-use` does not appear.

## Setting up

Open **Settings** > **Computer** on the host Mac. **macOS permissions** lists what Computer needs:

- **Accessibility**, to read windows and control apps.
- **Screen Recording**, to see the screen.
- **Input Monitoring**, so pressing Escape stops the agent and Computer pauses when you take over
  the mouse or keyboard.

Choose **Set up** and follow the guide that stays beside System Settings: drag Pathway into each
list and turn on its switch. macOS may ask you to quit and reopen Pathway after allowing Screen
Recording. If you open these settings from another device, the permissions section tells you to
grant them on the host instead.

## Asking for a task

Type `/computer-use` followed by your task, for example `/computer-use open Calculator and calculate
123 × 45`. This enables Computer for that one request. Sending `/computer-use` on its own keeps
your draft and asks you to add a task.

To let the agent use the computer in every chat without the command, turn on **Let the agent use the
desktop in any chat** in **Settings** > **Computer**.

The first time you use Computer, the composer may suggest Medium reasoning effort, which keeps
desktop tasks quick. Apply it or dismiss the tip; it does not come back once dismissed.

## Approving and following along

Depending on the environment's autonomy, Pathway asks before the agent starts, before it uses each
additional app, or before a single action. An approval card in the chat shows what the agent wants
to do. Approve or decline it there.

When an agent acts on the desktop, a preview appears over the chat. Float it as a window you can
drag, dock it back, or hide it for the rest of the task; hiding does not stop the agent. Tap the
preview to click at that spot on the controlled computer. The preview streams only while it is on
screen.

To stop the agent, use **Stop** in the chat, or press Escape on the host Mac. After a stop, send a
new request to continue.

If the agent needs something before it can continue, the chat shows a card:

- **Setup required** explains what the host is missing, such as a permission, and links to
  **Settings** > **Computer**.
- **Computer control is off** means the chat did not allow Computer. **Enable** puts
  `/computer-use` in front of your draft so you can send it. If this device was paired without
  Computer access, the card asks you to pair it again with access instead.

Computer never uses password managers, Keychain Access, Passwords, System Settings or the system's
security prompts, at any autonomy level.

## Access and oversight

Admins choose, in **Settings** > **Computer** > **Access and oversight**:

- **Who can use this computer**: **Any operator** (any paired device that can run threads),
  **Scoped** (only devices granted Computer access, the default; revoke it per device in
  **Settings** > **Connections**) or **Admins only**. Watching, approving and stopping are open to
  everyone who can see the chat.
- **Computer autonomy**: **Supervised** (approve every action), **Per task** (approve once per task
  and once per additional app, the default), **Auto** (no task or app approvals; bringing apps to the
  front and reading the clipboard still ask) or **Full access** (no approvals, and scheduled tasks
  and subagents may use the computer). A chat's own permission mode can make this stricter, never
  looser.

**Recent Computer actions** lists what agents did on the computer. It is visible only on an admin
connection.

## Preview and cursor

In **Settings** > **Computer** you can also:

- Turn off opening the preview automatically, and choose **Compact** or **Large** for its size.
- Colour the agent's cursor so you can tell it apart from yours. New Computer sessions use the new
  colours.

## On iPhone and iPad

The Pathway app for iPhone and iPad can ask for Computer tasks, follow them and stop them. The
agent still works on the host Mac; nothing runs on your phone.

- **Asking.** In a chat on a Mac environment, type `/` and choose **/computer-use**, then add your
  task. To use Computer in every chat you send from this device, turn on **Let the agent use the
  desktop in any chat** in **Settings** > **Computer**. The setting applies only to environments
  that can run Computer and that this device may use.
- **Following along.** While the agent drives the desktop, a live preview sits above the composer.
  It shows still images of the host's screen and the agent's latest action. It streams only while
  the chat is on screen and the app is open. Hide it with the close button; it comes back on the
  next task. You can't click through the preview from a phone. If the stream drops and cannot
  recover, the preview reads **Live view unavailable**.
- **Approving and stopping.** Approval, setup and control-off cards work as they do on the desktop.
  Grant macOS permissions on the host Mac itself. To stop the agent, tap **Stop** in the chat;
  Escape works only on the host's keyboard.
- **Settings.** **Settings** > **Computer** lists your environments. Each shows whether its desktop
  is ready and its access and autonomy settings. Only an admin connection can change those
  settings. The agent cursor, preview size and action history are set on the host.
- **Access.** When an environment offers Computer access, the app asks for it as it connects. If
  the environment's access policy is **Scoped** and this device was connected without Computer
  access, reconnect it to grant access.
