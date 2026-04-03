import Foundation
import Translation

@objc(LinguaFaceTranslation)
class TranslationBridge: NSObject {

  @objc
  func translate(
    _ text: String,
    from sourceLang: String,
    to targetLang: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    guard #available(iOS 17.4, *) else {
      reject("UNSUPPORTED", "iOS 17.4+ required for on-device translation", nil)
      return
    }

    Task {
      do {
        let source = Locale.Language(identifier: sourceLang)
        let target = Locale.Language(identifier: targetLang)
        let config = TranslationSession.Configuration(source: source, target: target)

        let session = TranslationSession(configuration: config)
        let response = try await session.translate(text)
        resolve(response.targetText)
      } catch {
        reject("TRANSLATION_ERROR", error.localizedDescription, error)
      }
    }
  }

  @objc
  func isLanguagePairAvailable(
    _ sourceLang: String,
    to targetLang: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    guard #available(iOS 17.4, *) else {
      resolve(false)
      return
    }

    Task {
      let source = Locale.Language(identifier: sourceLang)
      let target = Locale.Language(identifier: targetLang)
      let availability = LanguageAvailability()
      let status = await availability.status(from: source, to: target)
      resolve(status == .installed || status == .supported)
    }
  }

  @objc
  static func requiresMainQueueSetup() -> Bool { false }
}
