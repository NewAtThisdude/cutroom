// SPDX-License-Identifier: GPL-3.0-or-later
// Effects-pack expressions on the GPU (Metal) for the export: raw planar frames (gbrp, or gbrap with alpha) in on stdin,
// out on stdout. ffmpeg's geq ran the same expressions on the CPU, interpreted per pixel: 3 s of 1080p took 25 s to
// 2.5 minutes with every core busy. server.py (msl_effects) compiles each expression to a Metal kernel fx0, fx1, ...
// in the order they apply; each runs on its own frames [a, b).
//   fxgpu <width> <height> <planes 3|4> <kernels.metal> <a,b;a,b;...>
import Foundation
import Metal

let arg = CommandLine.arguments
guard arg.count == 6, let W = Int(arg[1]), let H = Int(arg[2]), let P = Int(arg[3]), P == 3 || P == 4 else {
    FileHandle.standardError.write("usage: fxgpu W H planes kernels.metal a,b;a,b\n".data(using: .utf8)!)
    exit(2)
}
let wins: [(Int, Int)] = arg[5].split(separator: ";").map { s in
    let q = s.split(separator: ",").map { Int($0)! }
    return (q[0], q[1])
}
guard let dev = MTLCreateSystemDefaultDevice(), let queue = dev.makeCommandQueue() else {
    FileHandle.standardError.write("fxgpu: no Metal device\n".data(using: .utf8)!)
    exit(3)
}
let pipes: [MTLComputePipelineState]
do {
    let lib = try dev.makeLibrary(source: try String(contentsOfFile: arg[4], encoding: .utf8), options: nil)
    pipes = try wins.indices.map { try dev.makeComputePipelineState(function: lib.makeFunction(name: "fx\($0)")!) }
} catch {
    FileHandle.standardError.write("fxgpu: \(error)\n".data(using: .utf8)!)
    exit(4)
}
let n = W * H * P
// two sets of ping-pong buffers: the next frame is read while the GPU works on this one
let sets = (0..<2).map { _ in (0..<2).map { _ in dev.makeBuffer(length: n, options: .storageModeShared)! } }

func io(_ fd: Int32, _ p: UnsafeMutableRawPointer, _ len: Int, write w: Bool) -> Bool {
    var done = 0
    while done < len {
        let r = w ? Darwin.write(fd, p + done, len - done) : Darwin.read(fd, p + done, len - done)
        if r <= 0 { return false }
        done += r
    }
    return true
}

var frame = 0, slot = 0
var pending: (MTLCommandBuffer?, MTLBuffer)? = nil
func flush() {
    if let (cb, out) = pending {
        cb?.waitUntilCompleted()
        if let cb = cb, cb.status == .error { FileHandle.standardError.write("fxgpu: \(cb.error!)\n".data(using: .utf8)!); exit(5) }
        if !io(1, out.contents(), n, write: true) { exit(0) }  // the reader went away
        pending = nil
    }
}
while io(0, sets[slot][0].contents(), n, write: false) {
    var cur = 0
    let on = wins.indices.filter { frame >= wins[$0].0 && frame < wins[$0].1 }
    var cb: MTLCommandBuffer? = nil
    if !on.isEmpty {
        cb = queue.makeCommandBuffer()!
        for i in on {
            let e = cb!.makeComputeCommandEncoder()!
            e.setComputePipelineState(pipes[i])
            e.setBuffer(sets[slot][cur], offset: 0, index: 0)
            e.setBuffer(sets[slot][1 - cur], offset: 0, index: 1)
            var d = SIMD4<Int32>(Int32(W), Int32(H), Int32(P), Int32(frame - wins[i].0))
            e.setBytes(&d, length: MemoryLayout<SIMD4<Int32>>.size, index: 2)
            e.dispatchThreads(MTLSize(width: W, height: H, depth: 1), threadsPerThreadgroup: MTLSize(width: 16, height: 16, depth: 1))
            e.endEncoding()
            cur = 1 - cur
        }
        cb!.commit()
    }
    flush()  // the previous frame goes out while this one computes
    pending = (cb, sets[slot][cur])
    slot = 1 - slot
    frame += 1
}
flush()
