import SwiftUI

@MainActor
struct PathwayNewThreadDraft {
    let prompt: String
    let runtimeMode: String
    let interactionMode: String
    let workspaceMode: String
    let baseReference: String
    let branch: String
    let startFromOrigin: Bool
    let temporary: Bool

    init(model: PathwayAgentThreadCreationModel) {
        prompt = model.prompt
        runtimeMode = model.runtimeMode
        interactionMode = model.interactionMode
        workspaceMode = model.workspaceMode
        baseReference = model.baseReference
        branch = model.branch
        startFromOrigin = model.startFromOrigin
        temporary = model.temporary
    }

    func apply(to model: PathwayAgentThreadCreationModel) {
        model.prompt = prompt
        model.runtimeMode = runtimeMode
        model.interactionMode = interactionMode
        model.workspaceMode = workspaceMode
        model.baseReference = baseReference
        model.branch = branch
        model.startFromOrigin = startFromOrigin
        model.temporary = temporary
    }
}

struct PathwayNewThreadBindingOption: Identifiable, Sendable {
    let binding: PathwayCompanyEnvironmentBinding?
    let environment: PathwayCompanyEnvironment
    let projectID: String?
    let projectName: String
    let companyName: String

    var id: String { binding?.id ?? PathwayAgentThreadCreationModel.conversationDraftKey(environment) }
    var label: String { projectID == nil ? "\(companyName) · \(environment.environment.label)" : environment.environment.label }
    var workspacePath: String { binding?.binding.localWorkspaceRoot ?? environment.environment.label }
}

struct PathwayNewThreadProjectOption: Identifiable {
    let id: String
    let name: String
    let companyName: String
    let bindings: [PathwayNewThreadBindingOption]
    var isConversation: Bool { id == "conversation" }

    var locationDescription: String {
        if bindings.count == 1 {
            return bindings[0].workspacePath
        }
        return "\(bindings.count) environments · \(companyName)"
    }
}

struct PathwayNewThreadProjectPicker: View {
    let projects: [PathwayNewThreadProjectOption]
    let select: (PathwayNewThreadProjectOption) -> Void

    var body: some View {
        List {
            Section {
                ForEach(projects) { project in
                    Button {
                        select(project)
                    } label: {
                        projectLabel(project)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(project.name)
                    .accessibilityValue(project.locationDescription)
                }
            } header: {
                Text("Choose where this thread should run.")
                    .textCase(nil)
            }
        }
        .listStyle(.insetGrouped)
    }

    private func projectLabel(_ project: PathwayNewThreadProjectOption) -> some View {
        HStack(spacing: 14) {
            PathwayNewThreadProjectIcon(project: project)

            VStack(alignment: .leading, spacing: 3) {
                Text(project.name)
                    .font(.headline)
                    .foregroundStyle(.primary)
                Text(project.locationDescription)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            Spacer(minLength: 8)

            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .frame(minHeight: 58)
        .contentShape(Rectangle())
    }
}

private struct PathwayNewThreadProjectIcon: View {
    @Environment(PathwayAppModel.self) private var appModel
    let project: PathwayNewThreadProjectOption

    private var contexts: [PathwayProjectIconContext] {
        guard !project.isConversation else { return [] }
        return project.bindings.compactMap { option in
            guard let binding = option.binding else { return nil }
            return PathwayProjectIconContext(binding: binding, environment: option.environment)
        }
    }

    var body: some View {
        let candidates = contexts
        let cachedImage = candidates.lazy.compactMap { appModel.projectIcons.images[$0.key] }.first
        Group {
            if let cachedImage {
                Image(uiImage: cachedImage).resizable().scaledToFit()
            } else {
                Image(systemName: project.isConversation ? "bubble.left.and.bubble.right" : "folder")
                    .font(.title3).foregroundStyle(.secondary)
            }
        }
        .frame(width: 28, height: 28)
        .clipShape(.rect(cornerRadius: 4))
        .accessibilityHidden(true)
        .task(id: candidates.map(\.key)) {
            guard cachedImage == nil, let connect = appModel.connect else { return }
            for context in candidates {
                guard !Task.isCancelled else { return }
                await appModel.projectIcons.load(context, using: connect)
                if appModel.projectIcons.images[context.key] != nil { return }
            }
        }
    }
}
