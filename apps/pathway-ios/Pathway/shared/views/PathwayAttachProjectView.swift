import SwiftUI

struct PathwayAttachProjectView: View {
    @Environment(PathwayAppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    let thread: PathwayAgentThread
    let select: (String) -> Void

    private var bindings: [PathwayCompanyEnvironmentBinding] {
        appModel.cloud.environmentBindings.filter {
            $0.binding.environmentId == thread.environmentId
                && $0.binding.status == "active"
        }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(bindings) { binding in
                        Button {
                            select(binding.binding.localProjectId)
                            dismiss()
                        } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                Label(appModel.cloud.projectName(companyId: binding.companyId, projectId: binding.binding.cloudProjectId)
                                    ?? binding.binding.localProjectId, systemImage: "folder")
                                Text(appModel.cloud.companyName(for: binding.companyId) ?? binding.companyId)
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                } footer: {
                    Text(thread.shell.isTemporary
                        ? "Creates a dedicated worktree. Your conversation folder and history stay available, and the thread remains temporary."
                        : "Your conversation folder and history stay available after attaching a project.")
                }
                if bindings.isEmpty { Text("No projects are available on this environment.").foregroundStyle(.secondary) }
            }
            .navigationTitle("Attach Project")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
}
