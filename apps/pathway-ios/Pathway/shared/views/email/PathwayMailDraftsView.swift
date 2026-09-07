import SwiftUI

struct PathwayMailDraftsView: View {
  @Environment(\.dismiss) private var dismiss
  @Bindable var model: PathwayConnectedMailModel
  let companyID: String
  let initialAccountID: String
  @State private var accountID = ""
  @State private var drafts: [PathwayMailDraft] = []
  @State private var error: String?
  @State private var compose = false
  private var account: PathwayMailAccount? { model.accounts.first { $0.id == accountID } }
  var body: some View {
    List {
      Picker("Account", selection: $accountID) {
        ForEach(model.accounts) { Text($0.email).tag($0.id) }
      }
      if let account {
        Button("Compose") { compose = true }.disabled(account.status != "active")
        ForEach(drafts) { draft in
          NavigationLink {
            PathwayMailDraftEditor(
              model: model, companyID: companyID, account: account, draft: draft)
          } label: {
            VStack(alignment: .leading) {
              Text(draft.subject.isEmpty ? "No subject" : draft.subject)
              Text("\(draft.status) · \(draft.to.joined(separator: ", "))").font(.caption)
                .foregroundStyle(.secondary)
            }
          }
        }
        if drafts.isEmpty { Text("No drafts.").foregroundStyle(.secondary) }
      }
      if let error { Text(error).foregroundStyle(.red) }
    }
    .navigationTitle("Drafts")
    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    .onChange(of: model.accounts, initial: true) {
      if !model.accounts.contains(where: { $0.id == accountID }) {
        accountID =
          model.accounts.first(where: { $0.id == initialAccountID })?.id ?? model.accounts.first?.id
          ?? ""
      }
    }
    .task(id: accountID) {
      drafts = []
      error = nil
      guard !accountID.isEmpty else { return }
      do {
        try await model.observe(
          [PathwayMailDraft].self, name: "mail:listDrafts", companyID: companyID,
          fields: ["accountId": .string(accountID)]
        ) { drafts = $0 }
      } catch {
        if !Task.isCancelled {
          drafts = []
          self.error = error.localizedDescription
        }
      }
    }
    .sheet(isPresented: $compose) {
      if let account {
        NavigationStack {
          PathwayMailDraftEditor(model: model, companyID: companyID, account: account)
        }
      }
    }
  }
}

struct PathwayMailDraftEditor: View {
  @Environment(\.dismiss) private var dismiss
  @Bindable var model: PathwayConnectedMailModel
  let companyID: String
  let account: PathwayMailAccount
  var draft: PathwayMailDraft?
  var replyTo: PathwayMailMessage?
  @State private var to = ""
  @State private var subject = ""
  @State private var text = ""
  @State private var draftID: String?
  @State private var busy = false
  @State private var error: String?
  @State private var saved = false
  @State private var initialized = false
  private var locked: Bool { draft.map { !["draft", "failed"].contains($0.status) } ?? false }
  var body: some View {
    Form {
      LabeledContent("From", value: account.email)
      TextField("To, separated by commas", text: $to).keyboardType(.emailAddress)
        .textInputAutocapitalization(.never)
      TextField("Subject", text: $subject)
      TextEditor(text: $text).frame(minHeight: 220).accessibilityLabel("Message")
      if let error = error ?? draft?.lastError { Text(error).foregroundStyle(.red) }
      if saved { Text("Draft saved.").foregroundStyle(.secondary) }
      if draft?.status == "unknown" {
        Text("Delivery could not be confirmed. Check Gmail Sent before sending again.")
          .foregroundStyle(.secondary)
      } else {
        Text(
          locked
            ? "Delivery status: \(draft?.status ?? "")" : "Mail is sent only when you press Send."
        ).foregroundStyle(.secondary)
      }
      Button("Save draft") { save(send: false) }.disabled(locked || busy)
      Button("Send") { save(send: true) }.disabled(
        locked || busy || to.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
          || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
          || account.status != "active")
    }
    .disabled(busy || locked)
    .navigationTitle(replyTo == nil ? "Draft" : "Reply")
    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
    .onAppear {
      guard !initialized else { return }
      initialized = true
      draftID = draft?.id
      to = draft?.to.joined(separator: ", ") ?? replyTo?.from.email ?? ""
      subject =
        draft?.subject ?? replyTo.map {
          $0.subject.lowercased().hasPrefix("re:") ? $0.subject : "Re: \($0.subject)"
        } ?? ""
      text = draft?.text ?? ""
    }
  }
  private func save(send: Bool) {
    Task {
      busy = true
      error = nil
      saved = false
      defer { busy = false }
      do {
        var fields: [String: JSONValue] = [
          "accountId": .string(account.id),
          "to": .array(
            to.split(separator: ",").map {
              .string($0.trimmingCharacters(in: .whitespacesAndNewlines))
            }), "subject": .string(subject), "text": .string(text),
        ]
        if let draftID { fields["draftId"] = .string(draftID) }
        if let reply = replyTo?.id ?? draft?.replyToMessageId {
          fields["replyToMessageId"] = .string(reply)
        }
        let result = try await model.mutate("mail:saveDraft", companyID: companyID, fields: fields)
        guard let id = result.stringValue else { throw URLError(.badServerResponse) }
        draftID = id
        if send {
          _ = try await model.mutate(
            "mail:requestSend", companyID: companyID, fields: ["draftId": .string(id)])
          _ = try? await model.relay(
            "wake", companyID: companyID, fields: ["accountId": .string(account.id)])
          dismiss()
        } else {
          saved = true
        }
      } catch { self.error = error.localizedDescription }
    }
  }
}
