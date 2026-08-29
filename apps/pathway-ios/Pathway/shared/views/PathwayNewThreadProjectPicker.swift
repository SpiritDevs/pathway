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

    init(model: PathwayAgentThreadCreationModel) {
        prompt = model.prompt
        runtimeMode = model.runtimeMode
        interactionMode = model.interactionMode
        workspaceMode = model.workspaceMode
        baseReference = model.baseReference
        branch = model.branch
        startFromOrigin = model.startFromOrigin
    }

    func apply(to model: PathwayAgentThreadCreationModel) {
        model.prompt = prompt
        model.runtimeMode = runtimeMode
        model.interactionMode = interactionMode
        model.workspaceMode = workspaceMode
        model.baseReference = baseReference
        model.branch = branch
        model.startFromOrigin = startFromOrigin
    }
}

struct PathwayNewThreadBindingOption: Identifiable {
    let binding: PathwayCompanyEnvironmentBinding
    let environment: PathwayCompanyEnvironment
    let projectID: String
    let projectName: String
    let companyName: String

    var id: String { binding.id }
    var label: String { environment.environment.label }
    var workspacePath: String { binding.binding.localWorkspaceRoot }
}

struct PathwayNewThreadProjectOption: Identifiable {
    let id: String
    let name: String
    let companyName: String
    let bindings: [PathwayNewThreadBindingOption]

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
            Image(systemName: "folder")
                .font(.title3)
                .foregroundStyle(.secondary)
                .frame(width: 28)

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
