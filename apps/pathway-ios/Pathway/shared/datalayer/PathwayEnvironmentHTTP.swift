import Foundation

enum PathwayEnvironmentHTTP {
    static func assetURL(_ path: String, threadID: String, environment: PathwayCompanyEnvironment,
                         connect: PathwayConnectClient, resourceKind: String = "workspace-file", request: PathwayWorkspaceRequest) async throws -> URL {
        let signed = try await request("assets.createUrl", .object([
            "resource": .object(["_tag": .string(resourceKind), "threadId": .string(threadID), "path": .string(path)])
        ]))
        let connection = try await connect.prepare(environment: environment)
        return try signedAssetURL(signed, base: connection.httpBaseURL)
    }

    static func signedAssetURL(_ response: JSONValue, base: URL) throws -> URL {
        if case let .number(expiresAt)? = response.objectValue?["expiresAt"],
           expiresAt <= Date().timeIntervalSince1970 * 1000 + 60_000 { throw URLError(.userAuthenticationRequired) }
        guard let relative = response.objectValue?["relativeUrl"]?.stringValue,
              relative.hasPrefix("/api/assets/") else { throw URLError(.badServerResponse) }
        let url = try resolve(relative, base: base)
        guard url.path.hasPrefix("/api/assets/") else { throw URLError(.badURL) }
        return url
    }

    static func request(environment: PathwayCompanyEnvironment, connect: PathwayConnectClient,
                        method: String, path: String, payload: JSONValue? = nil) async throws -> JSONValue {
        var request = try await connect.authenticatedRequest(environment: environment, method: method, path: path)
        if let payload {
            request.httpBody = try JSONEncoder().encode(payload)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200...299).contains(response.statusCode) else {
            let body = try? JSONDecoder().decode(JSONValue.self, from: data)
            throw PathwayThreadConversationError.message(body?.objectValue?["message"]?.stringValue
                ?? "The environment could not complete this request (HTTP \(response.statusCode)).")
        }
        if data.isEmpty { return .null }
        return try JSONDecoder().decode(JSONValue.self, from: data)
    }

    private static func resolve(_ relative: String, base: URL) throws -> URL {
        guard let url = URL(string: relative, relativeTo: base)?.absoluteURL,
              url.scheme == base.scheme, url.host == base.host, url.port == base.port,
              url.user == nil, url.password == nil else { throw URLError(.badURL) }
        return url
    }
}
