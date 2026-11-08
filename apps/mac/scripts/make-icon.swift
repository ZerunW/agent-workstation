// Draws the Agent Workstation app icon with CoreGraphics (no AppKit, no window) and writes an
// .iconset directory for `iconutil`. Usage: make-icon <output.iconset>
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

func drawIcon(size px: Int) -> CGImage {
    let s = CGFloat(px)
    let cs = CGColorSpace(name: CGColorSpace.sRGB)!
    let ctx = CGContext(data: nil, width: px, height: px, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.clear(CGRect(x: 0, y: 0, width: s, height: s))

    // macOS icon grid: ~10% margin, continuous-corner squircle approximated by a rounded rect.
    let inset = s * 0.098
    let rect = CGRect(x: inset, y: inset, width: s - 2 * inset, height: s - 2 * inset)
    let radius = rect.width * 0.225
    let shape = CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)

    // Soft drop shadow.
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -s * 0.012), blur: s * 0.03, color: CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 0.28))
    ctx.addPath(shape)
    ctx.setFillColor(CGColor(srgbRed: 0.059, green: 0.463, blue: 0.431, alpha: 1))
    ctx.fillPath()
    ctx.restoreGState()

    // Teal gradient (lighter at the top, deeper at the bottom).
    ctx.saveGState()
    ctx.addPath(shape)
    ctx.clip()
    let gradient = CGGradient(colorsSpace: cs, colors: [
        CGColor(srgbRed: 0.165, green: 0.616, blue: 0.561, alpha: 1),
        CGColor(srgbRed: 0.059, green: 0.463, blue: 0.431, alpha: 1),
    ] as CFArray, locations: [0, 1])!
    ctx.drawLinearGradient(gradient, start: CGPoint(x: s / 2, y: rect.maxY), end: CGPoint(x: s / 2, y: rect.minY), options: [])
    // Subtle top highlight.
    ctx.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 0.08))
    ctx.fillEllipse(in: CGRect(x: rect.minX - rect.width * 0.2, y: rect.midY, width: rect.width * 1.4, height: rect.height * 0.9))
    ctx.restoreGState()

    // White "</>" glyph.
    let w = rect.width
    let cx = rect.midX, cy = rect.midY
    let lw = w * 0.085
    ctx.setStrokeColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
    ctx.setLineWidth(lw)
    ctx.setLineCap(.round)
    ctx.setLineJoin(.round)
    let h = w * 0.20, dx = w * 0.14, gap = w * 0.235
    // <
    ctx.move(to: CGPoint(x: cx - gap, y: cy + h))
    ctx.addLine(to: CGPoint(x: cx - gap - dx, y: cy))
    ctx.addLine(to: CGPoint(x: cx - gap, y: cy - h))
    // >
    ctx.move(to: CGPoint(x: cx + gap, y: cy + h))
    ctx.addLine(to: CGPoint(x: cx + gap + dx, y: cy))
    ctx.addLine(to: CGPoint(x: cx + gap, y: cy - h))
    // /
    ctx.move(to: CGPoint(x: cx + w * 0.07, y: cy + h * 1.15))
    ctx.addLine(to: CGPoint(x: cx - w * 0.07, y: cy - h * 1.15))
    ctx.strokePath()
    return ctx.makeImage()!
}

func writePNG(_ image: CGImage, to url: URL) {
    let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else { fatalError("could not write \(url.path)") }
}

let args = CommandLine.arguments
guard args.count == 2 else { print("usage: make-icon <output.iconset>"); exit(2) }
let out = URL(fileURLWithPath: args[1], isDirectory: true)
try? FileManager.default.removeItem(at: out)
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
for base in [16, 32, 128, 256, 512] {
    writePNG(drawIcon(size: base), to: out.appendingPathComponent("icon_\(base)x\(base).png"))
    writePNG(drawIcon(size: base * 2), to: out.appendingPathComponent("icon_\(base)x\(base)@2x.png"))
}
print("wrote \(out.path)")
