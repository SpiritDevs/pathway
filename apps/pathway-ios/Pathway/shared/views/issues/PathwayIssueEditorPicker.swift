import SwiftUI

struct PathwayIssuePickerOption: Identifiable {
    let id: String
    let title: String
    var icon = "circle"
    var color: Color = .secondary
    var group: String?
}

/// Inline cards share the composer's keyboard avoidance instead of presenting another sheet.
struct PathwayIssueEditorPicker: View {
    let title: String
    var searchPrompt: String?
    let options: [PathwayIssuePickerOption]
    let selectedIDs: Set<String>
    var multiple = false
    let close: () -> Void
    let select: (String) -> Void
    @State private var search = ""
    @FocusState.Binding var focusedField: PathwayIssueEditorFocus?

    private var matching: [PathwayIssuePickerOption] {
        options.filter { search.isEmpty || $0.title.localizedStandardContains(search) }
    }
    private var displayedRows: [PathwayIssuePickerRowValue] {
        let filtered = matching
        let selected = filtered.filter { selectedIDs.contains($0.id) }
        let remaining = filtered.filter { !selectedIDs.contains($0.id) }
        let ordered: [PathwayIssuePickerOption]
        if multiple {
            ordered = selected + remaining
        } else {
            let groups = Array(Set(filtered.compactMap(\.group))).sorted()
            ordered = filtered.filter { $0.group == nil } + groups.flatMap { group in filtered.filter { $0.group == group } }
        }
        let firstRemainingID = multiple && !selected.isEmpty ? remaining.first?.id : nil
        var previousGroup: String?
        return ordered.map { option in
            let heading = option.group != previousGroup ? option.group : nil
            previousGroup = option.group
            return PathwayIssuePickerRowValue(option: option, isSelected: selectedIDs.contains(option.id),
                                              dividerBefore: option.id == firstRemainingID, heading: heading)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            PathwayIssuePickerHeader(title: title, close: close)
            if let searchPrompt {
                HStack(spacing: 10) {
                    Image(systemName: "magnifyingglass").font(.title3)
                    TextField(searchPrompt, text: $search)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .focused($focusedField, equals: .search)
                        .accessibilityIdentifier("issue-picker-search")
                }
                .padding(.horizontal, 15).padding(.vertical, 13)
                .background(Color(uiColor: .tertiarySystemFill), in: Capsule())
            }
            if searchPrompt == nil {
                VStack(spacing: 0) { rows }
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        rows
                        if matching.isEmpty { Text("No matches").foregroundStyle(.secondary).padding(.vertical, 18) }
                    }
                }
                .scrollDismissesKeyboard(.never)
                .frame(maxHeight: .infinity)
            }
        }
        .padding(20)
        .frame(maxWidth: 540, maxHeight: searchPrompt == nil ? nil : 480, alignment: .leading)
        .background(Color(uiColor: .systemBackground), in: .rect(cornerRadius: 30))
        .shadow(color: .black.opacity(0.09), radius: 24, y: 10)
        .padding(.horizontal, 12).padding(.vertical, 20)
        .task { if searchPrompt != nil { focusedField = .search } }
    }

    private var rows: some View {
        ForEach(displayedRows) { row in
            VStack(alignment: .leading, spacing: 0) {
                if row.dividerBefore { Divider().padding(.vertical, 6) }
                if let heading = row.heading {
                    Text(heading).font(.subheadline).foregroundStyle(.secondary)
                        .padding(.top, 16).padding(.bottom, 8)
                }
                PathwayIssuePickerRow(option: row.option, isSelected: row.isSelected) {
                    select(row.id)
                    if multiple && searchPrompt != nil { focusedField = .search }
                }
            }
        }
    }
}

struct PathwayIssuePickerHeader: View {
    let title: String
    let close: () -> Void
    var body: some View {
        HStack {
            Text(title).font(.headline)
            Spacer()
            Button("Close", systemImage: "xmark", action: close)
                .font(.body.weight(.medium)).labelStyle(.iconOnly)
                .frame(width: 38, height: 38)
                .background(Color(uiColor: .tertiarySystemFill), in: Circle())
                .buttonStyle(.plain)
                .accessibilityIdentifier("issue-picker-close")
        }
    }
}


/// Reordering a selection keeps each option in the same ForEach, with selection passed as row data.
private struct PathwayIssuePickerRowValue: Identifiable {
    let option: PathwayIssuePickerOption
    let isSelected: Bool
    let dividerBefore: Bool
    let heading: String?
    var id: String { option.id }
}

private struct PathwayIssuePickerRow: View {
    let option: PathwayIssuePickerOption
    let isSelected: Bool
    let select: () -> Void

    var body: some View {
        Button(action: select) {
            HStack(spacing: 13) {
                optionIcon.frame(width: 22)
                Text(option.title).foregroundStyle(.primary)
                if option.group == "Agents" {
                    Text("Agent").font(.caption).foregroundStyle(.secondary)
                        .padding(.horizontal, 6).padding(.vertical, 3)
                        .background(.quaternary, in: Capsule())
                }
                Spacer(minLength: 6)
                if isSelected {
                    Image(systemName: "checkmark").font(.body.weight(.medium)).foregroundStyle(.primary)
                }
            }
            .font(.body).padding(.vertical, 13)
            .frame(maxWidth: .infinity, alignment: .leading).contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("issue-picker-option-\(option.id.isEmpty ? "none" : option.id)")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    @ViewBuilder
    private var optionIcon: some View {
        if option.icon == "chart.bar.fill", let level = ["low": 1, "medium": 2, "high": 3][option.id] {
            HStack(alignment: .bottom, spacing: 2) {
                ForEach(1...3, id: \.self) { bar in
                    RoundedRectangle(cornerRadius: 1)
                        .fill(bar <= level ? Color.primary : Color.secondary.opacity(0.25))
                        .frame(width: 4, height: CGFloat(5 + bar * 4))
                }
            }.frame(height: 18).accessibilityHidden(true)
        } else {
            Image(systemName: option.icon).foregroundStyle(option.color)
        }
    }
}
