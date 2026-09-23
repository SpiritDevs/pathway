import Foundation
@testable import Pathway
import Testing

@MainActor
struct PathwayProjectCreationTests {
    private func project(_ extra: [String: JSONValue]) throws -> PathwayCloudProject {
        var fields: [String: JSONValue] = ["id": .string("project"), "name": .string("Pathway"), "description": .string(""), "archivedAt": .null]
        fields.merge(extra) { _, new in new }
        return try decodePathwayPayload(PathwayCloudProject.self, from: .object(fields))
    }

    @Test func decodesSyncedIconsAndToleratesMissingOrUnreadableOnes() throws {
        #expect(try project([:]).icon == nil)
        #expect(try project(["icon": .null]).icon == nil)
        #expect(try project(["icon": .string("Rocket")]).icon == nil)
        let icon = try project(["icon": .object(["name": .string("Rocket"), "color": .string("#3b82f6")])]).icon
        #expect(icon == PathwayProjectIcon(name: "Rocket", color: "#3b82f6"))
        #expect(try project(["teamIds": .array([.string("team")])]).teamIds == ["team"])
    }

    @Test func derivesNamesFromFoldersAndRepositories() {
        #expect(PathwayProjectCreation.folderName("/Users/me/Code/pathway/") == "pathway")
        #expect(PathwayProjectCreation.folderName("C:\\Code\\site") == "site")
        #expect(PathwayProjectCreation.folderName("~") == "")
        #expect(PathwayProjectCreation.repositoryName("owner/app") == "app")
        #expect(PathwayProjectCreation.repositoryName("git@github.com:owner/app.git") == "app")
        #expect(PathwayProjectCreation.repositoryName("https://github.com/owner/app.git") == "app")
        #expect(PathwayProjectCreation.slug("  My Café Project! v2.0 ") == "my-cafe-project-v2.0")
        #expect(PathwayProjectCreation.cloneSource("owner/app") == ["provider": .string("github"), "repository": .string("owner/app")])
        #expect(PathwayProjectCreation.cloneSource("git@github.com:owner/app.git") == ["remoteUrl": .string("git@github.com:owner/app.git")])
    }

    @Test func nameFollowsTheFirstFolderUntilTyped() {
        var draft = PathwayProjectCreationDraft(companyID: "company", rows: [.init(environmentID: "mac", path: "/code/site")])
        #expect(draft.name == "site")
        #expect(draft.repositoryName == "site")
        draft.rows[0].path = "/code/Other App"
        #expect(draft.repositoryName == "other-app")
        draft.customName = "Marketing"
        draft.rows[0].path = "/code/ignored"
        #expect(draft.name == "Marketing")
        draft.source = .clone
        draft.rows[0].path = ""
        draft.customName = nil
        draft.repository = "owner/app"
        #expect(draft.name == "app")
        #expect(!draft.canCreate)
    }

    @Test func onlyFolderProjectsMayStartWithoutAFolder() {
        var draft = PathwayProjectCreationDraft(customName: "Notes", companyID: "company", defaultEnvironmentID: "mac")
        #expect(draft.plannedRows.map(\.environmentID) == ["mac"])
        #expect(draft.canCreate)
        draft.source = .newRepository
        draft.repositoryOwner = "me"
        #expect(draft.plannedRows.isEmpty)
        #expect(!draft.canCreate)
    }

    @Test func newRepositoryIsPublishedOnceAndClonedEverywhereElse() async throws {
        let calls = CreationCalls()
        let creator = PathwayProjectCreator(
            environmentRequest: { environmentID, method, payload, _ in
                calls.entries.append((environmentID, method, payload))
                switch method {
                case "sourceControl.publishRepository":
                    return .object(["repository": .object(["nameWithOwner": .string("me/site"), "url": .string("https://github.com/me/site"), "sshUrl": .string("git@github.com:me/site.git")])])
                case "sourceControl.cloneRepository":
                    return .object(["cwd": .string("/linux/site"), "remoteUrl": .string("git@github.com:me/site.git"), "repository": .null])
                case "projects.mutate":
                    let fields = payload.objectValue ?? [:]
                    return .object(["id": fields["projectId"] ?? .null, "title": fields["title"] ?? .null, "workspaceRoot": fields["workspaceRoot"] ?? .null])
                default:
                    return .null
                }
            },
            cloudMutation: { name, arguments in
                calls.entries.append(("cloud", name, arguments))
                return name == "cloudProjects:ensureEnvironmentProject" ? .string("cloud-project") : .null
            },
            makeID: { calls.ids += 1; return "id-\(calls.ids)" }
        )
        let draft = PathwayProjectCreationDraft(
            customName: "Site", icon: PathwayProjectIcon(name: "Rocket", color: "#3b82f6"), focusID: "focus",
            companyID: "company", source: .newRepository, repositoryOwner: "me",
            rows: [.init(environmentID: "mac", path: "/mac/site"), .init(environmentID: "linux", path: "/linux/site")]
        )

        #expect(try await creator.create(draft) == "cloud-project")
        #expect(calls.entries.map { $0.method } == [
            "vcs.init", "sourceControl.publishRepository", "projects.mutate", "cloudProjects:ensureEnvironmentProject",
            "sourceControl.cloneRepository", "projects.mutate", "cloudProjects:ensureEnvironmentProject",
            "cloudProjects:setCompanyProjectIcon", "focuses:assignProject", "focuses:assignProject"
        ])
        let publish = calls.entries[1].payload.objectValue
        #expect(publish?["repository"] == .string("me/site"))
        #expect(publish?["visibility"] == .string("private"))
        let clone = calls.entries[4]
        #expect(clone.target == "linux")
        #expect(clone.payload.objectValue?["remoteUrl"] == .string("git@github.com:me/site.git"))
        #expect(calls.entries[3].payload.objectValue?["cloudProjectId"] == nil)
        #expect(calls.entries[6].payload.objectValue?["cloudProjectId"] == .string("cloud-project"))
        #expect(calls.entries[6].payload.objectValue?["localWorkspaceRoot"] == .string("/linux/site"))
        #expect(calls.entries[7].payload.objectValue?["icon"] == .object(["name": .string("Rocket"), "color": .string("#3b82f6")]))
        #expect(calls.entries.suffix(2).map { $0.payload.objectValue?["projectKey"] } == [.string("mac:id-1"), .string("linux:id-3")])
    }

    @Test func folderlessProjectHasNoRootAndSkipsIconAndFocus() async throws {
        let calls = CreationCalls()
        let creator = PathwayProjectCreator(
            environmentRequest: { environmentID, method, payload, _ in
                calls.entries.append((environmentID, method, payload))
                return .object(["id": payload.objectValue?["projectId"] ?? .null, "workspaceRoot": .null])
            },
            cloudMutation: { name, arguments in
                calls.entries.append(("cloud", name, arguments))
                return .string("cloud-project")
            }
        )
        let draft = PathwayProjectCreationDraft(customName: "Notes", companyID: "company", defaultEnvironmentID: "mac")
        _ = try await creator.create(draft)
        #expect(calls.entries.map { $0.method } == ["projects.mutate", "cloudProjects:ensureEnvironmentProject"])
        #expect(calls.entries[0].target == "mac")
        #expect(calls.entries[0].payload.objectValue?["workspaceRoot"] == .null)
        #expect(calls.entries[0].payload.objectValue?["createWorkspaceRootIfMissing"] == nil)
        #expect(calls.entries[1].payload.objectValue?["localWorkspaceRoot"] == .null)
    }
}

@MainActor
private final class CreationCalls {
    var entries: [(target: String, method: String, payload: JSONValue)] = []
    var ids = 0
}
