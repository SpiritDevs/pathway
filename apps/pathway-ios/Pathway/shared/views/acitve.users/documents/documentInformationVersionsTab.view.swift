import SwiftUI

struct DocumentInformationVersionsTab: View {
    let versions: [DocumentVersion]
    let preview: (DocumentVersion) -> Void
    let copy: (DocumentVersion) -> Void

    var body: some View {
        if versions.isEmpty {
            ContentUnavailableView(
                "No Versions Yet",
                systemImage: "doc.on.doc",
                description: Text("Saved document versions will appear here.")
            )
        } else {
            List(versions.sorted { $0.versionNumber > $1.versionNumber }) { version in
                HStack(spacing: 12) {
                    Button {
                        preview(version)
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: version.isSelected ? "doc.text.fill" : "doc.text")
                                .font(.title3)
                                .foregroundStyle(version.isSelected ? .blue : .secondary)
                                .frame(width: 38, height: 38)
                                .background(.quaternary, in: RoundedRectangle(cornerRadius: 9))
                                .accessibilityHidden(true)

                            VStack(alignment: .leading, spacing: 3) {
                                HStack(spacing: 7) {
                                    Text("Version \(version.versionNumber)")
                                        .font(.body.weight(.medium))
                                    if version.isSelected {
                                        Text("Current")
                                            .font(.caption2.weight(.semibold))
                                            .foregroundStyle(.blue)
                                            .padding(.horizontal, 6)
                                            .padding(.vertical, 2)
                                            .background(.blue.opacity(0.1), in: Capsule())
                                    }
                                }
                                Text(version.updatedDate.formatted(date: .abbreviated, time: .shortened))
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                Text("Created by \(version.createdByName)")
                                    .font(.caption)
                                    .foregroundStyle(.tertiary)
                            }

                            Spacer()
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Preview version \(version.versionNumber)")

                    Button {
                        copy(version)
                    } label: {
                        Image(systemName: "doc.on.doc")
                            .frame(width: 32, height: 32)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Copy version \(version.versionNumber)")

                    Button {
                        preview(version)
                    } label: {
                        Image(systemName: "eye")
                            .frame(width: 32, height: 32)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Preview version \(version.versionNumber)")
                }
                .padding(.vertical, 4)
            }
            .listStyle(.plain)
        }
    }
}

private extension DocumentVersion {
    var updatedDate: Date {
        Date(timeIntervalSince1970: updatedAt / 1_000)
    }
}
