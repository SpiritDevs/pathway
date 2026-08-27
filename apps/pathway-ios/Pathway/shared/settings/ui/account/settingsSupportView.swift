import SwiftUI

@MainActor
struct SettingsSupportView: View {
    private enum Section: String, CaseIterable, Identifiable {
        case conversations = "Messages"
        case tickets = "Tickets"
        case news = "What's New"

        var id: String { rawValue }
    }

    let catalog: MobileSettingsCatalog
    let service: any SettingsSupportServicing
    let locale: Locale
    var initialSection: String? = nil

    @State private var selection: Section = .conversations

    var body: some View {
        VStack(spacing: 0) {
            Picker("Support section", selection: $selection) {
                ForEach(Section.allCases) { section in
                    Text(section.rawValue).tag(section)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal)
            .padding(.vertical, 10)

            switch selection {
            case .conversations:
                SettingsSupportConversationsView(catalog: catalog, service: service)
            case .tickets:
                SettingsSupportTicketsView(catalog: catalog, service: service, locale: locale)
            case .news:
                SettingsNewsListView(service: service, locale: locale)
            }
        }
        .navigationTitle("Support")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            if initialSection == "news" { selection = .news }
        }
    }
}

@MainActor
private struct SettingsSupportConversationsView: View {
    private enum Sheet: String, Identifiable {
        case newConversation
        var id: String { rawValue }
    }

    let catalog: MobileSettingsCatalog
    let service: any SettingsSupportServicing

    @State private var state: SettingsAccountLoadState<[SettingsSupportConversation]> = .loading
    @State private var reloadID = UUID()
    @State private var sheet: Sheet?

    var body: some View {
        Group {
            switch state {
            case .loading:
                List { SettingsAccountLoadingRows(count: 4) }
            case let .failed(message):
                SettingsAccountErrorView(message: message) { reloadID = UUID() }
            case let .loaded(conversations):
                List {
                    Section {
                        Button {
                            sheet = .newConversation
                        } label: {
                            SettingsIconLabel(
                                "Start a Conversation",
                                systemName: "square.and.pencil",
                                color: .blue
                            )
                        }
                    }

                    Section("Your Conversations") {
                        if conversations.isEmpty {
                            ContentUnavailableView(
                                "No Conversations Yet",
                                systemImage: "bubble.left.and.bubble.right",
                                description: Text("Questions? Start a conversation and we'll help.")
                            )
                        } else {
                            ForEach(conversations) { conversation in
                                NavigationLink {
                                    SettingsSupportConversationView(
                                        conversation: conversation,
                                        userID: catalog.identity.userId,
                                        service: service
                                    )
                                } label: {
                                    conversationRow(conversation)
                                }
                            }
                        }
                    }
                }
                .refreshable { await load() }
            }
        }
        .task(id: reloadID) { await load() }
        .sheet(item: $sheet) { _ in
            SettingsNewSupportConversationView(
                userID: catalog.identity.userId,
                companyID: catalog.workspace.companyId,
                service: service,
                onCreated: { reloadID = UUID() }
            )
        }
    }

    private func conversationRow(_ conversation: SettingsSupportConversation) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                Text(conversation.subject ?? conversation.title)
                    .font(.body.weight(.medium))
                    .lineLimit(1)
                Spacer()
                Text(
                    SettingsAccountFormatting.date(from: conversation.lastActivity) ?? .now,
                    style: .relative
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Text(conversation.recentMessages?.last?.content ?? "No messages yet")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            SettingsStatusLabel(status: conversation.status)
        }
        .accessibilityElement(children: .combine)
    }

    private func load() async {
        if case .loaded = state {} else { state = .loading }
        do {
            let conversations = try await service.loadConversations(
                userID: catalog.identity.userId,
                now: .now,
                limit: 50
            )
            try Task.checkCancellation()
            state = .loaded(conversations)
        } catch is CancellationError {
            return
        } catch {
            state = .failed(SettingsAccountFormatting.displayError(error))
        }
    }
}

@MainActor
private struct SettingsNewSupportConversationView: View {
    let userID: String
    let companyID: String
    let service: any SettingsSupportServicing
    let onCreated: () -> Void

    @Environment(\.dismiss) private var dismiss
    @FocusState private var isFocused: Bool
    @State private var message = ""
    @State private var isSending = false
    @State private var errorMessage: String?

    private var trimmedMessage: String {
        message.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextEditor(text: $message)
                        .frame(minHeight: 150)
                        .focused($isFocused)
                        .accessibilityLabel("Support message")
                } header: {
                    Text("How can we help?")
                } footer: {
                    Text("Text messages are supported in this release. Attachments aren't available yet.")
                }
                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("New Conversation")
            .navigationBarTitleDisplayMode(.inline)
            .scrollDismissesKeyboard(.interactively)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send") { Task { await send() } }
                        .disabled(trimmedMessage.isEmpty || isSending)
                }
            }
            .onAppear { isFocused = true }
        }
    }

    private func send() async {
        guard !trimmedMessage.isEmpty else { return }
        isSending = true
        errorMessage = nil
        defer { isSending = false }
        do {
            _ = try await service.startConversation(
                userID: userID,
                companyID: companyID,
                message: trimmedMessage
            )
            onCreated()
            dismiss()
        } catch is CancellationError {
            return
        } catch {
            errorMessage = SettingsAccountFormatting.displayError(error)
        }
    }
}

@MainActor
private struct SettingsSupportConversationView: View {
    let conversation: SettingsSupportConversation
    let userID: String
    let service: any SettingsSupportServicing

    @FocusState private var isInputFocused: Bool
    @State private var messages: [SettingsSupportMessage]
    @State private var draft = ""
    @State private var isSending = false
    @State private var streamError: String?
    @State private var sendError: String?

    init(
        conversation: SettingsSupportConversation,
        userID: String,
        service: any SettingsSupportServicing
    ) {
        self.conversation = conversation
        self.userID = userID
        self.service = service
        _messages = State(initialValue: conversation.recentMessages ?? [])
    }

    private var trimmedDraft: String {
        draft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 12) {
                    if messages.isEmpty, streamError == nil {
                        ContentUnavailableView(
                            "No Messages Yet",
                            systemImage: "bubble.left",
                            description: Text("Send a message to continue this conversation.")
                        )
                        .padding(.top, 60)
                    }
                    ForEach(messages) { message in
                        messageBubble(message)
                            .id(message.id)
                    }
                    if let streamError {
                        Label(streamError, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
                .padding()
            }
            .safeAreaInset(edge: .bottom) { composer }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: messages.count) {
                guard let lastID = messages.last?.id else { return }
                withAnimation { proxy.scrollTo(lastID, anchor: .bottom) }
            }
        }
        .navigationTitle(conversation.subject ?? conversation.title)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: conversation.id) { await observeMessages() }
    }

    private func messageBubble(_ message: SettingsSupportMessage) -> some View {
        let isOwnMessage = message.ownerId == userID
        return HStack {
            if isOwnMessage { Spacer(minLength: 42) }
            VStack(alignment: isOwnMessage ? .trailing : .leading, spacing: 4) {
                Text(message.content)
                    .textSelection(.enabled)
                    .padding(.horizontal, 13)
                    .padding(.vertical, 9)
                    .foregroundStyle(isOwnMessage ? Color.white : Color.primary)
                    .background(
                        isOwnMessage ? Color.accentColor : Color.secondary.opacity(0.15),
                        in: RoundedRectangle(cornerRadius: 16, style: .continuous)
                    )
                Text(SettingsAccountFormatting.date(from: message.sentAt ?? message.createdAt) ?? .now, style: .time)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            if !isOwnMessage { Spacer(minLength: 42) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(isOwnMessage ? "You" : "Support"): \(message.content)")
    }

    private var composer: some View {
        VStack(spacing: 5) {
            if let sendError {
                Text(sendError)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(alignment: .bottom, spacing: 10) {
                TextField("Message", text: $draft, axis: .vertical)
                    .lineLimit(1...5)
                    .textFieldStyle(.roundedBorder)
                    .focused($isInputFocused)
                    .submitLabel(.send)
                    .onSubmit { Task { await send() } }
                Button { Task { await send() } } label: {
                    if isSending {
                        ProgressView().frame(width: 44, height: 44)
                    } else {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.title)
                            .frame(width: 44, height: 44)
                    }
                }
                .disabled(trimmedDraft.isEmpty || isSending)
                .accessibilityLabel("Send message")
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.bar)
    }

    private func observeMessages() async {
        do {
            try await service.observeMessages(
                conversationID: conversation.id,
                now: .now
            ) { value in
                messages = value
                streamError = nil
            }
        } catch is CancellationError {
            return
        } catch {
            streamError = SettingsAccountFormatting.displayError(error)
        }
    }

    private func send() async {
        let content = trimmedDraft
        guard !content.isEmpty else { return }
        isSending = true
        defer { isSending = false }
        sendError = nil
        do {
            _ = try await service.sendMessage(
                conversationID: conversation.id,
                userID: userID,
                content: content
            )
            draft = ""
        } catch is CancellationError {
            return
        } catch {
            sendError = "Not delivered. \(SettingsAccountFormatting.displayError(error))"
        }
    }
}

@MainActor
private struct SettingsSupportTicketsView: View {
    let catalog: MobileSettingsCatalog
    let service: any SettingsSupportServicing
    let locale: Locale

    @State private var state: SettingsAccountLoadState<[SettingsSupportTicket]> = .loading
    @State private var reloadID = UUID()

    var body: some View {
        Group {
            switch state {
            case .loading:
                List { SettingsAccountLoadingRows(count: 4) }
            case let .failed(message):
                SettingsAccountErrorView(message: message) { reloadID = UUID() }
            case let .loaded(tickets):
                List {
                    if tickets.isEmpty {
                        ContentUnavailableView(
                            "No Support Tickets",
                            systemImage: "ticket",
                            description: Text("Tickets created from your support conversations appear here.")
                        )
                    } else {
                        ForEach(tickets) { ticket in
                            NavigationLink {
                                ticketDetail(ticket)
                            } label: {
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(ticket.title).font(.body.weight(.medium))
                                    Text(ticket.description)
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(2)
                                    HStack {
                                        SettingsStatusLabel(status: ticket.status)
                                        Spacer()
                                        Text(
                                            SettingsAccountFormatting.dateText(
                                                ticket.updatedAt,
                                                locale: locale
                                            ) ?? ""
                                        )
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                    }
                }
                .refreshable { await load() }
            }
        }
        .task(id: reloadID) { await load() }
    }

    private func ticketDetail(_ ticket: SettingsSupportTicket) -> some View {
        Form {
            Section("Ticket") {
                LabeledContent("Status") { SettingsStatusLabel(status: ticket.status) }
                LabeledContent("Type", value: ticket.ticketType.capitalized)
                if let priority = ticket.priority {
                    LabeledContent("Priority", value: priority.capitalized)
                }
                LabeledContent("Updated") {
                    Text(SettingsAccountFormatting.dateText(ticket.updatedAt, locale: locale) ?? "—")
                }
            }
            Section("Description") {
                Text(ticket.description).textSelection(.enabled)
            }
        }
        .navigationTitle(ticket.title)
        .navigationBarTitleDisplayMode(.inline)
    }

    private func load() async {
        if case .loaded = state {} else { state = .loading }
        do {
            state = try await .loaded(
                service.loadTickets(
                    userID: catalog.identity.userId,
                    companyID: catalog.workspace.companyId,
                    limit: 20
                )
            )
        } catch is CancellationError {
            return
        } catch {
            state = .failed(SettingsAccountFormatting.displayError(error))
        }
    }
}

@MainActor
struct SettingsNewsListView: View {
    let service: any SettingsSupportServicing
    let locale: Locale

    @State private var state: SettingsAccountLoadState<[SettingsNewsPost]> = .loading
    @State private var reloadID = UUID()

    var body: some View {
        Group {
            switch state {
            case .loading:
                List { SettingsAccountLoadingRows(count: 5) }
            case let .failed(message):
                SettingsAccountErrorView(message: message) { reloadID = UUID() }
            case let .loaded(posts):
                List {
                    if posts.isEmpty {
                        ContentUnavailableView(
                            "No News Yet",
                            systemImage: "newspaper",
                            description: Text("Check back later for the latest from Pathway.")
                        )
                    } else {
                        ForEach(posts) { post in
                            NavigationLink {
                                SettingsNewsDetailView(post: post, locale: locale)
                            } label: {
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(post.title).font(.body.weight(.medium)).lineLimit(2)
                                    if let summary = post.summary, !summary.isEmpty {
                                        Text(summary)
                                            .font(.subheadline)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(2)
                                    }
                                    Text(
                                        SettingsAccountFormatting.dateText(
                                            post.publishedAt,
                                            locale: locale
                                        ) ?? ""
                                    )
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
                .refreshable { await load() }
            }
        }
        .task(id: reloadID) { await load() }
    }

    private func load() async {
        if case .loaded = state {} else { state = .loading }
        do {
            state = try await .loaded(service.loadNews(now: .now, category: nil, limit: 20))
        } catch is CancellationError {
            return
        } catch {
            state = .failed(SettingsAccountFormatting.displayError(error))
        }
    }
}

private struct SettingsNewsDetailView: View {
    let post: SettingsNewsPost
    let locale: Locale

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text(post.title)
                    .font(.title.bold())
                HStack {
                    Text(post.category.capitalized)
                    Spacer()
                    Text(SettingsAccountFormatting.dateText(post.publishedAt, locale: locale) ?? "")
                }
                .font(.subheadline)
                .foregroundStyle(.secondary)
                if let summary = post.summary, !summary.isEmpty {
                    Text(summary).font(.headline)
                }
                Text(SettingsAccountFormatting.plainText(fromHTML: post.contentHtml))
                    .textSelection(.enabled)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
        }
        .navigationTitle("What's New")
        .navigationBarTitleDisplayMode(.inline)
    }
}
