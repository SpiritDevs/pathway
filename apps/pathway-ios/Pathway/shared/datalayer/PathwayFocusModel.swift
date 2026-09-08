import Foundation
import Observation

struct PathwayFocus: Codable, Identifiable, Equatable {
    let id: String
    let name: String
    let iconName: String
    let accentColor: String
    let orderKey: String
    var includeConversations: Bool? = nil
}

struct PathwayFocusAssignment: Decodable {
    let focusId: String
    let projectKey: String
}

struct PathwayFocusNotification: Decodable, Identifiable {
    let id: String
    let environmentId: String
    let threadId: String
    let projectKey: String
    let eventKind: String
    let createdAt: Double
    var title: String {
        switch eventKind {
        case "pending-approval": "Approval needed"
        case "awaiting-input": "Answer needed"
        case "failed": "Agent failed"
        default: "Agent finished"
        }
    }

    func focusID(focuses: [PathwayFocus], assignments: [PathwayFocusAssignment], selectedID: String) -> String {
        if projectKey == "\(environmentId):conversations" {
            return focuses.contains { $0.id == selectedID && $0.includeConversations == true } ? selectedID : "all"
        }
        return assignments.first { $0.projectKey == projectKey }?.focusId ?? "all"
    }
}

@MainActor @Observable final class PathwayFocusModel {
    private(set) var focuses: [PathwayFocus] = []
    private(set) var assignments: [PathwayFocusAssignment] = []
    private(set) var notifications: [PathwayFocusNotification] = []
    private(set) var unreadCount = 0
    var selectedID = "all" { didSet { if let preferenceKey { UserDefaults.standard.set(selectedID, forKey: preferenceKey) } } }
    var errorMessage: String?
    @ObservationIgnored private var preferenceKey: String?
    @ObservationIgnored private var observationGeneration = 0

    func includes(_ thread: PathwayAgentThread) -> Bool {
        if selectedID == "all" { return true }
        guard let projectID = thread.shell.projectId else {
            return focuses.first { $0.id == selectedID }?.includeConversations == true
        }
        return assignments.contains { $0.focusId == selectedID && $0.projectKey == "\(thread.environmentId):\(projectID)" }
    }

    func notificationFocusID(_ notification: PathwayFocusNotification) -> String {
        notification.focusID(focuses: focuses, assignments: assignments, selectedID: selectedID)
    }

    func notificationFocusName(_ notification: PathwayFocusNotification) -> String {
        let id = notificationFocusID(notification)
        return focuses.first { $0.id == id }?.name ?? "All"
    }

    func move(_ focus: PathwayFocus, offset: Int, cloud: PathwayCloudModel) async {
        guard let index = focuses.firstIndex(where: { $0.id == focus.id }), focuses.indices.contains(index + offset) else { return }
        var ordered = focuses
        ordered.swapAt(index, index + offset)
        let position = index + offset
        guard let key = PathwayThreadOrder.between(position > 0 ? ordered[position - 1].orderKey : nil,
                                                   position + 1 < ordered.count ? ordered[position + 1].orderKey : nil) else { return }
        do {
            _ = try await cloud.request(kind: "mutation", name: "focuses:reorder", arguments: .object(["focusId": .string(focus.id), "orderKey": .string(key)]))
            errorMessage = nil
        } catch { errorMessage = error.localizedDescription }
    }

    func observe(cloud: PathwayCloudModel, storageDirectory: URL?) async {
        observationGeneration += 1
        let generation = observationGeneration
        focuses = []; assignments = []; notifications = []; unreadCount = 0; errorMessage = nil
        preferenceKey = storageDirectory.map { "pathway.focus.\($0.lastPathComponent)" }
        selectedID = preferenceKey.flatMap { UserDefaults.standard.string(forKey: $0) } ?? "all"
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await self.observeFocuses(cloud: cloud, generation: generation) }
            group.addTask { await self.observeNotifications(cloud: cloud, generation: generation) }
            group.addTask { await self.observeUnread(cloud: cloud, generation: generation) }
        }
    }

    private func observeFocuses(cloud: PathwayCloudModel, generation: Int) async {
        struct Snapshot: Decodable { let focuses: [PathwayFocus]; let assignments: [PathwayFocusAssignment] }
        do {
            for try await value in cloud.subscribe(name: "focuses:list") {
                guard !Task.isCancelled, generation == observationGeneration else { return }
                let snapshot = try decodePathwayPayload(Snapshot.self, from: value)
                focuses = snapshot.focuses.sorted { $0.orderKey == $1.orderKey ? $0.id < $1.id : $0.orderKey < $1.orderKey }
                assignments = snapshot.assignments
            }
        } catch is CancellationError {} catch { if generation == observationGeneration { errorMessage = error.localizedDescription } }
    }

    private func observeNotifications(cloud: PathwayCloudModel, generation: Int) async {
        do {
            for try await value in cloud.subscribe(name: "focusNotifications:list", arguments: .object(["limit": .number(100)])) {
                guard !Task.isCancelled, generation == observationGeneration else { return }
                notifications = try decodePathwayPayload([PathwayFocusNotification].self, from: value)
            }
        } catch is CancellationError {} catch { if generation == observationGeneration { errorMessage = error.localizedDescription } }
    }

    private func observeUnread(cloud: PathwayCloudModel, generation: Int) async {
        do {
            for try await value in cloud.subscribe(name: "focusNotifications:unreadCount") {
                guard !Task.isCancelled, generation == observationGeneration else { return }
                unreadCount = value.intValue ?? 0
            }
        } catch is CancellationError {} catch { if generation == observationGeneration { errorMessage = error.localizedDescription } }
    }
}
