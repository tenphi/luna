// SpeechHelper.swift — on-device speech recognition for Luna's inbound voice messages.
//
// Three subcommands, all answering on stdout as one JSON object:
//
//   probe                          what this Mac can actually recognise, and whether we may
//   authorize                      request Speech Recognition from TCC (needs a GUI session)
//   transcribe <file> <locale>     recognise one audio file
//
// Errors are `{"error":"..."}` with exit 1, so the Node side never has to parse prose.
//
// The audio must already be in a format AVFoundation reads — the caller converts, because
// Telegram voice notes are Ogg/Opus and AVFoundation does not open those. See ../audio.ts.
//
// TCC attributes Speech Recognition to the *responsible* process. Run from a bare launchd
// `node`, that is a version-specific node binary with no stable identity and no way to show a
// prompt; run from inside Luna.app it is the bundle, which is why app-bundle.ts embeds and
// ad-hoc-signs this binary next to calendar-helper.

import AVFoundation
import Foundation
import Speech

func emit(_ json: String) -> Never {
  print(json)
  exit(0)
}

func fail(_ message: String) -> Never {
  let escaped =
    message
    .replacingOccurrences(of: "\\", with: "\\\\")
    .replacingOccurrences(of: "\"", with: "\\\"")
    .replacingOccurrences(of: "\n", with: " ")
  print("{\"error\":\"\(escaped)\"}")
  exit(1)
}

func jsonString(_ value: String) -> String {
  let escaped =
    value
    .replacingOccurrences(of: "\\", with: "\\\\")
    .replacingOccurrences(of: "\"", with: "\\\"")
    .replacingOccurrences(of: "\n", with: "\\n")
    .replacingOccurrences(of: "\r", with: "\\r")
    .replacingOccurrences(of: "\t", with: "\\t")
  return "\"\(escaped)\""
}

func authorizationName(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
  switch status {
  case .authorized: return "authorized"
  case .denied: return "denied"
  case .restricted: return "restricted"
  case .notDetermined: return "notDetermined"
  @unknown default: return "unknown"
  }
}

/// What each requested locale can do here. `onDevice` is the one that decides routing: a locale
/// without a downloaded asset can only be recognised by sending the audio to Apple, which is not
/// a thing a personal assistant should do quietly.
func describeLocales(_ requested: [String]) -> String {
  let supported = Set(SFSpeechRecognizer.supportedLocales().map { $0.identifier })
  // Apple reports `ru-RU`; a caller writing `ru_RU` means the same locale.
  let ids = requested.isEmpty ? supported.sorted() : requested
  let entries = ids.map { id -> String in
    let normalized = id.replacingOccurrences(of: "_", with: "-")
    let recognizer = SFSpeechRecognizer(locale: Locale(identifier: normalized))
    let onDevice = recognizer?.supportsOnDeviceRecognition ?? false
    let available = recognizer?.isAvailable ?? false
    return """
      {"locale":\(jsonString(normalized)),"supported":\(supported.contains(normalized)),\
      "onDevice":\(onDevice),"available":\(available)}
      """
  }
  return "[\(entries.joined(separator: ","))]"
}

func runProbe(_ requested: [String]) -> Never {
  let status = authorizationName(SFSpeechRecognizer.authorizationStatus())
  emit("{\"authorization\":\(jsonString(status)),\"locales\":\(describeLocales(requested))}")
}

func runAuthorize(_ requested: [String]) -> Never {
  let semaphore = DispatchSemaphore(value: 0)
  var result: SFSpeechRecognizerAuthorizationStatus = .notDetermined
  SFSpeechRecognizer.requestAuthorization { status in
    result = status
    semaphore.signal()
  }
  // A prompt the user never answers must not wedge a launchd job forever.
  if semaphore.wait(timeout: .now() + 120) == .timedOut {
    fail("the Speech Recognition prompt was not answered")
  }
  emit(
    "{\"authorization\":\(jsonString(authorizationName(result))),\"locales\":\(describeLocales(requested))}"
  )
}

/// Mean per-segment confidence, which is the only quality signal the API gives us.
///
/// Worth knowing before trusting it: on-device results routinely report 0 for every segment, so
/// this is usable as "did it hear anything" and not as "is this the right language". Luna does
/// not route languages on it — see the backend selection in ../transcribe.ts.
func meanConfidence(_ transcription: SFTranscription) -> Float {
  let scores = transcription.segments.map { $0.confidence }
  guard !scores.isEmpty else { return 0 }
  return scores.reduce(0, +) / Float(scores.count)
}

func runTranscribe(file: String, locale: String, onDevice: Bool, timeout: Double) -> Never {
  let url = URL(fileURLWithPath: file)
  guard FileManager.default.fileExists(atPath: url.path) else {
    fail("no audio file at \(url.path)")
  }

  let status = SFSpeechRecognizer.authorizationStatus()
  guard status == .authorized else {
    fail("speech recognition is \(authorizationName(status))")
  }

  let normalized = locale.replacingOccurrences(of: "_", with: "-")
  guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: normalized)) else {
    fail("no recogniser for locale \(normalized)")
  }
  guard recognizer.isAvailable else {
    fail("the recogniser for \(normalized) is not available")
  }
  if onDevice && !recognizer.supportsOnDeviceRecognition {
    // Refused rather than silently downgraded: the whole reason to ask for on-device is that the
    // audio must not leave the machine, and a quiet fallback would send it anyway.
    fail("locale \(normalized) has no on-device asset")
  }

  let request = SFSpeechURLRecognitionRequest(url: url)
  request.shouldReportPartialResults = false
  request.requiresOnDeviceRecognition = onDevice
  if #available(macOS 13.0, *) {
    request.addsPunctuation = true
  }

  let semaphore = DispatchSemaphore(value: 0)
  var transcript: String?
  var confidence: Float = 0
  var failure: String?

  let task = recognizer.recognitionTask(with: request) { result, error in
    if let error = error {
      failure = error.localizedDescription
      semaphore.signal()
      return
    }
    guard let result = result, result.isFinal else { return }
    transcript = result.bestTranscription.formattedString
    confidence = meanConfidence(result.bestTranscription)
    semaphore.signal()
  }

  if semaphore.wait(timeout: .now() + timeout) == .timedOut {
    task.cancel()
    fail("recognition did not finish within \(Int(timeout))s")
  }
  if let failure = failure {
    fail(failure)
  }

  let text = (transcript ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
  emit(
    """
    {"text":\(jsonString(text)),"confidence":\(confidence),\
    "locale":\(jsonString(normalized)),"onDevice":\(onDevice)}
    """
  )
}

// ─── Arguments ──────────────────────────────────────────────────────────────

var args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else {
  fail("usage: speech-helper probe|authorize|transcribe <file> <locale> [--on-device] [--timeout s]")
}
args = Array(args.dropFirst())

func flagValue(_ name: String) -> String? {
  guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
  return args[index + 1]
}

let requestedLocales = (flagValue("--locales") ?? "")
  .split(separator: ",")
  .map { $0.trimmingCharacters(in: .whitespaces) }
  .filter { !$0.isEmpty }

switch command {
case "probe":
  runProbe(requestedLocales)
case "authorize":
  runAuthorize(requestedLocales)
case "transcribe":
  let positional = args.filter { !$0.hasPrefix("--") }
  guard positional.count >= 2 else {
    fail("transcribe needs <file> <locale>")
  }
  let timeout = Double(flagValue("--timeout") ?? "") ?? 120
  runTranscribe(
    file: positional[0],
    locale: positional[1],
    onDevice: args.contains("--on-device"),
    timeout: timeout
  )
default:
  fail("unknown command \(command)")
}
