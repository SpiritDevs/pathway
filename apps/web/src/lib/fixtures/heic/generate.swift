// Run from this directory with `swift generate.swift`. Synthetic, non-private fixtures.
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let context = CGContext(data: nil, width: 64, height: 32, bitsPerComponent: 8,
    bytesPerRow: 64 * 4, space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
context.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
context.fill(CGRect(x: 0, y: 0, width: 32, height: 32))
context.setFillColor(CGColor(red: 0, green: 0, blue: 1, alpha: 1))
context.fill(CGRect(x: 32, y: 0, width: 32, height: 32))
let image = context.makeImage()!
for (type, ext) in [(UTType.heic, "heic"), (.png, "png"), (.jpeg, "jpg")] {
    let url = URL(fileURLWithPath: "two-colors.\(ext)")
    let destination = CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, image, [kCGImagePropertyOrientation: 6] as CFDictionary)
    precondition(CGImageDestinationFinalize(destination))
}
