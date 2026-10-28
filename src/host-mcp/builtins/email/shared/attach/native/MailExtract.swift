// Text out of a file, for an agent that can only read text.
//
// Two paths, tried in that order:
//
//   1. PDFKit's text layer. Almost every PDF that was generated rather than scanned has one, and
//      reading it is instant, exact, and preserves the reading order the producer intended.
//   2. Vision OCR, per page, when there is no usable text layer — a scan, a photographed receipt,
//      an image attachment. Slow and approximate, so it is the fallback and never the first try.
//
// Reported honestly: the caller is told which path produced the text, because "extracted" and
// "OCR'd" carry very different confidence and an agent quoting a total off a receipt should be able
// to tell them apart.
//
// Output is one JSON object on stdout. Errors are JSON too, on stdout with a non-zero exit, so the
// caller never has to parse a human sentence off stderr to find out what went wrong.

import Foundation
import CoreGraphics
import ImageIO
import PDFKit
import Vision

struct Result: Codable {
    let text: String
    let method: String
    let pages: Int
}

struct Failure: Codable {
    let error: String
}

func emit<T: Codable>(_ value: T, exit code: Int32) -> Never {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    if let data = try? encoder.encode(value), let json = String(data: data, encoding: .utf8) {
        print(json)
    } else {
        print("{\"error\":\"could not encode result\"}")
    }
    exit(code)
}

func fail(_ message: String) -> Never {
    emit(Failure(error: message), exit: 1)
}

/// Vision text recognition over one bitmap.
///
/// `.accurate` rather than `.fast`: this runs on a document someone wants read back to them, where
/// a wrong digit in an invoice total costs more than the extra second.
func ocr(_ image: CGImage) -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true

    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do {
        try handler.perform([request])
    } catch {
        return ""
    }

    guard let observations = request.results else { return "" }
    return observations.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
}

/// Render one PDF page at a scale that OCR can actually read.
///
/// 2x. A PDF point is 1/72", so rendering 1:1 gives 72 dpi, at which Vision misreads small print
/// badly; 144 dpi is the point where receipts and invoice line items come back reliably.
func render(page: PDFPage) -> CGImage? {
    let bounds = page.bounds(for: .mediaBox)
    let scale: CGFloat = 2.0
    let width = Int(bounds.width * scale)
    let height = Int(bounds.height * scale)
    guard width > 0, height > 0, width * height < 80_000_000 else { return nil }

    guard
        let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        )
    else { return nil }

    context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.scaleBy(x: scale, y: scale)
    context.translateBy(x: -bounds.origin.x, y: -bounds.origin.y)
    page.draw(with: .mediaBox, to: context)
    return context.makeImage()
}

func extractPdf(_ url: URL) -> Never {
    guard let document = PDFDocument(url: url) else {
        fail("not a readable PDF")
    }
    if document.isLocked {
        fail("the PDF is password-protected")
    }

    let pageCount = document.pageCount
    let layer = document.string ?? ""

    // A handful of stray characters is what a scanned page yields when the producer stamped a
    // header on it — present, but not the document. Treating that as the text layer would return a
    // page number instead of the invoice, so the bar is per-page rather than absolute.
    if layer.trimmingCharacters(in: .whitespacesAndNewlines).count >= max(40, pageCount * 20) {
        emit(Result(text: layer, method: "pdfkit", pages: pageCount), exit: 0)
    }

    var pieces: [String] = []
    for index in 0..<pageCount {
        guard let page = document.page(at: index), let image = render(page: page) else { continue }
        let text = ocr(image)
        if !text.isEmpty { pieces.append(text) }
    }

    let recognized = pieces.joined(separator: "\n\n")
    if recognized.isEmpty {
        // Not an error: a PDF of photographs legitimately has no text. Saying so beats an empty
        // string the caller has to guess the meaning of.
        emit(Result(text: "", method: "no-text-found", pages: pageCount), exit: 0)
    }
    emit(Result(text: recognized, method: "vision-ocr", pages: pageCount), exit: 0)
}

func extractImage(_ url: URL) -> Never {
    guard
        let source = CGImageSourceCreateWithURL(url as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else {
        fail("not a readable image")
    }

    let text = ocr(image)
    emit(Result(text: text, method: text.isEmpty ? "no-text-found" : "vision-ocr", pages: 1), exit: 0)
}

let arguments = CommandLine.arguments
guard arguments.count == 2 else {
    fail("usage: mail-extract <file>")
}

let url = URL(fileURLWithPath: arguments[1])
guard FileManager.default.fileExists(atPath: url.path) else {
    fail("no file at that path")
}

switch url.pathExtension.lowercased() {
case "pdf":
    extractPdf(url)
default:
    extractImage(url)
}
