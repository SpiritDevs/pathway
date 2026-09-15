import SwiftUI

struct AgentThreadComposerSettings: View {
    @Bindable var model: PathwayAgentThreadModel

    var body: some View {
        AgentModelSettingsSheet(
            providers: model.modelCatalog.isEmpty ? model.providers : model.modelCatalog,
            selection: model.currentModelSelection,
            runtimeMode: model.runtimeMode,
            interactionMode: model.interactionMode,
            environmentID: model.thread.environmentId,
            lockReason: model.isConfigurationLocked
                ? model.configurationLockReason ?? "This thread's configuration can't be changed right now." : nil,
            refresh: { await model.refreshServerConfig() }
        ) { selection, access, mode in
            if selection != model.currentModelSelection { try await model.changeModelSelection(selection) }
            if access != model.runtimeMode { try await model.setRuntimeMode(access) }
            if mode != model.interactionMode { try await model.setInteractionMode(mode) }
        }
    }
}
