// matte <input video> <output.mov> [fast|balanced|accurate]
// Person cut-out via Vision -> ProRes 4444 with straight alpha, upright, source PTS.
import AVFoundation
import CoreImage.CIFilterBuiltins
import Vision

func fail(_ why: String) -> Never {
    FileHandle.standardError.write(Data("matte: \(why)\n".utf8))
    exit(1)
}

let args = CommandLine.arguments
let levels: [String: VNGeneratePersonSegmentationRequest.QualityLevel] = ["fast": .fast, "balanced": .balanced, "accurate": .accurate]
guard (3...4).contains(args.count), let level = levels[args.count == 4 ? args[3] : "balanced"] else {
    fail("usage: matte <input video> <output.mov> [fast|balanced|accurate]")
}
let src = URL(fileURLWithPath: args[1]), dst = URL(fileURLWithPath: args[2])
guard FileManager.default.fileExists(atPath: src.path) else { fail("input not found: \(src.path)") }
guard src.resolvingSymlinksInPath() != dst.resolvingSymlinksInPath() else { fail("output would overwrite the input") }

do {
    let asset = AVURLAsset(url: src)
    guard let track = try await asset.loadTracks(withMediaType: .video).first else { fail("no video track in \(src.path)") }
    let (size, t, range, timescale) = try await track.load(.naturalSize, .preferredTransform, .timeRange, .naturalTimeScale)
    let gaps = try await track.load(.segments).filter(\.isEmpty).map(\.timeMapping.target)  // empty edits
    // preferredTransform is y-down; Core Image is y-up, so conjugate by a y-flip, then move the result to the origin.
    let flipped = CGAffineTransform(a: t.a, b: -t.b, c: -t.c, d: t.d, tx: 0, ty: 0)
    let box = CGRect(origin: .zero, size: size).applying(flipped)
    let upright = flipped.concatenating(CGAffineTransform(translationX: -box.minX, y: -box.minY))
    let w = Int(box.width.rounded()), h = Int(box.height.rounded())
    let frame = CGRect(x: 0, y: 0, width: w, height: h)

    // Half-float RGBA end to end: 10-bit (HDR) sources keep their precision; 8-bit BGRA would band them.
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_64RGBAHalf])
    reader.add(output)

    try? FileManager.default.removeItem(at: dst)
    let writer = try AVAssetWriter(outputURL: dst, fileType: .mov)
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.proRes4444, AVVideoWidthKey: w, AVVideoHeightKey: h])
    input.mediaTimeScale = timescale
    writer.movieTimeScale = timescale  // the default 600 rounds a leading empty edit, shifting every PTS
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_64RGBAHalf,
        kCVPixelBufferWidthKey as String: w, kCVPixelBufferHeightKey as String: h,
        kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any]()])
    writer.add(input)
    guard reader.startReading() else { fail("cannot decode \(src.path): \(reader.error?.localizedDescription ?? "unknown error")") }
    guard writer.startWriting(), let pool = adaptor.pixelBufferPool else {
        fail("cannot write \(dst.path): \(writer.error?.localizedDescription ?? "unknown error")")
    }
    writer.startSession(atSourceTime: .zero)

    let request = VNGeneratePersonSegmentationRequest()
    request.qualityLevel = level
    request.outputPixelFormat = kCVPixelFormatType_OneComponent8
    let vision = VNSequenceRequestHandler()  // stateful: smooths the mask across frames
    let context = CIContext(options: [.workingColorSpace: NSNull(), .outputColorSpace: NSNull()])  // pixels pass through untouched
    var lastReport = Date.distantPast

    while let sample = output.copyNextSampleBuffer() {
        let pts = CMSampleBufferGetPresentationTimeStamp(sample)
        // The reader fills empty edits with a frame the source doesn't have; skip it to keep frame count and PTS.
        guard let pixels = CMSampleBufferGetImageBuffer(sample), !gaps.contains(where: { $0.containsTime(pts) }) else { continue }
        let image = CIImage(cvPixelBuffer: pixels).transformed(by: upright)
        try vision.perform([request], on: image)
        guard let maskPixels = request.results?.first?.pixelBuffer else { fail("no mask at \(pts.seconds)s") }
        let mask = CIImage(cvPixelBuffer: maskPixels)
        let scale = CIFilter.bicubicScaleTransform()
        scale.inputImage = mask.clampedToExtent()  // no fade-out at the frame border
        scale.scale = Float(CGFloat(h) / mask.extent.height)
        scale.aspectRatio = Float(CGFloat(w) / mask.extent.width) / scale.scale
        let blend = CIFilter.blendWithRedMask()
        blend.inputImage = image
        blend.backgroundImage = CIImage.empty()
        blend.maskImage = scale.outputImage?.cropped(to: frame)
        var buffer: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer)
        guard let buffer, let matte = blend.outputImage else { fail("render setup failed at \(pts.seconds)s") }
        // ffmpeg overlay assumes straight alpha. This tag makes Core Image un-premultiply on render (measured:
        // without it the file is premultiplied; adding unpremultiplyingAlpha() too would divide twice).
        CVBufferSetAttachment(buffer, kCVImageBufferAlphaChannelModeKey, kCVImageBufferAlphaChannelMode_StraightAlpha, .shouldPropagate)
        // The encoder converts RGB->Y'CbCr with the buffer's colour tags; copy the decoder's so the values pass
        // through untouched (measured: without this BT.601 and BT.2020/HLG sources shift colour).
        for key in [kCVImageBufferYCbCrMatrixKey, kCVImageBufferColorPrimariesKey, kCVImageBufferTransferFunctionKey] {
            if let tag = CVBufferCopyAttachment(pixels, key, nil) { CVBufferSetAttachment(buffer, key, tag, .shouldPropagate) }
        }
        context.render(matte, to: buffer)
        while !input.isReadyForMoreMediaData && writer.status == .writing { usleep(1000) }
        guard adaptor.append(buffer, withPresentationTime: pts) else {
            fail("encode failed at \(pts.seconds)s: \(writer.error?.localizedDescription ?? "unknown error")")
        }
        if Date().timeIntervalSince(lastReport) >= 0.1 {
            lastReport = Date()
            print(String(format: "progress %.3f", min(max((pts - range.start).seconds / range.duration.seconds, 0), 1)))
            fflush(stdout)
        }
    }
    guard reader.status == .completed else { fail("decode failed: \(reader.error?.localizedDescription ?? "unknown error")") }
    input.markAsFinished()
    writer.endSession(atSourceTime: range.end)
    await writer.finishWriting()
    guard writer.status == .completed else { fail("finish failed: \(writer.error?.localizedDescription ?? "unknown error")") }
    print("progress 1.000")
} catch {
    fail(error.localizedDescription)
}
