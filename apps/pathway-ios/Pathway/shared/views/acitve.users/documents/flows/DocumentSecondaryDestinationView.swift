import SwiftUI

struct DocumentSecondaryDestinationView: View {
    let destination: DocumentInteractionDestination

    var body: some View {
        NavigationStack {
            switch destination {
            case .share(let document):
                DocumentShareView(document: document)
            case .transfer(let document):
                DocumentTransferView(document: document)
            case .send(let document):
                DocumentSendView(document: document)
            case .information:
                ContentUnavailableView(
                    "Document Information",
                    systemImage: "doc.text.magnifyingglass",
                    description: Text("Open document information from the document row.")
                )
            }
        }
    }
}
