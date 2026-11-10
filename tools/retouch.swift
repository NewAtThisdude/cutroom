// retouch: face landmarks (Vision, 76 points) and body pose for every frame of a range, for ai/retouch.py (CapCut's
// face and body retouch), on this Mac.
// usage: retouch <video> <t0> <t1>     or     retouch <image>
// prints one JSON line per frame: {"t", "faces": [{"box": [x, y, w, h], "pts": {region: [x, y, ...]}}], "bodies": [{joint: [x, y, conf]}]}
// coordinates normalized to the picture as shown (top-left origin, display orientation)
import AVFoundation
import CoreMedia
import ImageIO
import Vision

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(1)
}

let regions: [(String, (VNFaceLandmarks2D) -> VNFaceLandmarkRegion2D?)] = [
    ("contour", { $0.faceContour }), ("leye", { $0.leftEye }), ("reye", { $0.rightEye }), ("lbrow", { $0.leftEyebrow }),
    ("rbrow", { $0.rightEyebrow }), ("nose", { $0.nose }), ("crest", { $0.noseCrest }), ("median", { $0.medianLine }),
    ("olips", { $0.outerLips }), ("ilips", { $0.innerLips }), ("lpupil", { $0.leftPupil }), ("rpupil", { $0.rightPupil }),
]

func detect(_ handler: VNImageRequestHandler, _ t: Double) {
    let face = VNDetectFaceLandmarksRequest()
    face.constellation = .constellation76Points
    let body = VNDetectHumanBodyPoseRequest()
    do { try handler.perform([face, body]) } catch { FileHandle.standardError.write("vision: \(error)\n".data(using: .utf8)!) }
    var fs: [String] = []
    for f in face.results ?? [] {
        guard let lm = f.landmarks else { continue }
        let b = f.boundingBox
        var rs: [String] = []
        for (name, get) in regions {
            guard let r = get(lm) else { continue }
            let xy = r.normalizedPoints.map { String(format: "%.5f,%.5f", b.minX + $0.x * b.width, 1 - (b.minY + $0.y * b.height)) }
            rs.append("\"\(name)\":[\(xy.joined(separator: ","))]")
        }
        fs.append(String(format: "{\"box\":[%.5f,%.5f,%.5f,%.5f],\"pts\":{", b.minX, 1 - b.maxY, b.width, b.height) + rs.joined(separator: ",") + "}}")
    }
    var bs: [String] = []
    for o in body.results ?? [] {
        guard let pts = try? o.recognizedPoints(.all) else { continue }
        let js = pts.filter { $0.value.confidence > 0.1 }.map { String(format: "\"%@\":[%.5f,%.5f,%.3f]", $0.key.rawValue.rawValue, $0.value.location.x, 1 - $0.value.location.y, $0.value.confidence) }
        if !js.isEmpty { bs.append("{" + js.joined(separator: ",") + "}") }
    }
    print(String(format: "{\"t\":%.6f,", t) + "\"faces\":[\(fs.joined(separator: ","))],\"bodies\":[\(bs.joined(separator: ","))]}")
    fflush(stdout)
}

let a = CommandLine.arguments
guard a.count == 2 || a.count >= 4 else { fail("usage: retouch <video> <t0> <t1> | retouch <image>") }
let url = URL(fileURLWithPath: a[1])
if a.count == 2 {
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil), let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { fail("cannot read the picture") }
    detect(VNImageRequestHandler(cgImage: img), 0)
    exit(0)
}
guard let t0 = Double(a[2]), let t1 = Double(a[3]) else { fail("bad times") }
let asset = AVURLAsset(url: url)
guard let vt = asset.tracks(withMediaType: .video).first else { fail("no video track") }
let tf = vt.preferredTransform
let orient: CGImagePropertyOrientation =
    tf.a == 0 && tf.b == 1 && tf.c == -1 && tf.d == 0 ? .right :
    tf.a == 0 && tf.b == -1 && tf.c == 1 && tf.d == 0 ? .left :
    tf.a == -1 && tf.d == -1 ? .down : .up
guard let reader = try? AVAssetReader(asset: asset) else { fail("cannot read video") }
// Vision works on ~1 MP anyway: decoding 4K at full size only costs time
let sz = vt.naturalSize, k = min(1.0, 1280 / max(sz.width, sz.height))
let out = AVAssetReaderTrackOutput(track: vt, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                                                               kCVPixelBufferWidthKey as String: Int(sz.width * k) / 2 * 2,
                                                               kCVPixelBufferHeightKey as String: Int(sz.height * k) / 2 * 2])
out.alwaysCopiesSampleData = false
reader.add(out)
reader.timeRange = CMTimeRange(start: CMTime(seconds: t0, preferredTimescale: 6000), end: CMTime(seconds: max(t1, t0 + 0.05), preferredTimescale: 6000))
guard reader.startReading() else { fail(reader.error?.localizedDescription ?? "cannot start reading") }
while let sb = out.copyNextSampleBuffer() {
    guard let px = CMSampleBufferGetImageBuffer(sb) else { continue }
    autoreleasepool { detect(VNImageRequestHandler(cvPixelBuffer: px, orientation: orient), CMSampleBufferGetPresentationTimeStamp(sb).seconds) }
}
if reader.status == .failed { fail(reader.error?.localizedDescription ?? "reading failed") }
