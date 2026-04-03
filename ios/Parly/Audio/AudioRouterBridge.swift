import Foundation
import AVFoundation

@objc(ParlyAudio)
class AudioRouterBridge: NSObject {

  @objc
  func configureSession(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    do {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(
        .playAndRecord,
        mode: .default,
        options: [.defaultToSpeaker, .allowBluetooth]
      )
      try session.setActive(true)
      resolve(nil)
    } catch {
      reject("AUDIO_SESSION_ERROR", error.localizedDescription, error)
    }
  }

  @objc
  func playPCM(
    _ base64Data: String,
    sampleRate: Double,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let pcmData = Data(base64Encoded: base64Data) else {
      reject("INVALID_DATA", "Could not decode base64 audio data", nil)
      return
    }

    let frameCount = pcmData.count / 2 // Int16 = 2 bytes
    guard let format = AVAudioFormat(
      commonFormat: .pcmFormatInt16,
      sampleRate: sampleRate,
      channels: 1,
      interleaved: false
    ), let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frameCount)) else {
      reject("BUFFER_ERROR", "Could not create audio buffer", nil)
      return
    }

    buffer.frameLength = AVAudioFrameCount(frameCount)
    pcmData.withUnsafeBytes { ptr in
      guard let int16Ptr = ptr.bindMemory(to: Int16.self).baseAddress else { return }
      buffer.int16ChannelData?[0].update(from: int16Ptr, count: frameCount)
    }

    let engine = AVAudioEngine()
    let player = AVAudioPlayerNode()
    engine.attach(player)
    engine.connect(player, to: engine.mainMixerNode, format: format)

    do {
      try engine.start()
      player.scheduleBuffer(buffer) {
        DispatchQueue.main.async { resolve(nil) }
      }
      player.play()
    } catch {
      reject("PLAYBACK_ERROR", error.localizedDescription, error)
    }
  }

  @objc
  static func requiresMainQueueSetup() -> Bool { false }
}
