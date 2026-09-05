import Foundation
@testable import Pathway
import Testing
import UIKit

@MainActor
struct PathwayProjectIconTests {
    @Test func sharesRequestsAndClearsCachedIcons() async {
        let cache = PathwayProjectIconCache()
        let key = PathwayProjectIconContext.Key(
            companyID: "company", environmentID: "environment", projectID: "project", workspaceRoot: "/project"
        )
        let image = UIImage(systemName: "folder")
        let requests = IconRequestCounter()
        await withTaskGroup(of: Void.self) { group in
            for _ in 0 ..< 10 {
                group.addTask {
                    await cache.load(key: key) {
                        requests.value += 1
                        await Task.yield()
                        return image
                    }
                }
            }
        }
        #expect(requests.value == 1)
        #expect(cache.images[key] != nil)
        cache.clear()
        #expect(cache.images.isEmpty)
        await cache.load(key: key) { requests.value += 1; return nil }
        await cache.load(key: key) { requests.value += 1; return nil }
        #expect(requests.value == 2)
    }

    @Test func resolvesOnlyTheThreadsOwnEnvironmentAndProject() {
        let thread = makeAgentThread()
        let environment = PathwayCompanyEnvironment(
            companyId: thread.companyId,
            environment: PathwayEnvironment(
                id: "environment", environmentId: thread.environmentId,
                descriptor: PathwayEnvironmentDescriptor(environmentId: thread.environmentId, label: "Mac", serverVersion: "test"),
                relayLinkState: "connected", managedEndpointAvailable: true, lastSeenAt: nil, state: "active"
            )
        )
        func binding(environmentID: String, projectID: String, status: String = "active") -> PathwayCompanyEnvironmentBinding {
            PathwayCompanyEnvironmentBinding(
                companyId: thread.companyId,
                binding: PathwayEnvironmentBinding(
                    id: "binding", cloudProjectId: thread.cloudProjectId,
                    environmentId: environmentID, localProjectId: projectID,
                    localWorkspaceRoot: "/project", status: status, lastSeenAt: nil
                )
            )
        }
        let wrongEnvironment = binding(environmentID: "other-environment", projectID: thread.shell.projectId)
        let wrongProject = binding(environmentID: thread.environmentId, projectID: "other-project")
        let revoked = binding(environmentID: thread.environmentId, projectID: thread.shell.projectId, status: "revoked")
        #expect(PathwayProjectIconContext(thread: thread, environments: [environment], bindings: [wrongEnvironment, wrongProject, revoked]) == nil)
        let correct = binding(environmentID: thread.environmentId, projectID: thread.shell.projectId)
        let context = PathwayProjectIconContext(thread: thread, environments: [environment], bindings: [wrongEnvironment, wrongProject, correct])
        #expect(context?.key.workspaceRoot == "/project")
        #expect(context?.key.environmentID == thread.environmentId)
    }

    @Test func decodesSmallThumbnailsAndRejectsInvalidImages() throws {
        let data = try #require(UIGraphicsImageRenderer(size: CGSize(width: 256, height: 256)).image { context in
            UIColor.blue.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 256, height: 256))
        }.pngData())
        let image = try #require(PathwayProjectIconCache.thumbnail(data: data))
        #expect(image.size.width <= 64)
        #expect(PathwayProjectIconCache.thumbnail(data: Data("not an image".utf8)) == nil)
    }
}

@MainActor
private final class IconRequestCounter {
    var value = 0
}
