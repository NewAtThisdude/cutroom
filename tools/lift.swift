// lift: cut the subject(s) out of a still image with Apple Vision's subject lifting (any object, not only people).
// usage: lift in.(png|jpg|heic) out.png   -> PNG, same size, background transparent. Exit 2 = no subject found.
import CoreImage
import Foundation
import Vision

let args = CommandLine.arguments
guard args.count == 3, let image = CIImage(contentsOf: URL(fileURLWithPath: args[1])) else {
    FileHandle.standardError.write("usage: lift in.png out.png\n".data(using: .utf8)!)
    exit(1)
}
let request = VNGenerateForegroundInstanceMaskRequest()
let handler = VNImageRequestHandler(ciImage: image)
do {
    try handler.perform([request])
    guard let result = request.results?.first, !result.allInstances.isEmpty else {
        FileHandle.standardError.write("no subject found\n".data(using: .utf8)!)
        exit(2)
    }
    let masked = try result.generateMaskedImage(ofInstances: result.allInstances, from: handler, croppedToInstancesExtent: false)
    let out = CIImage(cvPixelBuffer: masked)
    try CIContext().writePNGRepresentation(of: out, to: URL(fileURLWithPath: args[2]), format: .RGBA8,
                                           colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
} catch {
    FileHandle.standardError.write("\(error)\n".data(using: .utf8)!)
    exit(1)
}
