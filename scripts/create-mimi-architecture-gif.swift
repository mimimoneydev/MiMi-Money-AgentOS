import AppKit
import Foundation
import ImageIO
import UniformTypeIdentifiers

let sourceURL = URL(fileURLWithPath: "MiMi-Money-AgentOS-Architecture.png")
let outputURL = URL(fileURLWithPath: "MiMi-Money-AgentOS-Architecture.gif")
let outputSize = NSSize(width: 800, height: 1200)
let scale = CGFloat(2.0 / 3.0)
let source = NSImage(contentsOf: sourceURL)!
let destination = CGImageDestinationCreateWithURL(
    outputURL as CFURL,
    UTType.gif.identifier as CFString,
    12,
    nil
)!

let loopProperties: [CFString: Any] = [
    kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: 0]
]
CGImageDestinationSetProperties(destination, loopProperties as CFDictionary)

let forwardPoints: [(CGFloat, CGFloat, NSColor)] = [
    (600, 450, .systemOrange),
    (600, 732, .systemBlue),
    (600, 1064, .systemBlue),
    (600, 1397, .systemBlue),
    (600, 1698, .systemOrange)
]
let returnPoints: [(CGFloat, CGFloat)] = [
    (922, 1725),
    (1060, 1725),
    (1165, 1600),
    (1178, 900),
    (1178, 300),
    (1178, 150),
    (1135, 150)
]

for frameIndex in 0..<12 {
    let canvas = NSImage(size: outputSize)
    canvas.lockFocus()
    source.draw(in: NSRect(origin: .zero, size: outputSize), from: .zero, operation: .copy, fraction: 1)

    let point: (CGFloat, CGFloat, NSColor)
    if frameIndex < forwardPoints.count {
        let item = forwardPoints[frameIndex]
        point = (item.0, item.1, item.2)
    } else {
        let item = returnPoints[frameIndex - forwardPoints.count]
        point = (item.0, item.1, .systemBlue)
    }

    let x = point.0 * scale
    let y = (1800 - point.1) * scale
    let glowRect = NSRect(x: x - 18, y: y - 18, width: 36, height: 36)
    let dotRect = NSRect(x: x - 8, y: y - 8, width: 16, height: 16)
    let glow = NSShadow()
    glow.shadowColor = point.2.withAlphaComponent(0.8)
    glow.shadowBlurRadius = 18
    glow.set()
    point.2.withAlphaComponent(0.95).setFill()
    NSBezierPath(ovalIn: glowRect).fill()
    NSShadow().set()
    NSColor.white.setFill()
    NSBezierPath(ovalIn: dotRect).fill()
    canvas.unlockFocus()

    var proposedRect = NSRect(origin: .zero, size: outputSize)
    let image = canvas.cgImage(forProposedRect: &proposedRect, context: nil, hints: nil)!
    let frameProperties: [CFString: Any] = [
        kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: 0.42]
    ]
    CGImageDestinationAddImage(destination, image, frameProperties as CFDictionary)
}

precondition(CGImageDestinationFinalize(destination), "GIF encoding failed")
print("wrote \(outputURL.path)")
