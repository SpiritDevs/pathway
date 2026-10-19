import SwiftUI

#if !os(visionOS)

    struct DestinationMenuButton: View {
        let destination: AppDestination
        let isSelected: Bool
        let action: () -> Void

        var body: some View {
            Button(action: action) {
                Label(destination.title, systemImage: destination.systemImage)
                    .font(.body.weight(.medium))
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                    .padding(.horizontal, 12)
                    .background {
                        if isSelected {
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .fill(Color.primary.opacity(0.07))
                        }
                    }
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 6)
            .accessibilityAddTraits(isSelected ? .isSelected : [])
        }
    }

    struct TabBarIconButton: View {
        let systemImage: String
        let accessibilityLabel: String
        let isSelected: Bool
        let selectionNamespace: Namespace.ID
        let action: () -> Void

        var body: some View {
            Button(action: action) {
                Image(systemName: systemImage)
                    .font(.system(size: 22, weight: .semibold))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .contentShape(Rectangle())
                    .background {
                        if isSelected {
                            Capsule()
                                .fill(Color.primary.opacity(0.08))
                                .padding(5)
                                .matchedGeometryEffect(
                                    id: "selected-tab-background",
                                    in: selectionNamespace
                                )
                        }
                    }
            }
            .buttonStyle(.plain)
            .foregroundStyle(isSelected ? Color.accentColor : Color.primary)
            .accessibilityLabel(accessibilityLabel)
            .accessibilityAddTraits(isSelected ? .isSelected : [])
        }
    }
#endif
