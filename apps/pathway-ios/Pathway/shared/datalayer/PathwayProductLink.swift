import Foundation

struct PathwayProductLink: Equatable, Sendable {
    let environmentID: String
    let threadID: String

    init?(url: URL, allowedWebHost: String? = nil) {
        let components: [String]
        if url.scheme == "pathway", url.host == "threads" {
            components = url.pathComponents.filter { $0 != "/" }
        } else if url.scheme == "https", let allowedWebHost, url.host == allowedWebHost {
            let path = url.pathComponents.filter { $0 != "/" }
            guard path.first == "threads" else { return nil }
            components = Array(path.dropFirst())
        } else { return nil }
        guard components.count == 2, components.allSatisfy({ !$0.isEmpty && !$0.contains("/") }),
              url.user == nil, url.password == nil else { return nil }
        environmentID = components[0]; threadID = components[1]
    }

    init?(notification: [AnyHashable: Any]) {
        guard let environment = notification["environmentId"] as? String, !environment.isEmpty,
              let thread = notification["threadId"] as? String, !thread.isEmpty else { return nil }
        environmentID = environment; threadID = thread
    }
}

/// Local storage alerts carry an account partition so old notifications cannot open another account's data.
struct PathwayStorageNotificationDestination: Equatable, Sendable {
    let account: String
    let environmentID: String

    init(account: String, environmentID: String) {
        self.account = account
        self.environmentID = environmentID
    }

    init?(notification: [AnyHashable: Any]) {
        guard notification["destination"] as? String == "storage",
              let account = notification["account"] as? String, !account.isEmpty,
              let environment = notification["environmentId"] as? String, !environment.isEmpty else { return nil }
        self.init(account: account, environmentID: environment)
    }

    var userInfo: [AnyHashable: Any] {
        ["destination": "storage", "account": account, "environmentId": environmentID]
    }
}
