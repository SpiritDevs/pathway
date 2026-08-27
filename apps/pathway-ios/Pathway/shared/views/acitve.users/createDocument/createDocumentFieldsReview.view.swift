import PDFKit
import SwiftUI
import UIKit

struct CreateDocumentFieldsView: View {
    @Bindable var model: CreateDocumentFlowModel

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Personalise your template")
                        .font(.title2.bold())
                    Text("These values will be inserted into the document when it is created.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                ForEach($model.dataItems) { $value in
                    CreateDocumentDataItemField(value: $value)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 20)
            .padding(.bottom, 32)
            .frame(maxWidth: 700, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
    }
}

private struct CreateDocumentDataItemField: View {
    @Binding var value: CreateDocumentDataItemValue

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(value.item.label)
                    .font(.subheadline.weight(.semibold))
                if value.item.mandatory {
                    Text("Required")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.red)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(Color.red.opacity(0.1), in: .capsule)
                }
            }

            control
        }
        .padding(14)
        .background(Color(uiColor: .secondarySystemBackground), in: .rect(cornerRadius: 16))
        .overlay {
            RoundedRectangle(cornerRadius: 16)
                .stroke(isMissingRequiredValue ? Color.red : Color.clear, lineWidth: 1.5)
        }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private var control: some View {
        switch value.item.type.lowercased() {
        case "select", "dropdown":
            Picker(value.item.label, selection: $value.value) {
                if !value.item.mandatory {
                    Text("Not selected").tag("")
                }
                ForEach(value.item.values, id: \.self) { option in
                    Text(option).tag(option)
                }
            }
            .pickerStyle(.menu)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)

        case "date":
            if value.value.isEmpty {
                Button(value.item.mandatory ? "Choose date" : "Set date") {
                    value.value = ISO8601DateFormatter().string(from: .now)
                }
                .buttonStyle(.bordered)
                .frame(minHeight: 44)
            } else {
                HStack {
                    DatePicker(
                        value.item.label,
                        selection: dateBinding,
                        displayedComponents: .date
                    )
                    .labelsHidden()
                    if !value.item.mandatory {
                        Button("Clear") { value.value = "" }
                            .font(.subheadline)
                    }
                }
                .frame(minHeight: 44)
            }

        case "textarea", "longtext", "long_text":
            TextEditor(text: $value.value)
                .frame(minHeight: 110)
                .padding(8)
                .scrollContentBackground(.hidden)
                .background(Color(uiColor: .systemBackground), in: .rect(cornerRadius: 10))
                .accessibilityLabel(value.item.label)

        default:
            TextField(value.item.label, text: $value.value, axis: .vertical)
                .lineLimit(1...4)
                .padding(.horizontal, 12)
                .frame(minHeight: 48)
                .background(Color(uiColor: .systemBackground), in: .rect(cornerRadius: 10))
                .accessibilityLabel(value.item.label)
        }
    }

    private var dateBinding: Binding<Date> {
        Binding(
            get: {
                ISO8601DateFormatter().date(from: value.value) ?? parsedSimpleDate ?? .now
            },
            set: { date in
                value.value = ISO8601DateFormatter().string(from: date)
            }
        )
    }

    private var parsedSimpleDate: Date? {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.date(from: value.value)
    }

    private var isMissingRequiredValue: Bool {
        value.item.mandatory && value.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

struct CreateDocumentReviewView: View {
    @Bindable var model: CreateDocumentFlowModel
    let onEdit: (CreateDocumentStep) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Ready to create")
                        .font(.title2.bold())
                    Text("Check the details below before opening the document editor.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .padding(.bottom, 4)

                ReviewSection(title: "Starting point", editLabel: "Change source") {
                    onEdit(.choose)
                } content: {
                    ReviewSourceSummary(model: model)
                }

                ReviewSection(title: "Document", editLabel: "Edit document details") {
                    onEdit(.details)
                } content: {
                    ReviewValueRow(
                        label: "Title",
                        value: model.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            ? "Untitled Document"
                            : model.title
                    )
                    ReviewValueRow(label: "Owner", value: ownerName)
                }

                ReviewSection(title: "Recipients", editLabel: "Edit recipients") {
                    onEdit(.details)
                } content: {
                    let recipients = model.recipients.filter { !$0.isBlank }
                    if recipients.isEmpty {
                        Text("No recipients")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(Array(recipients.enumerated()), id: \.element.id) { index, recipient in
                            ReviewValueRow(
                                label: index < model.requiredPrimaryRecipientCount ? "Primary" : "Additional",
                                value: recipientSummary(recipient)
                            )
                        }
                    }
                }

                if model.hasTemplateFields {
                    ReviewSection(title: "Template fields", editLabel: "Edit template fields") {
                        onEdit(.fields)
                    } content: {
                        ForEach(model.dataItems) { value in
                            ReviewValueRow(
                                label: value.item.label,
                                value: value.value.isEmpty ? "Not provided" : displayValue(value)
                            )
                        }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 20)
            .padding(.bottom, 32)
            .frame(maxWidth: 760, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
    }

    private var ownerName: String {
        guard let ownerID = model.ownerUserID else { return "Me" }
        return model.context.assignableUsers.first(where: { $0.id == ownerID })?.displayName ?? "Me"
    }

    private func recipientSummary(_ recipient: CreateDocumentRecipient) -> String {
        let name = [recipient.firstName, recipient.lastName]
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        return [name, recipient.email].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private func displayValue(_ value: CreateDocumentDataItemValue) -> String {
        guard value.item.type.lowercased() == "date",
              let date = ISO8601DateFormatter().date(from: value.value) else {
            return value.value
        }
        return date.formatted(date: .abbreviated, time: .omitted)
    }
}

private struct ReviewSection<Content: View>: View {
    let title: String
    let editLabel: String
    let onEdit: () -> Void
    @ViewBuilder let content: Content

    init(
        title: String,
        editLabel: String,
        onEdit: @escaping () -> Void,
        @ViewBuilder content: () -> Content
    ) {
        self.title = title
        self.editLabel = editLabel
        self.onEdit = onEdit
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(title)
                    .font(.headline)
                Spacer()
                Button("Change", action: onEdit)
                    .font(.subheadline.weight(.semibold))
                    .accessibilityLabel(editLabel)
            }

            content
        }
        .padding(16)
        .background(Color(uiColor: .secondarySystemBackground), in: .rect(cornerRadius: 18))
    }
}

private struct ReviewValueRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .font(.subheadline.weight(.medium))
                .multilineTextAlignment(.trailing)
        }
        .accessibilityElement(children: .combine)
    }
}

private struct ReviewSourceSummary: View {
    @Bindable var model: CreateDocumentFlowModel
    @State private var coverURL: URL?
    @State private var localPreview: UIImage?

    var body: some View {
        HStack(spacing: 14) {
            Group {
                if let localPreview {
                    Image(uiImage: localPreview)
                        .resizable()
                        .scaledToFill()
                } else if let coverURL {
                    AsyncImage(url: coverURL) { image in
                        image.resizable().scaledToFill()
                    } placeholder: {
                        ProgressView()
                    }
                } else {
                    Image(systemName: sourceIcon)
                        .font(.title2)
                        .foregroundStyle(Color.accentColor)
                }
            }
            .frame(width: 56, height: 72)
            .background(Color(uiColor: .systemBackground), in: .rect(cornerRadius: 10))
            .clipShape(.rect(cornerRadius: 10))
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 3) {
                Text(sourceTitle)
                    .font(.body.weight(.semibold))
                Text(sourceSubtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .task(id: templateID) {
            guard case let .template(template) = model.selection else {
                coverURL = nil
                return
            }
            coverURL = await model.coverURL(for: template)
        }
        .task(id: importedFileURL) {
            guard case let .imported(file) = model.selection else {
                localPreview = nil
                return
            }
            let fileURL = file.fileURL
            let isPDF = file.kind == .pdf
            let data = await Task.detached(priority: .utility) {
                Self.makePreviewData(fileURL: fileURL, isPDF: isPDF)
            }.value
            guard !Task.isCancelled else { return }
            localPreview = data.flatMap(UIImage.init(data:))
        }
    }

    private var templateID: String? {
        guard case let .template(template) = model.selection else { return nil }
        return template.id
    }

    private var importedFileURL: URL? {
        guard case let .imported(file) = model.selection else { return nil }
        return file.fileURL
    }

    nonisolated private static func makePreviewData(fileURL: URL, isPDF: Bool) -> Data? {
        autoreleasepool {
            let image: UIImage?
            if isPDF {
                image = PDFDocument(url: fileURL)?.page(at: 0)?.thumbnail(
                    of: CGSize(width: 224, height: 288),
                    for: .mediaBox
                )
            } else {
                image = UIImage(contentsOfFile: fileURL.path)
            }
            return image?.pngData()
        }
    }

    private var sourceTitle: String {
        switch model.selection {
        case .blank: "Blank document"
        case let .template(template): template.displayName
        case let .imported(file): file.fileName
        case .none: "No source selected"
        }
    }

    private var sourceSubtitle: String {
        switch model.selection {
        case .blank: "Start from an empty document"
        case .template: "Pathway template"
        case let .imported(file): file.kind == .pdf ? "Imported PDF" : "Imported image"
        case .none: "Return to Choose"
        }
    }

    private var sourceIcon: String {
        switch model.selection {
        case .blank: "doc"
        case .template: "doc.text.image"
        case let .imported(file): file.kind == .pdf ? "doc.richtext" : "photo"
        case .none: "questionmark.folder"
        }
    }
}
