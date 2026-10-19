#if os(iOS)
import AVFoundation
import SwiftUI
import UIKit
import VisionKit

enum PathwayCameraPermission {
    static func request() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: true
        case .notDetermined: await AVCaptureDevice.requestAccess(for: .video)
        default: false
        }
    }
}

struct PathwayCameraCapture: UIViewControllerRepresentable {
    let complete: (Result<Data, any Error>) -> Void
    @Environment(\.dismiss) private var dismiss
    static var isSupported: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }
    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }
    func makeUIViewController(context: Context) -> UIImagePickerController {
        let controller = UIImagePickerController()
        controller.sourceType = .camera
        controller.cameraCaptureMode = .photo
        controller.delegate = context.coordinator
        return controller
    }
    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}
    @MainActor final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: PathwayCameraCapture
        init(parent: PathwayCameraCapture) { self.parent = parent }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage, let data = image.jpegData(compressionQuality: 0.85) {
                parent.complete(.success(data))
            } else { parent.complete(.failure(PathwayCaptureError.missingFile)) }
            parent.dismiss()
        }
    }
}

struct PathwayDocumentCapture: UIViewControllerRepresentable {
    let complete: (Result<Data, any Error>) -> Void
    @Environment(\.dismiss) private var dismiss
    static var isSupported: Bool { VNDocumentCameraViewController.isSupported }
    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }
    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let controller = VNDocumentCameraViewController()
        controller.delegate = context.coordinator
        return controller
    }
    func updateUIViewController(_ controller: VNDocumentCameraViewController, context: Context) {}
    @MainActor final class Coordinator: NSObject, @preconcurrency VNDocumentCameraViewControllerDelegate {
        let parent: PathwayDocumentCapture
        init(parent: PathwayDocumentCapture) { self.parent = parent }
        func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) { parent.dismiss() }
        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: any Error) {
            parent.complete(.failure(error)); parent.dismiss()
        }
        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
            guard scan.pageCount > 0, scan.pageCount <= 30 else {
                parent.complete(.failure(PathwayCaptureError.invalidInput)); parent.dismiss(); return
            }
            let bounds = CGRect(x: 0, y: 0, width: 612, height: 792)
            let renderer = UIGraphicsPDFRenderer(bounds: bounds)
            let data = renderer.pdfData { context in
                for index in 0..<scan.pageCount {
                    autoreleasepool {
                        let page = scan.imageOfPage(at: index)
                        let scale = min(bounds.width / page.size.width, bounds.height / page.size.height)
                        let size = CGSize(width: page.size.width * scale, height: page.size.height * scale)
                        context.beginPage()
                        page.draw(in: CGRect(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2, width: size.width, height: size.height))
                    }
                }
            }
            parent.complete(.success(data)); parent.dismiss()
        }
    }
}
#endif
