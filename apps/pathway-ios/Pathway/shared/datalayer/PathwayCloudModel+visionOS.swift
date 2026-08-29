#if os(visionOS)
    import Observation

    /// Keeps shared feature views platform-neutral until the cloud transport supports visionOS.
    @MainActor
    @Observable
    final class PathwayCloudModel {
        private(set) var connectionState: PathwayCloudConnectionState = .disconnected
        private(set) var companies: [PathwayCompany] = []
        private(set) var environments: [PathwayCompanyEnvironment] = []
        private(set) var projects: [PathwayCompanyProject] = []
        private(set) var environmentBindings: [PathwayCompanyEnvironmentBinding] = []
        private(set) var threads: [PathwayAgentThread] = []

        init() {}

        var isConnected: Bool { false }
        var errorMessage: String? { nil }

        func start() async {}
        func retry() async {}
        func stop(clearContent _: Bool = true) async {}

        func companyName(for companyId: String) -> String? {
            companies.first { $0.id == companyId }?.name
        }

        func environmentLabel(companyId: String, environmentId: String) -> String? {
            environments.first {
                $0.companyId == companyId && $0.environment.environmentId == environmentId
            }?.environment.label
        }

        func projectName(companyId: String, projectId: String) -> String? {
            projects.first { $0.companyId == companyId && $0.project.id == projectId }?.project.name
        }
    }
#endif
