// faces: largest face over time with Apple Vision, for auto-reframe (CapCut's "Auto reframe"), on-device.
// usage: faces <video> <t0> <t1> [samples per second]
// prints {"t","x","y","w","h"} per sampled frame that has a face (normalized, top-left origin, display orientation)
import AVFoundation
import CoreMedia
import Vision

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(1)
}

let a = CommandLine.arguments
guard a.count >= 4, let t0 = Double(a[2]), let t1 = Double(a[3]) else { fail("usage: faces <video> <t0> <t1> [per second]") }
let every = 1.0 / max(1.0, a.count > 4 ? Double(a[4]) ?? 5 : 5)
let asset = AVURLAsset(url: URL(fileURLWithPath: a[1]))
guard let vt = asset.tracks(withMediaType: .video).first else { fail("no video track") }
let tf = vt.preferredTransform
let orient: CGImagePropertyOrientation =
    tf.a == 0 && tf.b == 1 && tf.c == -1 && tf.d == 0 ? .right :
    tf.a == 0 && tf.b == -1 && tf.c == 1 && tf.d == 0 ? .left :
    tf.a == -1 && tf.d == -1 ? .down : .up

guard let reader = try? AVAssetReader(asset: asset) else { fail("cannot read video") }
let out = AVAssetReaderTrackOutput(track: vt, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
out.alwaysCopiesSampleData = false
reader.add(out)
reader.timeRange = CMTimeRange(start: CMTime(seconds: t0, preferredTimescale: 600), end: CMTime(seconds: max(t1, t0 + 0.05), preferredTimescale: 600))
guard reader.startReading() else { fail(reader.error?.localizedDescription ?? "cannot start reading") }

var next = -Double.infinity
while let sb = out.copyNextSampleBuffer() {
    let t = CMSampleBufferGetPresentationTimeStamp(sb).seconds
    guard t >= next, let px = CMSampleBufferGetImageBuffer(sb) else { continue }
    next = t + every
    let req = VNDetectFaceRectanglesRequest()
    try? VNImageRequestHandler(cvPixelBuffer: px, orientation: orient).perform([req])
    guard let f = (req.results ?? []).max(by: { $0.boundingBox.width * $0.boundingBox.height < $1.boundingBox.width * $1.boundingBox.height }) else { continue }
    let b = f.boundingBox
    print(String(format: "{\"t\":%.4f,\"x\":%.5f,\"y\":%.5f,\"w\":%.5f,\"h\":%.5f}", t, b.minX, 1 - b.maxY, b.width, b.height))
    fflush(stdout)
}
