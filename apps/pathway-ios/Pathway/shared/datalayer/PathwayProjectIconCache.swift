import Foundation
import ImageIO
import Observation
import UIKit

struct PathwayProjectIconContext: Sendable {
    struct Key: Hashable, Sendable {
        let companyID: String
        let environmentID: String
        let projectID: String
        let workspaceRoot: String
    }

    let key: Key
    let environment: PathwayCompanyEnvironment

    init?(
        thread: PathwayAgentThread,
        environments: [PathwayCompanyEnvironment],
        bindings: [PathwayCompanyEnvironmentBinding]
    ) {
        guard let environment = environments.first(where: {
            $0.companyId == thread.companyId
                && $0.environment.environmentId == thread.environmentId
        }), let binding = bindings.first(where: {
            $0.companyId == thread.companyId
                && $0.binding.environmentId == thread.environmentId
                && $0.binding.localProjectId == thread.shell.projectId
                && $0.binding.status == "active"
        }), !binding.binding.localWorkspaceRoot.isEmpty else { return nil }
        self.environment = environment
        key = Key(
            companyID: thread.companyId,
            environmentID: thread.environmentId,
            projectID: thread.shell.projectId,
            workspaceRoot: binding.binding.localWorkspaceRoot
        )
    }
}

/// Shares decoded thumbnails and in-flight requests between rows for the same project.
@MainActor
@Observable
final class PathwayProjectIconCache {
    private(set) var images: [PathwayProjectIconContext.Key: UIImage] = [:]
    @ObservationIgnored private var requests: [PathwayProjectIconContext.Key: Task<UIImage?, Never>] = [:]
    @ObservationIgnored private var refreshAfter: [PathwayProjectIconContext.Key: Date] = [:]
    @ObservationIgnored private var generation = 0

    func load(_ context: PathwayProjectIconContext, using connect: PathwayConnectClient) async {
        await load(key: context.key) {
            await Self.fetch(context, using: connect)
        }
    }

    func load(
        key: PathwayProjectIconContext.Key,
        fetch: @escaping @MainActor () async -> UIImage?
    ) async {
        if let refresh = refreshAfter[key], refresh > Date() { return }
        let currentGeneration = generation
        let request: Task<UIImage?, Never>
        if let existing = requests[key] {
            request = existing
        } else {
            request = Task { await fetch() }
            requests[key] = request
        }
        let image = await request.value
        guard generation == currentGeneration else { return }
        images[key] = image
        refreshAfter[key] = Date().addingTimeInterval(image == nil ? 30 : 300)
        requests[key] = nil
    }

    func clear() {
        generation += 1
        requests.values.forEach { $0.cancel() }
        requests = [:]
        refreshAfter = [:]
        images = [:]
    }

    private static func fetch(
        _ context: PathwayProjectIconContext,
        using connect: PathwayConnectClient
    ) async -> UIImage? {
        do {
            let connection = try await connect.prepare(environment: context.environment)
            let rpc = PathwayRPCClient { connection.webSocketURL }
            let result: JSONValue
            do {
                result = try await withThrowingTaskGroup(of: JSONValue.self) { group in
                    group.addTask {
                        try await rpc.request("assets.createUrl", payload: .object([
                            "resource": .object([
                                "_tag": .string("project-favicon"),
                                "cwd": .string(context.key.workspaceRoot)
                            ])
                        ]))
                    }
                    group.addTask {
                        try await Task.sleep(for: .seconds(15))
                        throw URLError(.timedOut)
                    }
                    defer { group.cancelAll() }
                    guard let value = try await group.next() else { throw CancellationError() }
                    return value
                }
            } catch {
                await rpc.stop()
                return nil
            }
            await rpc.stop()
            guard !Task.isCancelled,
                  let relativeURL = result.objectValue?["relativeUrl"]?.stringValue,
                  let url = URL(string: relativeURL, relativeTo: connection.httpBaseURL)?.absoluteURL,
                  url.lastPathComponent != "project-favicon-missing"
            else { return nil }
            let (data, response) = try await URLSession.shared.data(
                for: URLRequest(url: url, timeoutInterval: 15)
            )
            guard !Task.isCancelled,
                  let response = response as? HTTPURLResponse,
                  (200 ..< 300).contains(response.statusCode)
            else { return nil }
            return thumbnail(data: data)
        } catch {
            return nil
        }
    }

    static func thumbnail(data: Data) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                  kCGImageSourceCreateThumbnailFromImageAlways: true,
                  kCGImageSourceCreateThumbnailWithTransform: true,
                  kCGImageSourceThumbnailMaxPixelSize: 64
              ] as CFDictionary)
        else { return nil }
        return UIImage(cgImage: image)
    }
}
