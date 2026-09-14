# Orchestrator avatars

Status: Accepted and implemented for web and desktop.

## Confirmed intent

Replace the static bot imagery with animated avatars that interact with the user. Avatar configuration belongs in new-orchestrator setup. The requested placements include the navigation rail, the chat header, and the chat empty state.

The avatars must express actual work status, react when clicked, and express conversational tone. Conversational expression is a core requirement. Pointer tracking has not been decided.

The orchestrator chooses its conversational expression alongside each response, rather than the client inferring tone from keywords. Actual work status is driven by runtime events. The implementation details below specify expression vocabulary, transport, and fallback.

Conversational expression and work status can coexist: the face expresses the message's tone while a separate small status indicator communicates states such as working or needing user input. Requests needing attention trigger one brief reaction, then settle; they do not cause persistent attention-seeking motion.

Each orchestrator has a personality configurable by the user, rather than one expression style shared by all orchestrators. By default, personality settings jointly shape the avatar's expression and the orchestrator's conversational tone. An advanced option exposes finer controls using sliders, allowing users to tune those aspects separately. Sliders use a 0–100 range.

The agreed personality sliders are:

| Trait          | Low end     | High end     | Meaning                                                                                   |
| -------------- | ----------- | ------------ | ----------------------------------------------------------------------------------------- |
| Warmth         | Reserved    | Affectionate | Social warmth in replies and visual reactions.                                            |
| Playfulness    | Serious     | Whimsical    | Humor and playful behavior.                                                               |
| Energy         | Calm        | Enthusiastic | Enthusiasm in replies and movement.                                                       |
| Curiosity      | Focused     | Exploratory  | Direct answers and steady expressions through to probing questions and inquisitive looks. |
| Expressiveness | Understated | Animated     | How strongly tone is expressed through wording and visual reactions.                      |

Each trait affects both replies and avatar expression by default. Advanced controls allow each trait to be adjusted separately for replies and animation. Energy describes enthusiasm; expressiveness describes how strongly it shows. High settings still respect the quiet-idle requirement.

Appearance and personality belong to the orchestrator's shared identity. Its owner and authorized managers configure them; everyone interacting with that orchestrator sees the same configured character and personality. Viewer accessibility preferences, including reduced motion, can change local presentation without changing that identity.

This release covers web and desktop. Mobile avatar rendering and configuration are deferred to a later release. Shared identity and configuration must remain compatible with existing mobile clients; mobile-specific interface work is outside this release.

[Bloub](https://github.com/jeremy-prt/bloub) and its [demo](https://bloub.vercel.app/) are the supplied references. The implementation uses original React/SVG artwork and brief animations; Bloub is the visual reference.

The visual direction is a consistent family of Bloub-style characters with selectable shapes, colors, and eyes, rather than a collection of distinct robot characters. The initial option set is detailed below.

Setup presents a live avatar preview alongside shape, color, and eye choices. Users can start from personality presets such as Calm colleague, Curious thinker, and Playful helper, then fine-tune the five personality sliders. Preset values are defined in the shared personality configuration.

The personal orchestrator supplies the default avatar for the sidebar and welcome screen. Direct chats show the selected orchestrator, and group chats retain participant avatars. Before setup, a default character represents the entry point; a separate permanent Pathway mascot is not required.

Idle behavior stays quiet: occasional brief blinks or glances, with complete rest between them. Work status changes, conversational expressions, and clicks trigger more noticeable reactions. Constant motion is not desired; the avatars should not distract users from their work.

Click reactions are brief and silent, preserving the control's normal action. The sidebar avatar reacts and opens chat. Clicking an avatar does not itself generate a conversational reply.

Existing orchestrators automatically receive the new avatar while retaining their current color and written persona. Owners and authorized managers can customize appearance and personality in Settings afterward; choosing a new avatar is not required to receive the visual upgrade.

## Existing behavior

Orchestrator configuration currently stores a color alongside its name and persona. Individual avatars render the same bot icon with that color. Group chat headers show up to three participant avatars. The navigation rail and empty state use generic bot icons rather than representing a particular orchestrator.

## Implementation

The following implementation choices realize the agreed product behavior.

- Use a bounded set of expressions, initially neutral, curious, thoughtful, pleased, concerned, and encouraging. Missing or unsupported expressions fall back to the configured resting appearance without disrupting a response.
- Persist expression metadata with its message so clients agree on the expression. Generate it during the existing response flow rather than a separate model call. Never transmit animation frames. Inspect each supported provider path before choosing the metadata mechanism.
- Store appearance and personality on the existing cloud-owned orchestrator configuration, using compatible defaults for older records. Preserve written personas and avoid injecting a new tone directive into existing orchestrators until personality is explicitly configured.
- Use sliders from 0 to 100, with named endpoints. Advanced overrides inherit the shared trait until explicitly changed. Provide a reset to shared values without discarding the shared personality.
- Keep shape, color, and eye selection independent of personality so changing tone does not unexpectedly change visual identity. Define a small curated option set when evaluating the renderer.
- Use the default character when a personal orchestrator is absent or unavailable. In groups, apply message expressions to the sender's avatar and retain separate work status per orchestrator.
- Defer continuous pointer tracking. Click, keyboard activation, and tap should produce equivalent brief reactions where the avatar is interactive, preserving existing navigation and accessible labels.
- Suspend animation when hidden or offscreen. Run no frame loop between idle reactions. Reduced motion presents static expressions and work indicators. Do not replay historical reactions when loading a conversation.
- Reuse the shared web implementation for desktop. Keep native mobile interface changes outside this release while checking compatibility of shared configuration and response contracts.

## Implementation sequence

1. Evaluate Bloub's framework-independent engine and source attribution requirements, then select a React-compatible rendering approach. Do not introduce a second UI framework for the avatar.
2. Add compatible appearance and personality configuration, defaults, and focused persistence/permission tests.
3. Add the reusable avatar renderer with expression, work status, and motion lifecycle controls.
4. Integrate setup and Settings previews, presets, sliders, advanced overrides, and reset behavior.
5. Connect response expressions and runtime status, then replace avatars across the rail, welcome screen, chat headers, participant lists, and other existing orchestrator avatar placements on web and desktop.
6. Verify expression fallback, identity consistency, existing-orchestrator defaults, group behavior, remote delivery, and renderer cleanup. Perform an integrated visual and performance pass when browser verification is authorized.

## Acceptance criteria

- Users can configure an orchestrator during setup and edit it later, with the same saved identity visible to other authorized participants.
- Shared sliders influence both reply tone and expression; advanced overrides can be independently adjusted and reset.
- An expressive response cannot replace or falsify actual work status.
- Click reactions remain silent and preserve normal control behavior.
- Idle characters rest between brief reactions; hidden characters do not animate; reduced motion remains usable.
- Existing orchestrators retain their colors and written personas and gain the new visual representation automatically.
- Web and desktop support the feature in local and remote connections. Existing mobile clients remain compatible.

The renderer uses original SVG silhouettes and eye poses in React, inspired by Bloub's visual direction. It does not import Bloub or Vue. Six shapes, four eye styles, and the existing six colors are available. The Web Animations API runs brief blinks, gaze shifts, and greeting transforms. The first blink arrives after 1–2.2 seconds; subsequent gestures alternate blinks and small glances with 2.2–5.4 seconds between starts, adjusted by Energy. Each gesture finishes before the next begins. Compatible cubic paths morph eyes and silhouettes in place over 420 milliseconds, using a bounded requestAnimationFrame transition that stops on arrival and retargets from the currently displayed pose. Timers, gestures, and transitions stop when hidden, offscreen, or reduced motion is enabled; there is no frame loop at rest.

The existing tool-free coordinator JSON response carries optional expression metadata through the same response flow for Codex, Claude, and OpenCode. Cursor and Grok remain outside the supported coordinator drivers; this feature does not change provider eligibility. Convex normalizes unrecognized expressions to neutral and persists the expression with the message. Work status comes from execution leases and delegated-work records, with lease-expiry timers in the client.

Optional configuration fields preserve older records and clients. Existing clients that omit avatar/personality during a settings save do not erase those fields. New orchestrators start with Calm colleague; existing records without personality settings do not receive new tone instructions until configured. The navigation subscribes to a small personal-avatar projection instead of fetching all orchestrator instructions outside the orchestrator views. While orchestrator views are open, a deduplicated directory supplies visual identities for readable conversations across workspaces; it follows the same membership and workspace-access checks as the conversation list and excludes written personas and instructions.

Verification covers persistence and permissions, legacy saves, expression fallback, personality override inheritance, work status, and motion suspension/cleanup. Browser verification confirms interpolated expressions retain the same eye elements and settle between reactions. A dedicated component preview records idle gestures, expression transitions, and click reactions. The Electron shell has not been exercised separately.
