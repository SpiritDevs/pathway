import SwiftUI

struct PathwayEmailHubView: View {
  @Bindable var capture: PathwayEmailModel
  @Bindable var mail: PathwayConnectedMailModel
  let companies: [PathwayCompany]
  let environments: [PathwayCompanyEnvironment]
  var initialFilter = "inbox"
  @State private var source = "mail"
  var body: some View {
    VStack(spacing: 0) {
      Picker("Email source", selection: $source) {
        Text("Mail").tag("mail")
        Text("SMTP capture").tag("capture")
      }
      .pickerStyle(.segmented).padding(.horizontal)
      if source == "capture" {
        PathwayEmailView(
          model: capture, companies: companies, environments: environments,
          initialFilter: initialFilter)
      } else {
        PathwayConnectedMailView(model: mail, companies: companies, environments: environments)
      }
    }
    .onChange(of: initialFilter, initial: true) {
      if initialFilter == "unread" { source = "capture" }
    }
  }
}

struct PathwayConnectedMailView: View {
  @Bindable var model: PathwayConnectedMailModel
  let companies: [PathwayCompany]
  let environments: [PathwayCompanyEnvironment]
  @State private var companyID = ""
  @State private var accountID = ""
  @State private var bucket = "priority"
  @State private var settings = false
  @State private var drafts = false
  private var listScope: String { "\(companyID):\(accountID):\(bucket):\(model.companyID)" }
  var body: some View {
    List {
      Section {
        Picker("Workspace", selection: $companyID) {
          ForEach(companies) { Text($0.name).tag($0.id) }
        }
        Picker("Account", selection: $accountID) {
          Text("All accounts").tag("")
          ForEach(model.accounts) { Text($0.email).tag($0.id) }
        }
        Picker("Inbox", selection: $bucket) {
          Text("Priority").tag("priority")
          Text("Noise").tag("noise")
          Text("All mail").tag("all")
        }.pickerStyle(.segmented)
      }
      if model.accounts.isEmpty && !model.loading {
        ContentUnavailableView(
          "Connect Gmail", systemImage: "envelope",
          description: Text(
            "Connect Gmail in Email settings on web or desktop. Your mailbox is private to you and syncs while your environments are offline."
          ))
      }
      Section("Messages") {
        if model.loading { ProgressView("Loading mail…") }
        ForEach(model.messages) { message in
          NavigationLink {
            PathwayConnectedMailDetail(model: model, companyID: companyID, messageID: message.id)
          } label: {
            VStack(alignment: .leading, spacing: 4) {
              Text(message.from.name ?? message.from.email).fontWeight(
                message.read ? .regular : .semibold)
              Text(message.subject.isEmpty ? "No subject" : message.subject).font(.subheadline)
              Text(message.snippet).font(.caption).foregroundStyle(.secondary).lineLimit(2)
              Text("\(message.bucket.capitalized) · \(message.reason)").font(.caption2)
                .foregroundStyle(.secondary).lineLimit(2)
            }
          }
        }
        if model.hasMore {
          Button("Load more") {
            Task {
              do { try await model.loadMore() } catch {
                model.errorMessage = error.localizedDescription
              }
            }
          }.disabled(model.loadingMore)
        }
        if !model.loading && model.messages.isEmpty && !model.accounts.isEmpty {
          Text("No messages in this view.").foregroundStyle(.secondary)
        }
      }
      if let error = model.errorMessage { Text(error).foregroundStyle(.red) }
    }
    .navigationTitle("Email")
    .toolbar {
      ToolbarItemGroup(placement: .topBarTrailing) {
        Button("Drafts", systemImage: "square.and.pencil") { drafts = true }.disabled(
          model.accounts.isEmpty)
        Button("Email settings", systemImage: "gearshape") { settings = true }
      }
    }
    .onChange(of: companies, initial: true) {
      if !companies.contains(where: { $0.id == companyID }) {
        companyID = companies.first?.id ?? ""
      }
    }
    .onChange(of: companyID) { accountID = "" }
    .task(id: companyID) { await model.observeAccounts(companyID: companyID) }
    .task(id: listScope) {
      guard model.companyID == companyID else { return }
      await model.observeMessages(companyID: companyID, accountID: accountID, bucket: bucket)
    }
    .sheet(isPresented: $settings) {
      NavigationStack {
        PathwayConnectedMailSettings(
          model: model, companyID: companyID,
          environments: environments.filter { $0.companyId == companyID })
      }.id(companyID)
    }
    .sheet(isPresented: $drafts) {
      NavigationStack {
        PathwayMailDraftsView(model: model, companyID: companyID, initialAccountID: accountID)
      }.id(companyID)
    }
  }
}

private struct PathwayConnectedMailDetail: View {
  @Environment(PathwayAppModel.self) private var appModel
  @Environment(\.openURL) private var openURL
  @Bindable var model: PathwayConnectedMailModel
  let companyID: String
  let messageID: String
  @State private var message: PathwayMailMessage?
  @State private var sender: PathwayMailSender?
  @State private var error: String?
  @State private var busy = false
  @State private var allowRemote = false
  @State private var reply = false
  @State private var notice: String?
  @State private var loadedBody: [String: JSONValue]?
  @State private var conversation: [PathwayMailMessage] = []
  @State private var threadCursor: String?
  @State private var saveContact = false
  @State private var contactSaved = false
  @State private var contactID = UUID().uuidString.lowercased()
  @State private var contactRequestID = UUID().uuidString.lowercased()
  private var canManageContacts: Bool {
    PathwayContactsModel.canManage(
      companyID: companyID, companies: appModel.cloud.companies,
      entities: appModel.cloud.issues.entities)
  }
  private var account: PathwayMailAccount? { model.accounts.first { $0.id == message?.accountId } }
  var body: some View {
    List {
      if let message, account != nil, model.companyID == companyID {
        Section {
          Text(message.subject.isEmpty ? "No subject" : message.subject).font(.title2)
            .textSelection(.enabled)
          LabeledContent(
            "From",
            value: message.from.name.map { "\($0) <\(message.from.email)>" } ?? message.from.email)
          LabeledContent("To", value: message.to.joined(separator: ", "))
          Text(Date(timeIntervalSince1970: message.receivedAt / 1000), format: .dateTime).font(
            .caption
          ).foregroundStyle(.secondary)
        }
        Section(message.bucket.capitalized) {
          Text(message.reason)
          if let briefing = message.briefing {
            Text(briefing).textSelection(.enabled)
          } else if message.analysisStatus == "pending" {
            Text(
              "Analysis is queued. Your primary or backup environment will pick it up when available."
            ).foregroundStyle(.secondary)
          }
          Button(message.bucket == "noise" ? "Move to Priority" : "Move to Noise") {
            run {
              _ = try await model.mutate(
                "mail:setBucket", companyID: companyID,
                fields: [
                  "messageId": .string(messageID),
                  "bucket": .string(message.bucket == "noise" ? "priority" : "noise"),
                ])
            }
          }
          if message.analysisStatus == "failed" {
            Button("Retry analysis") {
              run {
                _ = try await model.mutate(
                  "mail:retryAnalysis", companyID: companyID,
                  fields: ["messageId": .string(messageID)])
              }
            }.disabled(account?.brain == nil)
          }
        }
        if conversation.count > 1 {
          Section("Conversation") {
            ForEach(conversation) { item in
              NavigationLink {
                PathwayConnectedMailDetail(model: model, companyID: companyID, messageID: item.id)
              } label: {
                Text(
                  "\(item.from.name ?? item.from.email) · \(Date(timeIntervalSince1970: item.receivedAt / 1000).formatted(date: .abbreviated, time: .shortened))"
                )
              }
            }
            if threadCursor != nil {
              Button("More messages") { loadConversation(message, more: true) }
            }
          }
        }
        Section("Message") {
          if message.bodyTruncated == true
            || message.attachments.contains(where: { $0.blobKey == nil })
          {
            Text("This preview or its attachments are incomplete.").foregroundStyle(.secondary)
            if let id = message.providerMessageId,
              let url = account?.gmailMessageURL(providerMessageID: id)
            {
              Link("View the full message in Gmail", destination: url)
            }
          }
          if let blobKey = message.bodyBlobKey, loadedBody == nil {
            Button("Load message body") {
              run {
                let url = try await model.downloadURL(
                  companyID: companyID, messageID: messageID, blobKey: blobKey)
                var request = URLRequest(url: url)
                request.httpShouldHandleCookies = false
                let (data, response) = try await URLSession.shared.data(for: request)
                guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                  throw URLError(.badServerResponse)
                }
                guard model.companyID == companyID,
                  model.accounts.contains(where: { $0.id == message.accountId })
                else { return }
                loadedBody = try JSONDecoder().decode(JSONValue.self, from: data).objectValue
              }
            }
          } else if let html = loadedBody?["htmlBody"]?.stringValue ?? message.htmlBody {
            Toggle("Load remote images and styles", isOn: $allowRemote)
            #if canImport(WebKit) && canImport(UIKit)
              PathwayEmailHTMLView(html: html, allowRemote: allowRemote).frame(minHeight: 420)
            #else
              Text(
                loadedBody?["textBody"]?.stringValue ?? message.textBody
                  ?? "Open this HTML message in Gmail.")
            #endif
          } else {
            Text(
              loadedBody?["textBody"]?.stringValue ?? message.textBody
                ?? "This message has no text body."
            ).textSelection(.enabled)
          }
        }
        if !message.attachments.isEmpty {
          Section("Attachments") {
            ForEach(message.attachments) { attachment in
              Button("\(attachment.filename) · \(attachment.size / 1024) KB") {
                run {
                  if let blobKey = attachment.blobKey {
                    let url = try await model.downloadURL(
                      companyID: companyID, messageID: messageID, blobKey: blobKey)
                    openURL(url)
                  }
                }
              }.disabled(attachment.blobKey == nil)
            }
          }
        }
        Section {
          Button(message.read ? "Mark unread" : "Mark read") {
            run {
              _ = try await model.mutate(
                "mail:setRead", companyID: companyID,
                fields: ["messageId": .string(messageID), "read": .bool(!message.read)])
              _ = try? await model.relay(
                "wake", companyID: companyID, fields: ["accountId": .string(message.accountId)])
            }
          }
          Button("Reply") { reply = true }.disabled(account?.status != "active")
          Button("Draft reply with AI") {
            run {
              _ = try await model.mutate(
                "mail:requestDraft", companyID: companyID, fields: ["messageId": .string(messageID)]
              )
              notice = "Your reply is queued. Review it in Drafts before sending."
            }
          }.disabled(account?.brain == nil || account?.status != "active")
        }
        if canManageContacts {
          Button(contactSaved ? "Contact saved" : "Save contact") { saveContact = true }.disabled(
            contactSaved)
        }
        if let sender, !sender.summary.isEmpty {
          Section("Private sender knowledge") {
            Text(sender.summary)
            Text("\(sender.messageCount) messages").font(.caption).foregroundStyle(.secondary)
          }
        }
        if let notice { Text(notice).font(.caption) }
      } else if error == nil {
        ProgressView("Loading message…")
      }
      if let error { Text(error).foregroundStyle(.red) }
    }
    .disabled(busy)
    .navigationTitle("Message")
    .onChange(of: model.companyID) { if model.companyID != companyID { clearPrivateContent() } }
    .onChange(of: model.accounts) {
      if let message, !model.accounts.contains(where: { $0.id == message.accountId }) {
        clearPrivateContent()
      }
    }
    .task(id: messageID) {
      do {
        try await model.observe(
          PathwayMailMessage.self, name: "mail:getMessage", companyID: companyID,
          fields: ["messageId": .string(messageID)]
        ) { message = $0 }
      } catch {
        if !Task.isCancelled {
          message = nil
          self.error = error.localizedDescription
        }
      }
    }
    .task(id: message?.id) {
      guard let message else { return }
      loadConversation(message, more: false)
      do {
        if !message.read {
          _ = try await model.mutate(
            "mail:setRead", companyID: companyID,
            fields: ["messageId": .string(messageID), "read": .bool(true)])
          _ = try? await model.relay(
            "wake", companyID: companyID, fields: ["accountId": .string(message.accountId)])
        }
        try await model.observe(
          PathwayMailSender?.self, name: "mail:getSender", companyID: companyID,
          fields: ["accountId": .string(message.accountId), "email": .string(message.from.email)]
        ) { sender = $0 }
      } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
    .confirmationDialog(
      "Save a shared contact?", isPresented: $saveContact, titleVisibility: .visible
    ) {
      Button("Save name and email") {
        guard let message, canManageContacts else { return }
        run {
          _ = try await model.mutate(
            "contacts:upsert", companyID: companyID,
            fields: [
              "id": .string(contactID), "requestId": .string(contactRequestID),
              "expectedRevision": .null, "name": .string(message.from.name ?? message.from.email),
              "email": .string(message.from.email), "role": .string(""), "company": .string(""),
              "phone": .string(""), "notes": .string(""), "favorite": .bool(false),
            ])
          contactSaved = true
        }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(
        "Workspace members can read this name and email. Private sender knowledge is not copied.")
    }
    .sheet(isPresented: $reply) {
      if let message, let account {
        NavigationStack {
          PathwayMailDraftEditor(
            model: model, companyID: companyID, account: account, replyTo: message)
        }
      }
    }
  }
  private func run(_ operation: @escaping @MainActor () async throws -> Void) {
    Task {
      busy = true
      error = nil
      defer { busy = false }
      do { try await operation() } catch { self.error = error.localizedDescription }
    }
  }
  private func clearPrivateContent() {
    message = nil
    sender = nil
    loadedBody = nil
    conversation = []
    threadCursor = nil
    reply = false
    saveContact = false
  }
  private func loadConversation(_ message: PathwayMailMessage, more: Bool) {
    run {
      var fields: [String: JSONValue] = [
        "accountId": .string(message.accountId),
        "providerThreadId": .string(message.providerThreadId), "limit": .number(25),
      ]
      if more, let threadCursor { fields["cursor"] = .string(threadCursor) }
      let value = try await model.query("mail:getThread", companyID: companyID, fields: fields)
      let page = try decodePathwayPayload(PathwayMailPage.self, from: value)
      guard model.companyID == companyID,
        model.accounts.contains(where: { $0.id == message.accountId })
      else { return }
      conversation = more ? conversation + page.messages : page.messages
      threadCursor = page.nextCursor
    }
  }
}
