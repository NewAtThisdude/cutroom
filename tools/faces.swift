// faces: faces over time with Apple Vision, for auto-reframe (CapCut's "Auto reframe") and blur-all-faces, on-device.
// usage: faces <video> <t0> <t1> [samples per second] [largest|all|salient]
// largest: {"t","x","y","w","h"} per sampled frame that has a face (normalized, top-left origin, display orientation)
// all: {"t","f":[[x,y,w,h],...]} per sampled frame, faces or not; salient: the same with Vision's objectness-based
// saliency boxes (the attention-based one where it finds no object) as [x,y,w,h,confidence]
import AVFoundation
import CoreMedia
import Vision

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(1)
}

let a = CommandLine.arguments
guard a.count >= 4, let t0 = Double(a[2]), let t1 = Double(a[3]) else { fail("usage: faces <video> <t0> <t1> [per second]") }
let every = 1.0 / max(1.0, a.count > 4 ? Double(a[4]) ?? 5 : 5), mode = a.count > 5 ? a[5] : "largest"
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
    let h = VNImageRequestHandler(cvPixelBuffer: px, orientation: orient)
    let box = { (b: CGRect) in String(format: "[%.5f,%.5f,%.5f,%.5f", b.minX, 1 - b.maxY, b.width, b.height) }
    if mode == "salient" {
        var objs: [VNRectangleObservation] = []
        for r in [VNGenerateObjectnessBasedSaliencyImageRequest(), VNGenerateAttentionBasedSaliencyImageRequest()] as [VNImageBasedRequest] where objs.isEmpty {
            try? h.perform([r])
            objs = (r.results?.first as? VNSaliencyImageObservation)?.salientObjects ?? []
        }
        print(String(format: "{\"t\":%.4f,\"f\":[", t) + objs.map { box($0.boundingBox) + String(format: ",%.3f]", $0.confidence) }.joined(separator: ",") + "]}")
        fflush(stdout)
        continue
    }
    let req = VNDetectFaceRectanglesRequest()
    try? h.perform([req])
    if mode == "all" {
        print(String(format: "{\"t\":%.4f,\"f\":[", t) + (req.results ?? []).map { box($0.boundingBox) + "]" }.joined(separator: ",") + "]}")
        fflush(stdout)
        continue
    }
    guard let f = (req.results ?? []).max(by: { $0.boundingBox.width * $0.boundingBox.height < $1.boundingBox.width * $1.boundingBox.height }) else { continue }
    let b = f.boundingBox
    print(String(format: "{\"t\":%.4f,\"x\":%.5f,\"y\":%.5f,\"w\":%.5f,\"h\":%.5f}", t, b.minX, 1 - b.maxY, b.width, b.height))
    fflush(stdout)
}
