import SwiftUI

struct PathwayConnectionsDestination: View {
    @Environment(PathwayAppModel.self) private var appModel
    @State private var model: PathwayConnectionOnboardingModel?

    var body: some View {
        Group {
            if let model, let accountKey = appModel.accountIdentity {
                PathwayConnectionOnboardingView(model: model, accountKey: accountKey,
                    companies: appModel.cloud.companies,
                    roles: appModel.cloud.companies.reduce(into: [:]) { result, company in
                        result[company.id] = appModel.cloud.entities(kind: "role", companyID: company.id)
                    },
                    registrations: appModel.cloud.companies.reduce(into: [:]) { result, company in
                        result[company.id] = appModel.cloud.entities(kind: "environmentRegistration", companyID: company.id)
                    })
            } else {
                ContentUnavailableView("Sign in to connect a server", systemImage: "network")
            }
        }
        .task(id: appModel.accountIdentity) {
            model?.clear()
            model = nil
            guard let relayURL = appModel.relayURL, let connect = appModel.connect, appModel.accountIdentity != nil else { return }
            model = PathwayConnectionOnboardingModel(relayURL: relayURL,
                relayRequest: { method, path, payload in try await connect.relayAccountRequest(method: method, path: path, payload: payload) },
                cloudRequest: { kind, name, arguments in try await appModel.cloud.request(kind: kind, name: name, arguments: arguments) })
        }
    }
}
