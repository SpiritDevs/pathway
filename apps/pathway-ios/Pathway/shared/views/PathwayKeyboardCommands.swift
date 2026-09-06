import SwiftUI

struct PathwayKeyboardCommands: Commands {
    var isAvailable = true
    private var preferences: PathwayKeyboardPreferences { .shared }
    var body: some Commands {
        CommandMenu("Pathway") {
            ForEach(PathwayKeyboardAction.allCases) { action in
                let binding = preferences.binding(for: action)
                Button(action.title, systemImage: action.symbol) { preferences.invoke(action) }
                    .keyboardShortcut(binding.equivalent, modifiers: binding.modifiers)
                    .disabled(!isAvailable)
            }
        }
    }
}

struct PathwayKeyboardSettingsView: View {
    @State private var preferences = PathwayKeyboardPreferences.shared
    @State private var editing: PathwayKeyboardAction?
    var body: some View {
        Form {
            Section {
                ForEach(PathwayKeyboardAction.allCases) { action in
                    Button { editing = action } label: {
                        HStack {
                            Label(action.title, systemImage: action.symbol)
                            Spacer()
                            Text(preferences.binding(for: action).display).font(.body.monospaced()).foregroundStyle(.secondary)
                        }
                    }
                }
            } header: { Text("Hardware Keyboard") } footer: {
                Text("Use these shortcuts with a connected keyboard. Hold Command to discover available commands.")
            }
            Section { Button("Reset Keyboard Shortcuts") { preferences.reset() } }
        }
        .navigationTitle("Keyboard Shortcuts")
        .sheet(item: $editing) { action in
            PathwayKeyboardBindingEditor(action: action, preferences: preferences, initial: preferences.binding(for: action))
                .presentationDetents([.medium, .large])
        }
    }
}

private struct PathwayKeyboardBindingEditor: View {
    let action: PathwayKeyboardAction
    let preferences: PathwayKeyboardPreferences
    @State private var binding: PathwayKeyboardBinding
    @Environment(\.dismiss) private var dismiss
    init(action: PathwayKeyboardAction, preferences: PathwayKeyboardPreferences, initial: PathwayKeyboardBinding) {
        self.action = action; self.preferences = preferences; _binding = State(initialValue: initial)
    }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Key", text: $binding.key).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Toggle("Command ⌘", isOn: $binding.command)
                    Toggle("Option ⌥", isOn: $binding.option)
                    Toggle("Control ⌃", isOn: $binding.control)
                    Toggle("Shift ⇧", isOn: $binding.shift)
                }
                if let error = preferences.validationMessage(for: binding, action: action) {
                    Text(error).foregroundStyle(.red)
                }
                Button("Use Default") { binding = action.defaultBinding }
            }
            .navigationTitle(action.title)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { if preferences.update(binding, for: action) { dismiss() } }
                        .disabled(preferences.validationMessage(for: binding, action: action) != nil)
                }
            }
        }
    }
}
