import AppKit
import Foundation

let directory = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("build/icon.iconset")
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let image = NSImage(size: NSSize(width: pixels, height: pixels))
        image.lockFocus()
        let context = NSGraphicsContext.current!.cgContext
        context.scaleBy(x: CGFloat(pixels) / 1024, y: CGFloat(pixels) / 1024)
        let tile = NSBezierPath(roundedRect: NSRect(x: 42, y: 42, width: 940, height: 940), xRadius: 216, yRadius: 216)
        NSGradient(starting: NSColor(srgbRed: 0.88, green: 0.93, blue: 1, alpha: 1), ending: NSColor(srgbRed: 0.72, green: 0.79, blue: 0.94, alpha: 1))!.draw(in: tile, angle: -45)
        NSColor(srgbRed: 0.17, green: 0.24, blue: 0.39, alpha: 1).setStroke()
        let arch = NSBezierPath()
        arch.move(to: NSPoint(x: 260, y: 270))
        arch.line(to: NSPoint(x: 260, y: 510))
        arch.curve(to: NSPoint(x: 764, y: 510), controlPoint1: NSPoint(x: 260, y: 858), controlPoint2: NSPoint(x: 764, y: 858))
        arch.line(to: NSPoint(x: 764, y: 270))
        arch.lineWidth = 76
        arch.lineCapStyle = .round
        arch.stroke()
        let bridge = NSBezierPath()
        bridge.move(to: NSPoint(x: 372, y: 414))
        bridge.line(to: NSPoint(x: 652, y: 414))
        bridge.lineWidth = 62
        bridge.lineCapStyle = .round
        bridge.stroke()
        image.unlockFocus()
        guard let data = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: data), let png = bitmap.representation(using: .png, properties: [:]) else { fatalError("Cannot render Arco icon") }
        try png.write(to: directory.appendingPathComponent("icon_\(size)x\(size)\(scale == 2 ? "@2x" : "").png"))
    }
}
let process = Process()
process.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
process.arguments = ["-c", "icns", directory.path, "-o", directory.deletingLastPathComponent().appendingPathComponent("icon.icns").path]
try process.run()
process.waitUntilExit()
if process.terminationStatus != 0 { exit(process.terminationStatus) }
