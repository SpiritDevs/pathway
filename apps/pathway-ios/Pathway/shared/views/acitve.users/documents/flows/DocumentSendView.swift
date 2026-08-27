import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct DocumentSendView: View {
    @Environment(PathwayAppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss

    let document: DashboardDocument

    @State private var to = ""
    @State private var cc = ""
    @State private var subject = ""
    @State private var richText = DocumentRichTextModel()
    @State private var attachPDF = true
    @State private var attachments: [DocumentEmailAttachment] = []
    @State private var hasExpiry = false
    @State private var expiryDate = Date.now.addingTimeInterval(7 * 86_400)
    @State private var canSchedule = false
    @State private var scheduleForLater = false
    @State private var scheduledAt = DocumentSendView.defaultScheduledDate
    @State private var scheduleTimeZone = TimeZone.current.identifier
    @State private var selectedServiceID: String?
    @State private var isLoading = true
    @State private var isSending = false
    @State private var showFileImporter = false
    @State private var selectedPhotos: [PhotosPickerItem] = []
    @State private var showCC = false
    @State private var showLinkPrompt = false
    @State private var linkText = ""
    @State private var errorMessage: String?

    private var services: [MobileDashboardBootstrap.EmailService] {
        (appModel.dashboardBootstrap?.emailServices ?? []).filter(\.isAvailableForDocuments)
    }

    var body: some View {
        Form {
            if let disabledReason {
                Section {
                    Label(disabledReason, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                }
            }

            Section("Recipients") {
                TextField("To", text: $to, prompt: Text("name@example.com"))
                    .textInputAutocapitalization(.never)
                    .keyboardType(.emailAddress)
                    .accessibilityIdentifier("send-document-to")
                if showCC {
                    TextField("CC", text: $cc, prompt: Text("name@example.com"))
                        .textInputAutocapitalization(.never)
                        .keyboardType(.emailAddress)
                } else {
                    Button("Add CC") { showCC = true }
                }
                Text("Separate multiple addresses with commas.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            Section("Message") {
                TextField("Subject", text: $subject)
                    .accessibilityIdentifier("send-document-subject")
                RichTextToolbar(model: richText, showLinkPrompt: $showLinkPrompt)
                DocumentRichTextEditor(model: richText)
                    .frame(minHeight: 170)
                    .overlay {
                        if richText.isEmpty {
                            Text("Write a message…")
                                .foregroundStyle(.tertiary)
                                .allowsHitTesting(false)
                        }
                    }
                    .background(.background, in: RoundedRectangle(cornerRadius: 8))
            }

            Section("Attachments") {
                Toggle("Attach document PDF", isOn: $attachPDF)
                ForEach(attachments) { attachment in
                    HStack {
                        Label(attachment.fileName, systemImage: "paperclip")
                            .lineLimit(1)
                        Spacer()
                        Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.size), countStyle: .file))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Button(role: .destructive) {
                            attachments.removeAll { $0.id == attachment.id }
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                        }
                        .buttonStyle(.borderless)
                    }
                }
                Button("Choose Files", systemImage: "folder") { showFileImporter = true }
                PhotosPicker(selection: $selectedPhotos, maxSelectionCount: 10, matching: .images) {
                    Label("Choose Photos", systemImage: "photo.on.rectangle")
                }
                Text("Total attachments must be 15 MB or less.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            Section("Delivery") {
                if canSchedule {
                    Picker("Send", selection: $scheduleForLater) {
                        Text("Now").tag(false)
                        Text("Later").tag(true)
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("send-document-delivery-time")

                    if scheduleForLater {
                        DatePicker(
                            "Schedule for",
                            selection: $scheduledAt,
                            in: scheduleRange,
                            displayedComponents: [.date, .hourAndMinute]
                        )
                        .accessibilityIdentifier("send-document-scheduled-at")
                        LabeledContent("Time zone", value: scheduleTimeZone.replacingOccurrences(of: "_", with: " "))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                Toggle("Set expiry", isOn: $hasExpiry)
                if hasExpiry {
                    DatePicker("Expires", selection: $expiryDate, in: .now...)
                }
                if services.count > 1 {
                    Picker("Email service", selection: $selectedServiceID) {
                        Text("Pathway").tag(String?.none)
                        ForEach(services) { service in
                            Text(service.title).tag(Optional(service.id))
                        }
                    }
                } else if let service = services.first {
                    LabeledContent("Email service", value: service.title)
                }
            }
        }
        .navigationTitle("Send Document")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }.disabled(isSending)
            }
            ToolbarItem(placement: .confirmationAction) {
                Button(scheduleForLater ? "Schedule" : "Send") { send() }
                    .fontWeight(.semibold)
                    .disabled(isLoading || isSending || disabledReason != nil)
                    .accessibilityIdentifier("send-document-submit")
            }
        }
        .overlay {
            if isSending {
                ProgressView(scheduleForLater ? "Scheduling…" : "Sending…")
                    .controlSize(.large)
            }
        }
        .task { await loadDefaults() }
        .onChange(of: selectedPhotos) { _, items in loadPhotos(items) }
        .fileImporter(
            isPresented: $showFileImporter,
            allowedContentTypes: [.item],
            allowsMultipleSelection: true,
            onCompletion: importFiles
        )
        .alert("Add Link", isPresented: $showLinkPrompt) {
            TextField("https://", text: $linkText)
                .textInputAutocapitalization(.never)
            Button("Apply") {
                richText.applyLink(linkText)
                linkText = ""
            }
            Button("Cancel", role: .cancel) { linkText = "" }
        } message: {
            Text("Select text in the message first, then enter its destination.")
        }
        .alert("Couldn’t Send Document", isPresented: Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )) {
            Button("OK") { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "Try again.")
        }
    }

    private var disabledReason: String? {
        guard let bootstrap = appModel.dashboardBootstrap else {
            return isLoading ? nil : "Account capabilities are unavailable."
        }
        guard bootstrap.userData.isEmailVerified else {
            return "Verify your email address before sending documents."
        }
        guard bootstrap.userData.isActive != false else {
            return "An active subscription is required to send documents."
        }
        guard bootstrap.companyData.isOwner == true ||
                bootstrap.permissions?.canSendDocuments == true else {
            return "You do not have permission to send documents."
        }
        return nil
    }

    private func loadDefaults() async {
        defer { isLoading = false }
        subject = document.title
        do {
            let recipients = try await appModel.documentService
                .recipients(documentID: document.id).recipients
            to = recipients.filter {
                $0.email != nil && ($0.position == nil || ["toRecipient", "primary"].contains($0.position!))
            }.compactMap(\.email).joined(separator: ", ")
            cc = recipients.filter {
                $0.email != nil && $0.position == "ccRecipient"
            }.compactMap(\.email).joined(separator: ", ")
            showCC = !cc.isEmpty
            selectedServiceID = services.first(where: \.defaultForDocument)?.id ?? services.first?.id
            if let capability = try? await appModel.documentService.schedulingCapability() {
                canSchedule = capability.canSchedule
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func send() {
        let draft = DocumentSendDraft(
            to: DocumentSendValidation.emailAddresses(from: to),
            cc: DocumentSendValidation.emailAddresses(from: cc),
            subject: subject,
            htmlBody: richText.html(),
            attachPDF: attachPDF,
            attachments: attachments,
            expiredAt: hasExpiry ? expiryDate.timeIntervalSince1970 * 1_000 : nil,
            savePeriod: hasExpiry,
            serviceId: selectedServiceID,
            scheduledAt: scheduleForLater ? scheduledAt.timeIntervalSince1970 * 1_000 : nil,
            timeZone: scheduleForLater ? scheduleTimeZone : nil
        )
        if let message = DocumentSendValidation.validationMessage(for: draft) {
            errorMessage = message
            return
        }
        isSending = true
        Task {
            defer { isSending = false }
            do {
                try await appModel.documentService.send(documentID: document.id, draft: draft)
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    private var scheduleRange: ClosedRange<Date> {
        let minimum = Date.now.addingTimeInterval(DocumentSendValidation.minimumScheduleDelay + 60)
        let maximum = Date.now.addingTimeInterval(DocumentSendValidation.maximumScheduleDelay)
        return minimum ... maximum
    }

    private static var defaultScheduledDate: Date {
        let date = Date.now.addingTimeInterval(10 * 60)
        let interval: TimeInterval = 5 * 60
        return Date(timeIntervalSince1970: ceil(date.timeIntervalSince1970 / interval) * interval)
    }

    private func importFiles(_ result: Result<[URL], Error>) {
        do {
            for url in try result.get() {
                let values = try url.resourceValues(forKeys: [.fileSizeKey, .contentTypeKey])
                attachments.append(DocumentEmailAttachment(
                    fileName: url.lastPathComponent,
                    contentType: values.contentType?.preferredMIMEType ?? "application/octet-stream",
                    size: values.fileSize ?? 0,
                    localURL: url
                ))
            }
            enforceAttachmentLimit()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func loadPhotos(_ items: [PhotosPickerItem]) {
        Task {
            for item in items {
                do {
                    guard let data = try await item.loadTransferable(type: Data.self) else { continue }
                    let id = UUID()
                    let type = item.supportedContentTypes.first(where: { $0.conforms(to: .image) }) ?? .jpeg
                    let fileExtension = type.preferredFilenameExtension ?? "jpg"
                    let url = FileManager.default.temporaryDirectory
                        .appending(path: "pathway-\(id.uuidString).\(fileExtension)")
                    try data.write(to: url, options: .atomic)
                    attachments.append(DocumentEmailAttachment(
                        id: id,
                        fileName: "Photo-\(attachments.count + 1).\(fileExtension)",
                        contentType: type.preferredMIMEType ?? "image/jpeg",
                        size: data.count,
                        localURL: url
                    ))
                } catch {
                    errorMessage = error.localizedDescription
                }
            }
            selectedPhotos = []
            enforceAttachmentLimit()
        }
    }

    private func enforceAttachmentLimit() {
        let total = attachments.reduce(0) { $0 + $1.size }
        if total > DocumentSendValidation.maximumAttachmentBytes {
            errorMessage = "Attachments must total 15 MB or less. Remove one or more files."
        }
    }
}

private struct RichTextToolbar: View {
    let model: DocumentRichTextModel
    @Binding var showLinkPrompt: Bool

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack {
                Button("Bold", systemImage: "bold", action: model.toggleBold).labelStyle(.iconOnly)
                Button("Italic", systemImage: "italic", action: model.toggleItalic).labelStyle(.iconOnly)
                Button("Underline", systemImage: "underline", action: model.toggleUnderline).labelStyle(.iconOnly)
                Button("Link", systemImage: "link") { showLinkPrompt = true }.labelStyle(.iconOnly)
                Divider().frame(height: 20)
                Button("Bulleted list", systemImage: "list.bullet", action: model.applyBulletedList).labelStyle(.iconOnly)
                Button("Numbered list", systemImage: "list.number", action: model.applyNumberedList).labelStyle(.iconOnly)
            }
            .buttonStyle(.bordered)
        }
    }
}
