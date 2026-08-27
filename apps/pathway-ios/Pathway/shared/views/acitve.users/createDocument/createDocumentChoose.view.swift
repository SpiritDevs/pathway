import PhotosUI
import SwiftUI

struct CreateDocumentChooseView: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    @Bindable var model: CreateDocumentFlowModel
    @Binding var selectedPhoto: PhotosPickerItem?
    let importError: String?
    let onChooseFile: () -> Void

    private var sourceColumns: [GridItem] {
        if dynamicTypeSize.isAccessibilitySize {
            return [GridItem(.flexible())]
        }
        return Array(repeating: GridItem(.flexible(), spacing: 10), count: 3)
    }

    private var templateColumns: [GridItem] {
        [GridItem(.adaptive(minimum: dynamicTypeSize.isAccessibilitySize ? 250 : 148, maximum: 230), spacing: 16)]
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 24) {
                LazyVGrid(columns: sourceColumns, spacing: 10) {
                    CreateDocumentSourceButton(
                        title: "Blank",
                        subtitle: "Start fresh",
                        systemImage: "doc.badge.plus",
                        isSelected: isBlankSelected,
                        action: selectBlank
                    )

                    CreateDocumentSourceButton(
                        title: "Files",
                        subtitle: "PDF or image",
                        systemImage: "folder",
                        isSelected: isFileSelected,
                        action: onChooseFile
                    )

                    PhotosPicker(selection: $selectedPhoto, matching: .images) {
                        CreateDocumentSourceLabel(
                            title: "Photos",
                            subtitle: "Choose image",
                            systemImage: "photo.on.rectangle",
                            isSelected: false
                        )
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Choose a photo")
                    .accessibilityHint("Imports one image as a document")
                }

                if let importedFile {
                    SelectedImportCard(file: importedFile) {
                        removeCurrentImport(clearDerivedTitle: true)
                        model.selection = nil
                    }
                }

                if let importError {
                    Label(importError, systemImage: "exclamationmark.circle.fill")
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .accessibilityLabel("Import error: \(importError)")
                }

                VStack(alignment: .leading, spacing: 16) {
                    CreateDocumentCollectionPicker(model: model)

                    if model.selectedCollection == .gallery {
                        galleryCategories
                    }

                    templateSearch

                    templateResults
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 20)
            .padding(.bottom, 32)
            .frame(maxWidth: 1100, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    private var templateSearch: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
            TextField("Search \(model.selectedCollection.title.lowercased())", text: $model.templateSearch)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            if !model.templateSearch.isEmpty {
                Button {
                    model.templateSearch = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 48)
        .background(Color(uiColor: .secondarySystemBackground), in: .rect(cornerRadius: 14))
    }

    @ViewBuilder
    private var templateResults: some View {
        switch model.loadState {
        case .idle where model.displayedTemplates.isEmpty,
             .loading where model.displayedTemplates.isEmpty:
            TemplateLoadingGrid(columns: templateColumns)
        case let .failed(message) where model.displayedTemplates.isEmpty:
            ContentUnavailableView {
                Label("Templates couldn’t be loaded", systemImage: "wifi.exclamationmark")
            } description: {
                Text(message)
            } actions: {
                Button("Try Again") {
                    Task {
                        if let categoryID = model.selectedCategoryID,
                           model.selectedCollection == .gallery {
                            model.selectCategory(categoryID, forceRefresh: true)
                        } else {
                            await model.load(forceRefresh: true)
                        }
                    }
                }
                .buttonStyle(.borderedProminent)
            }
            .frame(maxWidth: .infinity, minHeight: 260)
        default:
            if model.displayedTemplates.isEmpty {
                ContentUnavailableView {
                    Label(emptyTitle, systemImage: "doc.text.magnifyingglass")
                } description: {
                    Text(emptyDescription)
                }
                .frame(maxWidth: .infinity, minHeight: 260)
            } else {
                LazyVGrid(columns: templateColumns, alignment: .leading, spacing: 18) {
                    ForEach(model.displayedTemplates) { template in
                        CreateDocumentTemplateCard(
                            template: template,
                            isSelected: isSelected(template),
                            coverURL: { await model.coverURL(for: template) }
                        ) {
                            selectTemplate(template)
                        }
                    }
                }
            }
        }
    }

    private var galleryCategories: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(visibleCategories) { category in
                    Button {
                        model.selectCategory(category.id)
                    } label: {
                        Text(category.name)
                            .lineLimit(1)
                            .padding(.horizontal, 14)
                            .frame(minHeight: 40)
                            .background(
                                model.selectedCategoryID == category.id
                                    ? Color.accentColor
                                    : Color(uiColor: .secondarySystemBackground),
                                in: .capsule
                            )
                            .foregroundStyle(model.selectedCategoryID == category.id ? .white : .primary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(model.selectedCategoryID == category.id ? .isSelected : [])
                }
            }
        }
        .scrollIndicators(.hidden)
    }

    private var importedFile: CreateDocumentImport? {
        guard case let .imported(file) = model.selection else { return nil }
        return file
    }

    private var isBlankSelected: Bool {
        guard case .blank = model.selection else { return false }
        return true
    }

    private var isFileSelected: Bool {
        guard case .imported = model.selection else { return false }
        return true
    }

    private func isSelected(_ template: CreateDocumentTemplate) -> Bool {
        guard case let .template(selected) = model.selection else { return false }
        return selected.id == template.id
    }

    private var visibleCategories: [CreateDocumentTemplateCategory] {
        model.categories.filter {
            $0.name.localizedCaseInsensitiveCompare("All public templates") != .orderedSame
        }
    }

    private func selectBlank() {
        removeCurrentImport(clearDerivedTitle: true)
        model.selectBlank()
        _ = model.goForward()
    }

    private func selectTemplate(_ template: CreateDocumentTemplate) {
        removeCurrentImport(clearDerivedTitle: true)
        model.selectTemplate(template)
        _ = model.goForward()
    }

    private func removeCurrentImport(clearDerivedTitle: Bool) {
        guard case let .imported(file) = model.selection else { return }
        let originalTitle = (file.fileName as NSString).deletingPathExtension
        let temporaryTitle = file.fileURL.deletingPathExtension().lastPathComponent
        if clearDerivedTitle,
           model.title == originalTitle || model.title == temporaryTitle {
            model.title = ""
        }
        try? FileManager.default.removeItem(at: file.fileURL)
    }

    private var emptyTitle: String {
        if !model.templateSearch.isEmpty { return "No matching templates" }
        switch model.selectedCollection {
        case .suggested: return "No suggestions yet"
        case .myTemplates: return "No saved templates"
        case .gallery: return model.selectedCategoryID == nil ? "Choose a category" : "No templates in this category"
        }
    }

    private var emptyDescription: String {
        if !model.templateSearch.isEmpty {
            return "Try a different search or clear the current search."
        }
        switch model.selectedCollection {
        case .suggested: return "You can still start with a blank document or import a file."
        case .myTemplates: return "Templates saved by your company will appear here."
        case .gallery: return "Select a category to browse public templates."
        }
    }
}

private struct CreateDocumentCollectionPicker: View {
    @Bindable var model: CreateDocumentFlowModel

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(visibleCollections) { collection in
                    Button {
                        model.selectedCollection = collection
                        if collection == .gallery,
                           model.selectedCategoryID == nil,
                           let first = model.categories.first(where: {
                               $0.name.localizedCaseInsensitiveCompare("All public templates") != .orderedSame
                           }) {
                            model.selectCategory(first.id)
                        }
                    } label: {
                        Text(collection.title)
                            .font(.subheadline.weight(.semibold))
                            .padding(.horizontal, 16)
                            .frame(minHeight: 42)
                            .background(
                                model.selectedCollection == collection
                                    ? Color.accentColor.opacity(0.14)
                                    : Color.clear,
                                in: .capsule
                            )
                            .foregroundStyle(model.selectedCollection == collection ? Color.accentColor : Color.primary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(model.selectedCollection == collection ? .isSelected : [])
                }
            }
        }
        .scrollIndicators(.hidden)
    }

    private var visibleCollections: [CreateDocumentTemplateCollection] {
        var collections: [CreateDocumentTemplateCollection] = [.suggested]
        if model.quickAccessData?.templates.isEmpty == false {
            collections.append(.myTemplates)
        }
        if model.quickAccessData?.permissions?.accessPublicDocumentTemplates == true {
            collections.append(.gallery)
        }
        return collections
    }
}

private struct CreateDocumentSourceButton: View {
    let title: String
    let subtitle: String
    let systemImage: String
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            CreateDocumentSourceLabel(
                title: title,
                subtitle: subtitle,
                systemImage: systemImage,
                isSelected: isSelected
            )
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

struct CreateDocumentSourceLabel: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    let title: String
    let subtitle: String
    let systemImage: String
    let isSelected: Bool

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                horizontalContent
            } else {
                compactContent
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, minHeight: dynamicTypeSize.isAccessibilitySize ? 68 : 112)
        .background(Color(uiColor: .secondarySystemBackground), in: .rect(cornerRadius: 16))
        .contentShape(Rectangle())
    }

    private var sourceIcon: some View {
        Image(systemName: systemImage)
            .font(.title3.weight(.semibold))
            .foregroundStyle(isSelected ? Color.accentColor : Color.primary)
            .frame(width: 38, height: 38)
            .background(
                Color.accentColor.opacity(isSelected ? 0.16 : 0.08),
                in: .rect(cornerRadius: 11)
            )
    }

    private var compactContent: some View {
        VStack(spacing: 7) {
            sourceIcon

            VStack(spacing: 2) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity)
    }

    private var horizontalContent: some View {
        HStack(spacing: 12) {
            sourceIcon

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct SelectedImportCard: View {
    let file: CreateDocumentImport
    let onRemove: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: file.kind == .pdf ? "doc.richtext.fill" : "photo.fill")
                .font(.title2)
                .foregroundStyle(Color.accentColor)
                .frame(width: 46, height: 56)
                .background(Color.accentColor.opacity(0.1), in: .rect(cornerRadius: 12))

            VStack(alignment: .leading, spacing: 3) {
                Text(file.fileName)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(2)
                Text(ByteCountFormatter.string(fromByteCount: Int64(file.size), countStyle: .file))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            Button(action: onRemove) {
                Image(systemName: "xmark.circle.fill")
                    .font(.title3)
                    .foregroundStyle(.secondary)
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("Remove imported file")
        }
        .padding(12)
        .background(Color(uiColor: .secondarySystemBackground), in: .rect(cornerRadius: 16))
    }
}

private struct CreateDocumentTemplateCard: View {
    let template: CreateDocumentTemplate
    let isSelected: Bool
    let coverURL: () async -> URL?
    let action: () -> Void

    @State private var resolvedCoverURL: URL?
    @State private var hasResolvedCover = false

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 10) {
                ZStack(alignment: .topTrailing) {
                    AsyncImage(url: resolvedCoverURL, transaction: Transaction(animation: .easeInOut)) { phase in
                        switch phase {
                        case let .success(image):
                            image
                                .resizable()
                                .scaledToFill()
                        case .empty where !hasResolvedCover:
                            ProgressView()
                                .frame(maxWidth: .infinity, maxHeight: .infinity)
                        default:
                            Image(systemName: "doc.text.image")
                                .font(.largeTitle)
                                .foregroundStyle(.tertiary)
                                .frame(maxWidth: .infinity, maxHeight: .infinity)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .aspectRatio(0.75, contentMode: .fit)
                    .clipped()
                    .background(Color(uiColor: .tertiarySystemBackground))
                    .clipShape(.rect(cornerRadius: 12))
                    .accessibilityHidden(true)

                }

                Text(template.displayName)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(2, reservesSpace: true)

                if let description = template.templateDescription,
                   !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text(description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(uiColor: .secondarySystemBackground), in: .rect(cornerRadius: 16))
            .overlay {
                RoundedRectangle(cornerRadius: 16)
                    .stroke(Color.secondary.opacity(0.12), lineWidth: 1)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(template.displayName)
        .accessibilityValue(isSelected ? "Selected" : "Not selected")
        .accessibilityHint("Double-tap to select this template")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .task(id: template.id) {
            resolvedCoverURL = await coverURL()
            hasResolvedCover = true
        }
    }
}

private struct TemplateLoadingGrid: View {
    let columns: [GridItem]

    var body: some View {
        LazyVGrid(columns: columns, alignment: .leading, spacing: 18) {
            ForEach(0..<6, id: \.self) { _ in
                VStack(alignment: .leading, spacing: 10) {
                    RoundedRectangle(cornerRadius: 12)
                        .fill(Color.secondary.opacity(0.12))
                        .aspectRatio(0.75, contentMode: .fit)
                    RoundedRectangle(cornerRadius: 4)
                        .fill(Color.secondary.opacity(0.12))
                        .frame(height: 16)
                }
                .padding(10)
                .background(Color(uiColor: .secondarySystemBackground), in: .rect(cornerRadius: 16))
            }
        }
        .redacted(reason: .placeholder)
        .accessibilityLabel("Loading templates")
    }
}

extension CreateDocumentTemplateCollection {
    var title: String {
        switch self {
        case .suggested: "Suggested"
        case .myTemplates: "My Templates"
        case .gallery: "Template Gallery"
        }
    }
}
