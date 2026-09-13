import Foundation
import Testing
@testable import Pathway

struct PathwayAssetsTests {
    @Test func stableAssetReferencesDecodeWithoutDeliveryURLs() throws {
        let attachment = try #require(PathwayTimelineItem.attachment(.object([
            "type": .string("asset"), "assetId": .string("asset-1"), "companyId": .string("company-1")
        ])))
        #expect(attachment.id == "asset-1")
        #expect(attachment.assetId == "asset-1")
        #expect(attachment.companyId == "company-1")
        #expect(attachment.json.objectValue?["assetId"]?.stringValue == "asset-1")
        #expect(attachment.json.objectValue?["url"] == nil)
    }
    @Test func initialMessageUsesDurableAssetIdentityAndKeepsOriginalMetadata() throws {
        let file = PathwayQueueFile(metadata: .object(["id": .string("draft-id"), "type": .string("image"),
            "name": .string("Original.HEIC"), "mimeType": .string("image/heic"), "sizeBytes": .number(200)]),
            data: Data(), assetID: "asset-id")
        let entry = PathwayLocalQueueEntry(companyID: "company-id", environmentID: "environment-id", threadID: "thread-id", commandID: "command-id",
            submission: .object(["kind": .string("launch"), "input": .object(["initialMessage": .object(["text": .string("Review this photo")])])]), files: [file])
        let message = try #require(entry.assetSubmission.objectValue?["input"]?.objectValue?["initialMessage"]?.objectValue)
        let attachment = try #require(message["attachments"]?.arrayValue?.first?.objectValue)
        #expect(message["text"]?.stringValue == "Review this photo")
        #expect(attachment["type"]?.stringValue == "asset")
        #expect(attachment["id"]?.stringValue == "asset-id")
        #expect(attachment["mimeType"]?.stringValue == "image/heic")
        #expect(entry.files.first?.metadata.objectValue?["id"]?.stringValue == "draft-id")
    }
    @Test @MainActor func cloudComposerKeepsOriginalBytesBeforeRepresentationProcessing() async throws {
        let attachments = PathwayNewThreadAttachments(directory: nil, key: "asset-original-test")
        attachments.usesCloudQueue = true
        let original = Data("Original bytes, verified by storage before publication".utf8)
        await attachments.add(data: original, name: "Original.heic", mimeType: "image/heic")
        let draft = try #require(attachments.drafts.first)
        #expect(draft.name == "Original.heic")
        #expect(draft.mimeType == "image/heic")
        #expect(attachments.bytes[draft.id] == original)
    }
    @Test @MainActor func durableAssetReceiptSurvivesOutboxRestart() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = PathwayQueueFile(metadata: .object(["id": .string("draft")]), data: Data("original".utf8), assetID: "uploaded-asset")
        let entry = PathwayLocalQueueEntry(companyID: "company", environmentID: "environment", threadID: "thread", commandID: "command", submission: .object([:]), files: [file])
        try await PathwayThreadQueueStore(directory: directory).save([entry])
        let restored = try await PathwayThreadQueueStore(directory: directory).load()
        #expect(restored.first?.files.first?.assetID == "uploaded-asset")
        #expect(restored.first?.files.first?.cloudID == nil)
        #expect(restored.first?.files.first?.data == file.data)
    }
    @Test func editingAQueuedAssetRetainsItsPublishedIdentity() throws {
        let published = PathwayMessageAttachment(id: "asset-1", type: "asset", name: "Original.heic", mimeType: "image/heic", sizeBytes: 8, assetId: "asset-1", companyId: "company-1")
        let draft = PathwayThreadAttachmentDraft(id: "edited-draft", name: published.name, mimeType: published.mimeType, type: "image", sizeBytes: 8, state: .ready, attachment: published)
        let queued = try PathwayQueueFile.capture(draft, bytes: Data("original".utf8))
        #expect(queued.assetID == "asset-1")
        #expect(queued.cloudID == nil)
        #expect(queued.metadata.objectValue?["id"]?.stringValue == "edited-draft")
    }
    @Test @MainActor func retryFinalizesStoredOriginalBeforeAttemptingAnotherByteUpload() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appending(path: "original.txt")
        try Data("Original bytes".utf8).write(to: file)
        var operations: [String] = []
        let model = PathwayAssetsModel { _, name, _ in
            operations.append(name)
            if name == "assets:prepareUpload" { return .object(["assetId": .string("already-stored"), "uploadUrl": .string("https://invalid.example/upload"), "state": .string("uploading")]) }
            if name == "assets:finalizeUpload" { return .object(["id": .string("already-stored"), "originalReady": .bool(true)]) }
            throw URLError(.unsupportedURL)
        }
        await model.upload(url: file, companyID: "company", retryFinalization: true)
        #expect(model.error == nil)
        #expect(model.lastUploadedAssetID == "already-stored")
        #expect(operations == ["assets:prepareUpload", "assets:finalizeUpload"])
    }
    @Test func canonicalMarkdownAssetsParseButEncodedOrMalformedReferencesDoNot() throws {
        let reference = try #require(PathwayAssetReference.parse("pathway-asset:company-1/asset_2"))
        #expect(reference.companyID == "company-1")
        #expect(reference.assetID == "asset_2")
        for invalid in ["pathway-asset:company/../file", "pathway-asset:company/a%2Fb", "pathway-asset:company/a%252Fb", "pathway-asset:company/asset?token=x", "pathway-asset:company/asset#fragment", "pathway-asset:/asset", "pathway-asset:company/", "https://example.com/pathway-asset:company/asset"] {
            #expect(PathwayAssetReference.parse(invalid) == nil)
        }
        let parts = PathwayMarkdownInlinePart.parse("Watch [the review](pathway-asset:company-1/asset_2) here")
        #expect(parts.count == 3)
        guard case .asset(let companyID, let assetID) = parts[1].content else { Issue.record("Expected inline asset"); return }
        #expect(companyID == "company-1" && assetID == "asset_2")
        for literal in ["`[review](pathway-asset:company/asset)`", "\\[review](pathway-asset:company/asset)", "\\![review](pathway-asset:company/asset)"] {
            let parsed = PathwayMarkdownInlinePart.parse(literal)
            #expect(parsed.count == 1)
            guard case .text = parsed[0].content else { Issue.record("Literal code must remain text"); continue }
        }
    }
    @Test func oldWorkspaceDeliverablesOpenPreviewButSourceCodeRemainsALink() throws {
        let parts = PathwayMarkdownInlinePart.parse("[Review video](/Users/me/review.mp4)")
        guard case .workspaceFile(let source, _) = try #require(parts.first).content else { Issue.record("Expected workspace file"); return }
        #expect(source == "/Users/me/review.mp4")
        for source in ["[Source](/Users/me/app.swift)", "[Website](https://example.com/review.mp4)", "`[Video](/Users/me/review.mp4)`"] {
            guard case .text = try #require(PathwayMarkdownInlinePart.parse(source).first).content else { Issue.record("Expected ordinary link"); continue }
        }
    }
    @Test func missingPermissionsDoNotOfferManagement() throws {
        let asset = try #require(PathwayAsset(.object(["id": .string("asset-1"), "name": .string("Private.pdf")]), companyID: "company-1"))
        #expect(!asset.canManage)
        #expect(!asset.canShare)
        #expect(!asset.originalReady)
    }
    @Test func uploadedOriginalCanBeReadyWhilePreviewPrepares() throws {
        let asset = try #require(PathwayAsset(.object([
            "id": .string("asset-1"), "state": .string("preparing"), "previewState": .string("pending"),
            "originalReady": .bool(true), "permissions": .object(["canManage": .bool(true), "canShare": .bool(false)])
        ]), companyID: "company-1"))
        #expect(asset.originalReady)
        #expect(asset.statusLabel == "Preparing preview")
        #expect(asset.canManage)
        #expect(!asset.canShare)
    }
    @Test @MainActor func rejectedDeliveryURLNeverBecomesLocalFileAccess() async throws {
        let model = PathwayAssetsModel { _, _, _ in .object(["url": .string("file:///private/file")]) }
        let asset = try #require(PathwayAsset(.object(["id": .string("asset-1")]), companyID: "company-1"))
        await #expect(throws: (any Error).self) { try await model.resolve(asset) }
    }
    @Test @MainActor func listPreservesLastGoodRowsWhenRefreshFails() async throws {
        var calls = 0
        let model = PathwayAssetsModel { _, _, _ in
            calls += 1
            if calls > 1 { throw URLError(.notConnectedToInternet) }
            return .object(["items": .array([.object(["id": .string("asset-1"), "name": .string("Review.mp4")])]), "nextCursor": .null])
        }
        await model.load(companyID: "company-1")
        await model.load(companyID: "company-1")
        #expect(model.items.map(\.id) == ["asset-1"])
        #expect(model.error != nil)
        #expect(!model.loading)
    }
}
