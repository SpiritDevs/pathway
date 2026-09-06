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
