// track: follow a box through a video with Apple Vision (CapCut's "Tracking"), on-device.
// usage: track <video> <t0> <t1> <x> <y> <w> <h>
//   box = normalized, top-left origin, display orientation (what the user sees)
// prints one JSON line per frame {"t","x","y","w","h","c"} in source seconds; {"lost":true} when confidence < 0.3
import AVFoundation
import CoreMedia
import Vision

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(1)
}

let a = CommandLine.arguments
guard a.count == 8, let t0 = Double(a[2]), let t1 = Double(a[3]), let bx = Double(a[4]), let by = Double(a[5]),
      let bw = Double(a[6]), let bh = Double(a[7]), bw > 0, bh > 0 else {
    fail("usage: track <video> <t0> <t1> <x> <y> <w> <h>")
}
let asset = AVURLAsset(url: URL(fileURLWithPath: a[1]))
guard let vt = asset.tracks(withMediaType: .video).first else { fail("no video track") }
let tf = vt.preferredTransform  // map the stored frame to display orientation for Vision
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

let handler = VNSequenceRequestHandler()
var last = VNDetectedObjectObservation(boundingBox: CGRect(x: bx, y: 1 - by - bh, width: bw, height: bh))  // Vision: bottom-left origin
while let sb = out.copyNextSampleBuffer() {
    guard let px = CMSampleBufferGetImageBuffer(sb) else { continue }
    let req = VNTrackObjectRequest(detectedObjectObservation: last)
    req.trackingLevel = .accurate
    do { try handler.perform([req], on: px, orientation: orient) } catch { fail("tracking failed: \(error.localizedDescription)") }
    guard let o = req.results?.first as? VNDetectedObjectObservation else { break }
    let b = o.boundingBox, t = CMSampleBufferGetPresentationTimeStamp(sb).seconds
    print(String(format: "{\"t\":%.4f,\"x\":%.5f,\"y\":%.5f,\"w\":%.5f,\"h\":%.5f,\"c\":%.3f}", t, b.minX, 1 - b.maxY, b.width, b.height, o.confidence))
    fflush(stdout)
    if o.confidence < 0.3 { print("{\"lost\":true}"); break }
    last = o
}
