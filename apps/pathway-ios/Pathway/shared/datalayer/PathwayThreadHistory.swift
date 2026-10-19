import Foundation

/// The loaded slice of a long thread. Servers with thread history send the latest page
/// first; the transcript loads older pages ahead of the reader as they scroll up.
struct PathwayThreadHistory: Equatable, Sendable {
    static let latestPageLimit = 50
    static let olderPageLimit = 100

    var hasOlder: Bool
    var beforeCursor: String?

    init(hasOlder: Bool, beforeCursor: String? = nil) {
        self.hasOlder = hasOlder
        self.beforeCursor = beforeCursor
    }

    init?(json: JSONValue?) {
        guard let object = json?.objectValue, let hasOlder = object["hasOlder"]?.boolValue else { return nil }
        self.init(hasOlder: hasOlder, beforeCursor: object["beforeCursor"]?.stringValue)
    }

    /// Reads one page from the environment's thread snapshot endpoint.
    static func loadPage(threadID: String, limit: Int, before: String?, environment: PathwayCompanyEnvironment,
                         connect: PathwayConnectClient) async throws -> JSONValue {
        var components = URLComponents()
        components.path = "/api/orchestration/threads/\(threadID)"
        components.queryItems = [URLQueryItem(name: "limit", value: String(limit))]
            + (before.map { [URLQueryItem(name: "before", value: $0)] } ?? [])
        guard let path = components.string else { throw URLError(.badURL) }
        return try await PathwayEnvironmentHTTP.request(environment: environment, connect: connect, method: "GET", path: path)
    }
}
