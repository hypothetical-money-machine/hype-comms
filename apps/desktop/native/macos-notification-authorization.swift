import AppKit
import Foundation
import UserNotifications

private let expectedBundleIdentifier = "com.hypotheticalmoneymachine.hmmchat"

private struct AuthorizationState: Encodable {
  let permission: String
  let version = 1
}

private enum AuthorizationError: LocalizedError {
  case invalidArguments
  case invalidBundleIdentity

  var errorDescription: String? {
    switch self {
    case .invalidArguments: "Expected status or request"
    case .invalidBundleIdentity: "Notification authorization must run from the Hype Comms bundle"
    }
  }
}

private func permission() async -> String {
  let settings = await UNUserNotificationCenter.current().notificationSettings()
  switch settings.authorizationStatus {
  case .authorized, .provisional, .ephemeral: return "granted"
  case .denied: return "denied"
  case .notDetermined: return "unknown"
  @unknown default: return "unknown"
  }
}

private func printPermission() async throws {
  let data = try JSONEncoder().encode(AuthorizationState(permission: await permission()))
  guard let value = String(data: data, encoding: .utf8) else {
    throw CocoaError(.fileWriteInapplicableStringEncoding)
  }
  print(value)
}

private func requestPermission() async throws {
  if await permission() == "unknown" {
    _ = try await UNUserNotificationCenter.current().requestAuthorization(
      options: [.alert, .badge, .sound]
    )
  }
  try await printPermission()
}

@main
private enum MacosNotificationAuthorization {
  static func main() async {
    do {
      guard Bundle.main.bundleIdentifier == expectedBundleIdentifier else {
        throw AuthorizationError.invalidBundleIdentity
      }
      let application = NSApplication.shared
      application.setActivationPolicy(.accessory)
      application.finishLaunching()

      let arguments = Array(CommandLine.arguments.dropFirst())
      if arguments == ["status"] {
        try await printPermission()
      } else if arguments == ["request"] {
        try await requestPermission()
      } else {
        throw AuthorizationError.invalidArguments
      }
    } catch {
      FileHandle.standardError.write(
        Data("Hype Comms notification authorization: \(error.localizedDescription)\n".utf8)
      )
      exit(1)
    }
  }
}
