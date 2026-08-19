// PROTOTYPE — throwaway macOS feasibility probe (ScreenCaptureKit audio-only)
// Answers: can an audio-only SCStream capture global system audio on this host?
// Evidence collection only. NEVER writes user audio to disk. No persistence.
//
// Usage:
//   swiftc -O -o scprobe scprobe.swift
//   ./scprobe [--exclude-self] [--play-self-audio] [--seconds N]
//
// --exclude-self      sets SCStreamConfiguration.excludesCurrentProcessAudio = true (F-06)
// --play-self-audio   plays a 440Hz test tone from THIS process during capture (F-06)
// --seconds N         capture duration (default 8)

import ScreenCaptureKit
import CoreMedia
import AVFoundation
import Foundation

let excludeSelf = CommandLine.arguments.contains("--exclude-self")
let playSelfAudio = CommandLine.arguments.contains("--play-self-audio")
var playerPath = ""
let runSeconds: Double = {
    if let i = CommandLine.arguments.firstIndex(where: { $0 == "--seconds" }),
       let v = Double(CommandLine.arguments[i + 1]) { return v }
    return 8
}()

// ---------- state ----------
struct Probe {
    var audioBuffers = 0
    var audioFrames: Int64 = 0
    var videoBuffers = 0
    var micBuffers = 0
    var bytes: Int64 = 0
    var sampleRate: Double = 0
    var channels = 0
    var firstT = 0.0
    var lastT = 0.0
    var rmsSum = 0.0
    var rmsCount = 0
}
var p = Probe()
let lock = NSLock()

// ---------- output sink (audio only) ----------
final class Out: NSObject, SCStreamOutput, SCStreamDelegate {
    func stream(_ s: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        lock.lock(); defer { lock.unlock() }
        switch type {
        case .audio:
            p.audioBuffers += 1
            if let fmt = CMSampleBufferGetFormatDescription(sb),
               let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fmt) {
                p.sampleRate = asbd.pointee.mSampleRate
                p.channels = Int(asbd.pointee.mChannelsPerFrame)
            }
            p.audioFrames += Int64(CMSampleBufferGetNumSamples(sb))
            let t = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sb))
            if p.firstT == 0 { p.firstT = t }
            p.lastT = t
            if let block = CMSampleBufferGetDataBuffer(sb) {
                var len = 0
                var ptr: UnsafeMutablePointer<Int8>?
                if CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &len, dataPointerOut: &ptr) == kCMBlockBufferNoErr,
                   let ptr = ptr, len > 0 {
                    p.bytes += Int64(len)
                    let count = min(len / 2, 48000)
                    ptr.withMemoryRebound(to: Int16.self, capacity: count) { samples in
                        var sum = 0.0
                        for i in 0..<count {
                            let v = Double(samples[i]) / 32768.0
                            sum += v * v
                        }
                        p.rmsSum += sum / Double(count)
                        p.rmsCount += 1
                    }
                }
            }
        case .screen:      p.videoBuffers += 1
        case .microphone:  p.micBuffers += 1
        @unknown default: break
        }
    }
    func stream(_ s: SCStream, didStopWithError error: Error) {
        print("EVT stream_did_stop_with_error: \(error)")
    }
}

// ---------- tiny WAV writer (test tone only, deleted after run) ----------
func generateSineWav(path: String, freq: Double, seconds: Double, rate: Int = 48000) {
    let n = Int(Double(rate) * seconds)
    var data = Data()
    for i in 0..<n {
        let v = Int16(sin(2.0 * Double.pi * freq * Double(i) / Double(rate)) * 0.4 * 32767.0)
        data.append(contentsOf: [UInt8(v & 0xff), UInt8((v >> 8) & 0xff)])
    }
    var header = Data()
    func put(_ s: String) { header.append(s.data(using: .ascii)!) }
    func put32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { header.append(contentsOf: $0) } }
    func put16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { header.append(contentsOf: $0) } }
    put("RIFF"); put32(UInt32(36 + data.count)); put("WAVE")
    put("fmt "); put32(16); put16(1); put16(1); put32(UInt32(rate)); put32(UInt32(rate * 2)); put16(2); put16(16)
    put("data"); put32(UInt32(data.count)); header.append(data)
    try? header.write(to: URL(fileURLWithPath: path))
}

var player: AVAudioPlayer?
if playSelfAudio {
    playerPath = NSTemporaryDirectory() + "scprobe-self-\(UUID().uuidString).wav"
    generateSineWav(path: playerPath, freq: 440, seconds: 2)
    if let pl = try? AVAudioPlayer(contentsOf: URL(fileURLWithPath: playerPath)) {
        player = pl
        pl.numberOfLoops = -1
        pl.volume = 0.9
        pl.play()
        print("EVT self_audio_playing")
    }
}

// ---------- async main ----------
func run() async throws {
    // 1) SCShareableContent (TCC probe)
    let content: SCShareableContent
    do {
        content = try await SCShareableContent.current
    } catch {
        print("{\"step\":\"shareable\",\"ok\":false,\"error\":\"\(error)\"}")
        return
    }
    guard let display = content.displays.first else {
        print("{\"step\":\"shareable\",\"ok\":false,\"error\":\"no-display-or-empty-content\"}")
        return
    }
    print("{\"step\":\"shareable\",\"ok\":true,\"displays\":\(content.displays.count),\"apps\":\(content.applications.count),\"windows\":\(content.windows.count)}")
    for d in content.displays { print("  display id=\(d.displayID) \(d.width)x\(d.height)") }
    for a in content.applications.prefix(20) { print("  app pid=\(a.processID) \(a.applicationName)") }

    // 2) audio-only SCStream
    let config = SCStreamConfiguration()
    config.capturesAudio = true
    // capturesVideo defaults to false (audio-only); not exposed in SDK 15
    config.excludesCurrentProcessAudio = excludeSelf
    config.sampleRate = 48000
    config.channelCount = 2
    config.width = 1
    config.height = 1
    config.queueDepth = 16

    let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
    let out = Out()
    let stream = SCStream(filter: filter, configuration: config, delegate: out)
    do {
        // F-07: register ONLY .audio. .screen is deliberately never registered.
        try await stream.addStreamOutput(out, type: .audio, sampleHandlerQueue: DispatchQueue(label: "sc-audio"))
    } catch {
        print("{\"step\":\"add-output\",\"ok\":false,\"error\":\"\(error)\"}")
        return
    }

    do {
        try await stream.startCapture()
    } catch {
        print("{\"step\":\"start\",\"ok\":false,\"error\":\"\(error)\"}")
        return
    }
    print("{\"step\":\"start\",\"ok\":true,\"excludeSelf\":\(excludeSelf),\"playSelfAudio\":\(playSelfAudio)}")

    try await Task.sleep(nanoseconds: UInt64(runSeconds * 1_000_000_000))

    try? await stream.stopCapture()

    player?.stop()
    player = nil
    if !playerPath.isEmpty { try? FileManager.default.removeItem(atPath: playerPath) }

    lock.lock()
    let rmsAvg = p.rmsCount > 0 ? p.rmsSum / Double(p.rmsCount) : 0.0
    let json = """
    {"step":"capture","ok":true,"audioBuffers":\(p.audioBuffers),"audioFrames":\(p.audioFrames),"videoBuffers":\(p.videoBuffers),"micBuffers":\(p.micBuffers),"bytes":\(p.bytes),"sampleRate":\(p.sampleRate),"channels":\(p.channels),"durSec":\(p.lastT - p.firstT),"rmsAvg":\(String(format: "%.6f", rmsAvg))}
    """
    print(json)
    lock.unlock()
}

// top-level async entry
Task {
    try? await run()
}
dispatchMain()
