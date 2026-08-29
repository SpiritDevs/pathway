import SwiftUI

/// Bottom composer for a thread conversation.
///
/// In the compact shell this view owns the middle slot of the immutable three-control bottom
/// row: `CompactAppShell` draws the leading navigation surface and the trailing orchestrator
/// button, and the two clear spacers here reserve their footprint. Tapping the middle pill
/// expands it into a full editing card and the shell drops its tab bar in the same transaction,
/// so the card replaces the row rather than covering it. Both halves run on
/// `CompactAppShellMetrics.navigationChromeAnimation` for that reason.
struct AgentThreadComposer: View {
    /// Matches the collapsed pill and the expanded card so one surface grows between them
    /// instead of two surfaces cross-fading in place. Both halves are on screen together
    /// while the transition runs, so `isSource` follows `isExpanded`: the arriving shape owns
    /// the geometry and the departing one interpolates onto it, in either direction.
    private static let surfaceID = "agent-thread-composer-surface"
    private static let placeholder = "Ask the repo agent, or run a command…"

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Bindable var model: PathwayAgentThreadModel
    @Binding var isExpanded: Bool
    @FocusState.Binding var isFocused: Bool
    let modelName: String
    let usesCompactPresentation: Bool
    let isNavigationExpanded: Bool

    @Namespace private var surfaceNamespace
    @State private var isAttachmentNoticePresented = false
    /// Keeps the toolbar controls proportional to the editor text at every Dynamic Type size.
    @ScaledMetric(relativeTo: .body) private var controlDiameter: CGFloat = 36

    @ViewBuilder
    var body: some View {
        if usesCompactPresentation {
            if isExpanded {
                expandedComposer
                    .task {
                        await Task.yield()
                        guard isExpanded else { return }
                        isFocused = true
                    }
                    .transition(.opacity)
            } else {
                collapsedComposer
                    .transition(.opacity)
            }
        } else {
            inlineComposer
        }
    }

    private var collapsedComposer: some View {
        HStack(spacing: 12) {
            Color.clear
                .frame(
                    width: CompactAppShellMetrics.tabBarHeight,
                    height: CompactAppShellMetrics.tabBarHeight
                )
                .accessibilityHidden(true)

            Button {
                withAnimation(
                    reduceMotion ? nil : CompactAppShellMetrics.navigationChromeAnimation
                ) {
                    isExpanded = true
                }
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "plus")
                        .font(.body.weight(.semibold))
                    Text("Message agent")
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 18)
                .frame(maxWidth: .infinity)
                .frame(height: CompactAppShellMetrics.tabBarHeight)
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .foregroundStyle(.primary)
            .background {
                Capsule()
                    .fill(.regularMaterial)
                    .matchedGeometryEffect(
                        id: Self.surfaceID,
                        in: surfaceNamespace,
                        isSource: !isExpanded
                    )
            }
            .accessibilityLabel("Message agent")
            .accessibilityHint("Expands the message composer")
            // Collapses towards the trailing edge as the navigation surface grows over it
            // from the leading edge. `scaleEffect` is geometry-only, so the inset keeps its
            // height and the transcript never jumps.
            .scaleEffect(x: isNavigationExpanded ? 0.001 : 1, anchor: .trailing)
            .opacity(isNavigationExpanded ? 0 : 1)
            .allowsHitTesting(!isNavigationExpanded)
            .accessibilityHidden(isNavigationExpanded)

            Color.clear
                .frame(
                    width: CompactAppShellMetrics.tabBarHeight,
                    height: CompactAppShellMetrics.tabBarHeight
                )
                .accessibilityHidden(true)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, CompactAppShellMetrics.tabBarBottomPadding)
        // Scoped so the shrink runs on the shared curve regardless of which transaction
        // (button tap, backdrop tap, scroll) drove the change.
        .animation(
            reduceMotion ? nil : CompactAppShellMetrics.navigationChromeAnimation,
            value: isNavigationExpanded
        )
    }

    private var expandedComposer: some View {
        VStack(alignment: .leading, spacing: 12) {
            // The lower bound reserves the card's resting height in text lines, so the card
            // keeps its proportions as Dynamic Type grows instead of clipping the editor.
            TextField(Self.placeholder, text: $model.draft, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(5 ... 10)
                .focused($isFocused)
                .frame(maxWidth: .infinity, alignment: .topLeading)
                .accessibilityIdentifier("agent-thread-composer-field")

            composerToolbar
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 16)
        .background {
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .fill(.regularMaterial)
                .matchedGeometryEffect(
                    id: Self.surfaceID,
                    in: surfaceNamespace,
                    isSource: isExpanded
                )
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, CompactAppShellMetrics.tabBarBottomPadding)
        .alert("Attachments", isPresented: $isAttachmentNoticePresented) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Sending attachments from the Pathway iOS app isn't available yet.")
        }
        .accessibilityIdentifier("agent-thread-composer-expanded")
    }

    private var composerToolbar: some View {
        HStack(spacing: 10) {
            attachmentButton
            modelMenu
            Spacer(minLength: 0)
            sendButton
        }
    }

    private var attachmentButton: some View {
        Button {
            isAttachmentNoticePresented = true
        } label: {
            Image(systemName: "plus")
                .font(.body.weight(.semibold))
                .frame(width: controlDiameter, height: controlDiameter)
                .background(Color(.tertiarySystemFill), in: Circle())
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.primary)
        .accessibilityLabel("Add attachment")
    }

    /// The thread's model is fixed once Pathway launches the thread, and Connect exposes no
    /// command to change it. The menu therefore reports the selection instead of offering
    /// alternatives it could not apply.
    private var modelMenu: some View {
        Menu {
            Section("Thread model") {
                Label(modelName, systemImage: "checkmark")
            }

            Section {
                Text("Switching models on an existing thread isn't available yet.")
            }
        } label: {
            HStack(spacing: 5) {
                Text(modelName)
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.semibold))
            }
            .font(.subheadline)
            .padding(.horizontal, 12)
            .frame(height: controlDiameter)
            .background(Color(.tertiarySystemFill), in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.primary)
        .accessibilityLabel("Thread model")
        .accessibilityValue(modelName)
    }

    private var sendButton: some View {
        Button(action: send) {
            Group {
                if model.isSending {
                    ProgressView()
                        .tint(.white)
                } else {
                    Image(systemName: "arrow.up")
                        .font(.body.weight(.bold))
                }
            }
            .frame(width: controlDiameter, height: controlDiameter)
            .foregroundStyle(canSend ? Color.white : Color.secondary)
            .background(canSend ? Color.accentColor : Color(.tertiarySystemFill), in: Circle())
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!canSend)
        .accessibilityLabel("Send message")
    }

    /// Regular-width windows keep the single-row composer: they never collapse into the
    /// compact three-control chrome, so there is nothing for a tall card to morph out of.
    private var inlineComposer: some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextField(Self.placeholder, text: $model.draft, axis: .vertical)
                .lineLimit(1 ... 7)
                .textFieldStyle(.plain)
                .focused($isFocused)
                .padding(.horizontal, 4)
                .padding(.vertical, 8)
                .submitLabel(.send)
                .onSubmit(send)

            Button(action: send) {
                if model.isSending {
                    ProgressView()
                        .frame(width: 34, height: 34)
                } else {
                    Image(systemName: "arrow.up")
                        .font(.body.weight(.bold))
                        .frame(width: 34, height: 34)
                }
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.circle)
            .disabled(!canSend)
            .accessibilityLabel("Send message")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 26))
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private var canSend: Bool {
        !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !model.isSending
    }

    private func send() {
        Task {
            await model.send()
            guard usesCompactPresentation, model.draft.isEmpty else { return }
            withAnimation(
                reduceMotion ? nil : CompactAppShellMetrics.navigationChromeAnimation
            ) {
                isExpanded = false
            }
            isFocused = false
        }
    }
}
