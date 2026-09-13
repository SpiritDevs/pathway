import Foundation

struct PathwayNewThreadDefaults: Identifiable {
    let id = UUID()
    let companyID: String
    let environmentID: String
    let projectID: String?
    let selection: PathwayModelSelection
    let runtimeMode: String
    let interactionMode: String
    let temporary: Bool

    @MainActor init(model: PathwayAgentThreadModel) {
        companyID = model.thread.companyId
        environmentID = model.thread.environmentId
        projectID = model.thread.shell.projectId
        selection = model.currentModelSelection
        runtimeMode = model.runtimeMode
        interactionMode = model.interactionMode
        temporary = model.thread.shell.isTemporary
    }
}

extension PathwayAgentThreadCreationModel {
    func applyThreadDefaults(_ defaults: PathwayNewThreadDefaults) throws {
        guard let provider = providers.first(where: { $0.id == defaults.selection.instanceId }),
              provider.models.contains(where: { $0.id == defaults.selection.model }) else {
            throw PathwayThreadConversationError.message("The previous thread's model is unavailable. Choose a model for this thread.")
        }
        selectedProviderID = defaults.selection.instanceId
        selectedModelID = defaults.selection.model
        optionValues = (defaults.selection.options ?? []).reduce(into: [:]) { $0[$1.id] = $1.value }
        runtimeMode = defaults.runtimeMode
        interactionMode = provider.showsInteractionMode ? defaults.interactionMode : "default"
        temporary = defaults.temporary
    }
}
