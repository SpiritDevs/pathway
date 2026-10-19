import SwiftUI

struct PathwayOrchestratorParticipants: View {
    let chat: PathwayOrchestratorRecord
    @Environment(PathwayAppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @State private var selected = ""
    @State private var wholeHistory = true
    @State private var members: [JSONValue] = []
    @State private var error: String?
    @State private var saving = false
    private var model: PathwayOrchestratorsModel { appModel.cloud.orchestrators }
    private var current: PathwayOrchestratorRecord { model.chats.first { $0.id == chat.id } ?? chat }
    private var owner: Bool { current.string("ownerSubject") == appModel.accountID }
    private var availableMembers: [PathwayOrchestratorRecord] { members.compactMap { value in
        guard let fields = value.objectValue, let subject = fields["subject"]?.stringValue, !current.strings("participantSubjects").contains(subject) else { return nil }
        return .init(id: subject, fields: fields)
    } }
    var body: some View {
        NavigationStack {
            Form {
                if let error { Text(error).foregroundStyle(.red) }
                Section("Participants") {
                    ForEach(current.strings("participantSubjects"), id: \.self) { subject in
                        HStack {
                            Text(subject == appModel.accountID ? "You" : memberName(subject))
                            Spacer()
                            if owner && subject != current.string("ownerSubject") { Button("Remove", role: .destructive) { perform("removeParticipant", ["subject": .string(subject)]) } }
                        }
                    }
                    ForEach(model.contacts.filter { current.strings("orchestratorIds").contains($0.id) }) { contact in
                        HStack {
                            PathwayOrchestratorAvatar(name: contact.string("name"), color: contact.string("color"))
                            Text(contact.string("name")); Spacer()
                            if contact.id == current.string("leadId") { Text("Lead").font(.caption).foregroundStyle(.secondary) }
                            else if owner { Button("Remove", role: .destructive) { perform("removeParticipant", ["orchestratorId": .string(contact.id)]) } }
                        }
                    }
                }
                if owner {
                    Section("Conversation lead") {
                        Picker("Lead", selection: Binding(get: { current.string("leadId") }, set: { perform("updateChat", ["leadId": .string($0)]) })) {
                            ForEach(model.contacts.filter { current.strings("orchestratorIds").contains($0.id) && $0.flag("canDirect") }) { Text($0.string("name")).tag($0.id) }
                        }
                    }
                    Section("Add participant") {
                        Picker("Person or orchestrator", selection: $selected) {
                            Text("Choose participant").tag("")
                            ForEach(model.contacts.filter { !current.strings("orchestratorIds").contains($0.id) && $0.flag("canDirect") && $0.string("status") != "archived" }) { Text($0.string("name")).tag("orchestrator:\($0.id)") }
                            ForEach(availableMembers) { member in
                                Text(member.string("name")).tag("person:\(member.id)")
                            }
                        }
                        Toggle("Share the whole conversation", isOn: $wholeHistory)
                        Text(wholeHistory ? "This participant can see this conversation's history." : "This participant sees only messages and assignments from joining.").font(.footnote).foregroundStyle(.secondary)
                        Button("Add participant") {
                            let parts = selected.split(separator: ":", maxSplits: 1)
                            guard parts.count == 2 else { return }
                            perform("invite", [parts[0] == "orchestrator" ? "orchestratorId" : "subject": .string(String(parts[1])), "history": .string(wholeHistory ? "all" : "from-now")]); selected = ""
                        }.disabled(selected.isEmpty)
                    }
                    Button(current.flag("archived") ? "Unarchive conversation" : "Archive conversation") { perform("updateChat", ["archived": .bool(!current.flag("archived"))]) }
                } else {
                    Button("Leave conversation", role: .destructive) { perform("removeParticipant", ["subject": .string(appModel.accountID ?? "")], close: true) }
                }
                Text("Other conversations and private memories stay private. Project work remains under its project's coordinator.").font(.footnote).foregroundStyle(.secondary)
            }
            .disabled(saving)
            .navigationTitle("Conversation details")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task(id: current.strings("companyIds").first) {
                guard let companyID = current.strings("companyIds").first else { return }
                do { members = try await model.query("configurationChoices", ["companyId": .string(companyID)]).objectValue?["members"]?.arrayValue ?? [] } catch { self.error = error.localizedDescription }
            }
        }
    }
    private func memberName(_ subject: String) -> String { members.first { $0.objectValue?["subject"]?.stringValue == subject }?.objectValue?["name"]?.stringValue ?? "Workspace member" }
    private func perform(_ name: String, _ values: [String: JSONValue], close: Bool = false) {
        saving = true
        Task { defer { saving = false }; do { try await model.mutate(name, values.merging(["chatId": .string(chat.id)]) { _, next in next }); if close { dismiss() } } catch { self.error = error.localizedDescription } }
    }
}
