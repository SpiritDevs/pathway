import SwiftUI

private enum AgentPlaceholderNotice: String, Identifiable {
    case attachments
    case history

    var id: Self { self }

    var title: String {
        switch self {
        case .attachments: "Attachments"
        case .history: "Chat history"
        }
    }

    var message: String {
        switch self {
        case .attachments:
            "Attachments will be available when the native orchestrator is connected."
        case .history:
            "Your previous agent conversations will appear here."
        }
    }
}

struct AgentOrchestratorView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dismissWindow) private var dismissWindow
    @FocusState private var isComposerFocused: Bool
    @State private var draft = ""
    @State private var submittedPrompt: String?
    @State private var presentedNotice: AgentPlaceholderNotice?

    private var trimmedDraft: String {
        draft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        VStack(spacing: 0) {
            header

            Group {
                if let submittedPrompt {
                    placeholderConversation(prompt: submittedPrompt)
                } else {
                    welcomeContent
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Color(.systemBackground))
        .safeAreaInset(edge: .bottom, spacing: 0) {
            composer
        }
        .task(focusComposerIfAppropriate)
        .alert(item: $presentedNotice) { notice in
            Alert(
                title: Text(notice.title),
                message: Text(notice.message),
                dismissButton: .default(Text("OK"))
            )
        }
        .accessibilityIdentifier("agent-orchestrator-view")
    }

    private var header: some View {
        ZStack {
            Text("New chat")
                .font(.headline)

            HStack {
                headerButton(
                    systemImage: "xmark",
                    accessibilityLabel: "Close agent orchestrator",
                    action: close
                )

                Spacer()

                headerButton(
                    systemImage: "clock.arrow.circlepath",
                    accessibilityLabel: "Chat history"
                ) {
                    presentedNotice = .history
                }
            }
        }
        .padding(.horizontal, 18)
        .frame(height: 72)
    }

    private func headerButton(
        systemImage: String,
        accessibilityLabel: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 20, weight: .semibold))
                .frame(width: 50, height: 50)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .background(Color(.secondarySystemBackground), in: Circle())
        .accessibilityLabel(accessibilityLabel)
    }

    private var welcomeContent: some View {
        ScrollView {
            VStack(spacing: 0) {
                Spacer(minLength: 36)

                Image(systemName: "cursorarrow")
                    .font(.system(size: 27, weight: .medium))
                    .symbolRenderingMode(.hierarchical)
                    .padding(.bottom, 22)

                Text("Welcome to Pathway Agent")
                    .font(.title2.weight(.semibold))
                    .multilineTextAlignment(.center)

                Text("Ask anything or tell Pathway what you need")
                    .font(.title3)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.top, 8)

                suggestionChips
                    .padding(.top, 22)

                HStack(spacing: 8) {
                    Text("@")
                        .font(.body.weight(.semibold))
                        .frame(width: 28, height: 28)
                        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 7))

                    Text("to mention any issue, project, or thread")
                        .foregroundStyle(.secondary)
                }
                .font(.body)
                .padding(.top, 24)

                Spacer(minLength: 44)
            }
            .frame(maxWidth: 720)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 20)
        }
    }

    private var suggestionChips: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) {
                suggestionChip(title: "Agent setup", systemImage: "gearshape.fill")
                suggestionChip(title: "Issue research", systemImage: "magnifyingglass")
                suggestionChip(title: "Situation report", systemImage: "bolt.fill")
            }

            VStack(spacing: 10) {
                suggestionChip(title: "Agent setup", systemImage: "gearshape.fill")
                suggestionChip(title: "Issue research", systemImage: "magnifyingglass")
                suggestionChip(title: "Situation report", systemImage: "bolt.fill")
            }
        }
    }

    private func suggestionChip(title: String, systemImage: String) -> some View {
        Button {
            draft = title
            isComposerFocused = true
        } label: {
            Label(title, systemImage: systemImage)
                .font(.callout.weight(.medium))
                .foregroundStyle(Color.primary)
                .padding(.horizontal, 13)
                .frame(height: 38)
                .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 11))
                .overlay {
                    RoundedRectangle(cornerRadius: 11)
                        .stroke(Color.primary.opacity(0.09), lineWidth: 1)
                }
        }
        .buttonStyle(.plain)
    }

    private func placeholderConversation(prompt: String) -> some View {
        #if os(visionOS)
            conversationContent(prompt: prompt)
        #else
            conversationContent(prompt: prompt)
                .scrollDismissesKeyboard(.interactively)
        #endif
    }

    private func conversationContent(prompt: String) -> some View {
        ScrollView {
            VStack(alignment: .trailing, spacing: 18) {
                Text(prompt)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 18))

                ContentUnavailableView(
                    "Ready for orchestration",
                    systemImage: "sparkles",
                    description: Text(
                        "Agent responses will appear here when the Pathway orchestrator is connected."
                    )
                )
                .frame(maxWidth: .infinity)
                .padding(.top, 80)
            }
            .padding(20)
            .frame(maxWidth: 820)
            .frame(maxWidth: .infinity)
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 14) {
            TextField("Ask Pathway…", text: $draft, axis: .vertical)
                .focused($isComposerFocused)
                .font(.title3)
                .lineLimit(1 ... 4)
                .submitLabel(.send)
                .onSubmit(submitPrompt)
                .accessibilityIdentifier("agent-orchestrator-composer")

            HStack(spacing: 22) {
                Button {
                    presentedNotice = .attachments
                } label: {
                    Image(systemName: "paperclip")
                }
                .accessibilityLabel("Add attachment")

                Button {
                    insertMention()
                } label: {
                    Image(systemName: "at")
                }
                .accessibilityLabel("Mention Pathway item")

                Spacer()

                Button(action: submitPrompt) {
                    Image(systemName: "arrow.up")
                        .font(.body.weight(.bold))
                        .foregroundStyle(trimmedDraft.isEmpty ? Color.secondary : Color.white)
                        .frame(width: 38, height: 38)
                        .background(
                            trimmedDraft.isEmpty ? Color(.tertiarySystemFill) : Color.accentColor,
                            in: Circle()
                        )
                }
                .disabled(trimmedDraft.isEmpty)
                .accessibilityLabel("Send message")
            }
            .font(.system(size: 22, weight: .medium))
            .buttonStyle(.plain)
        }
        .padding(18)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 28))
        .shadow(color: .black.opacity(0.06), radius: 22, y: 8)
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .frame(maxWidth: 820)
        .frame(maxWidth: .infinity)
    }

    private func focusComposerIfAppropriate() async {
        #if !os(visionOS)
            await Task.yield()
            isComposerFocused = true
        #endif
    }

    private func close() {
        #if os(visionOS)
            dismissWindow(id: PathwayWindow.agentOrchestrator.rawValue)
        #else
            dismiss()
        #endif
    }

    private func insertMention() {
        if !draft.isEmpty, !draft.hasSuffix(" ") {
            draft.append(" ")
        }
        draft.append("@")
        isComposerFocused = true
    }

    private func submitPrompt() {
        guard !trimmedDraft.isEmpty else { return }
        submittedPrompt = trimmedDraft
        draft = ""
        isComposerFocused = false
    }
}

#Preview("Agent Orchestrator") {
    AgentOrchestratorView()
}
