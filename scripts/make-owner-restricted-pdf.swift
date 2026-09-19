// Regenerates src/lib/__fixtures__/pdf-owner-restricted.pdf: a PDF that OPENS
// WITHOUT A PASSWORD but carries an owner password and grants no permissions
// (no copying, printing or editing) — written by Apple's PDFKit, a real
// producer, rather than hand-built. The input was a headless-Chrome print of a
// synthetic rates table; nothing in it is real data.
//
//   swift scripts/make-owner-restricted-pdf.swift in.pdf out.pdf
import PDFKit
let a = CommandLine.arguments
guard let doc = PDFDocument(url: URL(fileURLWithPath: a[1])) else { fatalError("open") }
// Owner password only: opens with no password, but copying, printing and editing are restricted.
let opts: [PDFDocumentWriteOption: Any] = [
  .ownerPasswordOption: "owner-secret-\(Int.random(in: 1000...9999))",
  .accessPermissionsOption: NSNumber(value: 0),   // no permissions granted
]
guard doc.write(to: URL(fileURLWithPath: a[2]), withOptions: opts) else { fatalError("write") }
let out = PDFDocument(url: URL(fileURLWithPath: a[2]))!
print("encrypted=\(out.isEncrypted) locked=\(out.isLocked) allowsCopying=\(out.allowsCopying) allowsPrinting=\(out.allowsPrinting) allowsContentAccessibility=\(out.allowsContentAccessibility)")
