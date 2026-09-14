# Orchestrators

Orchestrators are AI contacts that coordinate your work and delegate implementation to agent threads. Chief is your personal coordinator. You can create additional contacts for projects or other responsibilities, give them names and personas, and talk in continuing direct or group conversations.

Open Orchestrators from the navigation rail. The full view has conversations on the left, messages in the center, and conversation details on the right. The floating companion opens above any app view. Switching between floating and full views preserves the selected conversation and unsent message. Both support light and dark appearance.

## Settings

Open the main Settings area and find the **Orchestrators** group. Select a contact to configure its overview, instructions, models, environments, responsibilities, permissions, memory, notifications, or work limits.

The default model is GPT-6 Astra with high reasoning. Drag model choices into fallback order and configure each choice's environment, provider, model, and supported options. A selected environment must be connected and able to run that provider.

Instructions shape how the coordinator communicates and plans. Coding remains delegated to worker threads. Permissions control which Pathway actions the coordinator and its workers can use. Direction and settings-management permissions are separate.

## Appearance and personality

On web and desktop, choose a shape, colour, and eye style when creating an orchestrator, or edit them later in **Settings → Orchestrators → Overview**. The live preview shows how their expressions look; click the character for a silent greeting.

Start with **Calm colleague**, **Curious thinker**, or **Playful helper**, then adjust Warmth, Playfulness, Energy, Curiosity, and Expressiveness. The five sliders shape both replies and avatar reactions. Open **Advanced** to tune replies and reactions separately. Untouched advanced sliders follow the shared personality; use **Reset to shared** to remove overrides.

Appearance and personality belong to the orchestrator. Its owner and authorized managers configure the same identity everyone sees. Existing orchestrators receive a new avatar in their current colour and retain their written personas until personality sliders or a preset are applied.

The face expresses the tone of a response. A separate status dot reports work such as working, queued, completed, paused, or needing attention. Characters blink and make small glances, with rest between gestures. Their eyes and body move smoothly between expressions; clicks and new updates trigger brief reactions. Reactions are silent, respect reduced motion, and stop when hidden. Opening old messages does not replay their reactions.

## Switching conversations

In the floating companion, select the sidebar button immediately to the left of the avatar. When there is enough space on the left, the conversation list slides out beside the chat at the same height. In a smaller window, it slides over the chat, including its header, with a backdrop confined to the companion. Both layouts match the companion’s height; the overlay never covers the rest of the app. Resize the window while it is open to move between these layouts. The list includes search, the latest message, its send time, and an unread count for each room. Select a conversation to switch and close the list; your draft stays with its conversation. Escape or the close button also closes the list.

The number beside the sidebar icon counts unread messages across active conversations, excluding archived rooms and internal agent events. Counts above 99 appear as **99+**. Opening and reading a conversation updates its count. Older messages show a date; hover the timestamp for the full send time.

## Conversations and work

Background checks happen quietly. Internal activity triggers and review instructions do not appear as messages, change the conversation preview, or create unread badges. Your orchestrator replies when it has something useful to report. Participant changes remain visible.

While an orchestrator is thinking, its avatar appears beside a compact status just above the message composer. Group conversations show each active orchestrator. A message is marked **Seen** when an environment picks it up for the orchestrator; queued messages have not yet been picked up. Seen receipts remain after the response finishes. The archive shortcut stays at the bottom of the conversation sidebar.

Invite orchestrators into a group when projects need to coordinate. Choose the group lead for unaddressed messages. You can share existing group history with a new participant or start their access from joining. Membership does not grant access to separate direct messages or private memory.

Delegated work appears in chronological order in the conversation and in the conversation details, with a link to its worker thread. New messages appear after earlier work cards, and progress updates keep those cards in place. When a run finishes, its final answer returns to the orchestrator automatically so it can report the findings. Requested work reports back even when proactive reviews are disabled. The orchestrator can also read its delegated conversation directly to recover missing findings or check progress, without starting another worker. Reads return a bounded excerpt of visible user and assistant messages when the assigned environment is available. A finished run whose answer has not arrived yet says it is waiting for findings; collection resumes when its environment is available, even if the thread has since continued. An offline environment's accepted work may still be running; an uncertain status does not mean it stopped.

PA assignments that are unrelated to a project run in worker conversations. Project orchestrators continue to dispatch within their own project. An authorized PA worker can read connected mail, prepare drafts, submit mail for delivery, and manage your manual time tracker. These personal tools stay in your private conversation and use the orchestrator's current mail and time permissions. Queued email is checked again before sending; uncertain delivery remains visible for review.

In **Responsibilities**, choose event-only activity or a recurring review every 15 minutes, hour, four hours, or day. Reviews use the selected model and conversation allowance, and wait when a request is already queued or running. Turn off proactive work to cancel pending reviews. Each review sees a bounded selection of recent permitted issues and threads. Environment resource observations include their timestamps; missing or old readings do not mean a host has spare capacity.

New task changes, thread completions, priority mail, and environment availability changes can wake the relevant coordinator. Updates remain queued when no eligible environment is online. Connected mobile devices can receive unread conversation updates through Pathway's push service while the app is closed, using their existing notification preferences. Read, superseded, expired, or inaccessible updates are withdrawn before delivery.

Ask the coordinator to stop a specific assignment or redirect work that its environment has not accepted. Redirecting cancels the original command and queues its replacement under the same conversation limits. Accepted or uncertain work needs a confirmed stop before replacement.

Pause prevents new autonomous activity while existing assignments continue. Stop work also cancels queued assignments and requests interruption of active workers. An offline worker's stop remains unconfirmed until its environment responds. Archive retains the contact and its history; resume and unarchive restore it.

Memory settings let you inspect, correct, and forget saved information. Memories retain their source and visibility. Explicit instructions take precedence over inferred preferences.

Preferences stay with one orchestrator unless you choose a wider scope. Ask to apply a preference across all your private orchestrators, or choose that scope in Memory settings. The shared fact appears in their memory lists; the source conversation stays private. Forgetting removes the saved text and prevents old messages from teaching it again.

## Provider allowance

Open **Settings → Providers**, choose the environment, expand the provider instance, and select **Manage allowance**. Choose a workspace and the thread or conversation to manage. The provider instance is selected initially; add windows for fallback accounts to the same allocation. All existing allowances for the selected work remain available, including limits from previous accounts. On iOS, open **Settings → Environments & providers**, select the environment and provider, then **Manage allowance**.

A read-only environment connection still lets you manage allowances using your workspace permissions. Threads appear after they sync to the selected workspace.

Choose a provider account window and the number of percentage points to allocate. Ten points from 60% remaining targets 50% remaining. All observed activity on that account counts, including other work; the display is not an exact measurement of this assignment's consumption.

The allocation follows delegated work. Each fallback account needs its own allocation. Pathway holds new work near the limit and requests interruption of managed active turns at the observed threshold. Missing or stale readings also hold work. Provider reporting delays and calls already in flight can overshoot the limit.

Pause retains the allocation, queued requests, and partial results. **Authorize new allocation** starts from a fresh reading. A provider quota reset does not renew an assignment's authorization. **Remove limit and resume** removes that allocation; any other limits still apply.

You can give a numeric allocation in a message, such as “Use 10% of the weekly usage allowance for this assignment.” The coordinator records the quoted instruction and confirms the baseline and threshold. Agents can establish the same limit for their current human request. Adding a limit does not remove or increase any existing limit.

When authorizing a new allocation, you can choose a one-time resume date and timezone. This pauses work immediately and takes a fresh baseline at the chosen time. Every selected account needs a fresh reading. If resumption is missed by more than one hour, work stays held for your instruction. Cancel the scheduled resume to retain the current hold. An interrupted worker can continue from retained progress when allowance is authorized; newer requests, archiving, and snoozing supersede that continuation.

The floating companion’s conversation details use the same behavior on the right: they attach outside when there is room and otherwise slide over the chat within its bounds, including the header. Close the panel or press Escape to return to the chat.

Attached panels slide smoothly out from the companion’s edge and share its outline. Closing a panel slides it back before restoring the companion’s rounded corners. Reduced motion preferences disable the slide.
