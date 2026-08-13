import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

private let syntheticBody = "Synthetic direct message for native notification evidence"

private struct PermissionState: Encodable {
  let accessibility: Bool
  let screenCapture: Bool
}

private enum HelperError: LocalizedError {
  case captureFailed
  case invalidArguments
  case notificationCenterUnavailable
  case notificationNotFound
  case permissionDenied
  case pngDestinationFailed

  var errorDescription: String? {
    switch self {
    case .captureFailed: "ScreenCaptureKit did not return a display image"
    case .invalidArguments:
      "Expected preflight, request, capture <absolute-path>, or click"
    case .notificationCenterUnavailable: "Notification Center is not running"
    case .notificationNotFound: "The synthetic Hype Comms notification was not found"
    case .permissionDenied: "Screen Recording and Accessibility must both be enabled"
    case .pngDestinationFailed: "Could not write the ScreenCaptureKit PNG"
    }
  }
}

private func permissionState() -> PermissionState {
  PermissionState(
    accessibility: AXIsProcessTrusted(),
    screenCapture: CGPreflightScreenCaptureAccess()
  )
}

private func printPermissionState(_ state: PermissionState) throws {
  let data = try JSONEncoder().encode(state)
  guard let value = String(data: data, encoding: .utf8) else {
    throw HelperError.captureFailed
  }
  print(value)
}

private func requestPermissions() throws {
  _ = CGRequestScreenCaptureAccess()
  let options = [
    kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true,
  ] as CFDictionary
  _ = AXIsProcessTrustedWithOptions(options)
  let state = permissionState()
  try printPermissionState(state)
}

private func prepareGuiApplication() {
  let application = NSApplication.shared
  application.setActivationPolicy(.accessory)
  application.finishLaunching()
}

private func copyAttribute(_ element: AXUIElement, _ attribute: CFString) -> CFTypeRef? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else {
    return nil
  }
  return value
}

private func strings(_ element: AXUIElement) -> [String] {
  [kAXTitleAttribute, kAXValueAttribute, kAXDescriptionAttribute, kAXHelpAttribute].compactMap {
    copyAttribute(element, $0 as CFString) as? String
  }
}

private func children(_ element: AXUIElement) -> [AXUIElement] {
  copyAttribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? []
}

private func findSyntheticNotification(
  in element: AXUIElement,
  depth: Int = 0
) -> AXUIElement? {
  guard depth < 40 else { return nil }
  if strings(element).contains(where: { $0.contains(syntheticBody) }) {
    return element
  }
  for child in children(element) {
    if let match = findSyntheticNotification(in: child, depth: depth + 1) {
      return match
    }
  }
  return nil
}

private func pressElementOrAncestor(_ element: AXUIElement) -> Bool {
  var current: AXUIElement? = element
  for _ in 0..<12 {
    guard let candidate = current else { return false }
    var names: CFArray?
    if AXUIElementCopyActionNames(candidate, &names) == .success,
      let actions = names as? [String],
      actions.contains(kAXPressAction)
    {
      return AXUIElementPerformAction(candidate, kAXPressAction as CFString) == .success
    }
    guard let parent = copyAttribute(candidate, kAXParentAttribute as CFString) else {
      return false
    }
    current = (parent as! AXUIElement)
  }
  return false
}

private func clickSyntheticNotification() throws {
  guard AXIsProcessTrusted() else { throw HelperError.permissionDenied }
  let applications = NSWorkspace.shared.runningApplications.filter {
    $0.bundleIdentifier == "com.apple.notificationcenterui" ||
      $0.localizedName == "NotificationCenter"
  }
  guard !applications.isEmpty else { throw HelperError.notificationCenterUnavailable }
  for application in applications {
    let root = AXUIElementCreateApplication(application.processIdentifier)
    if let match = findSyntheticNotification(in: root), pressElementOrAncestor(match) {
      print("notification-clicked")
      return
    }
  }
  throw HelperError.notificationNotFound
}

private func captureScreen(to destination: String) async throws {
  guard destination.hasPrefix("/"), destination != "/" else {
    throw HelperError.invalidArguments
  }
  guard CGPreflightScreenCaptureAccess() else { throw HelperError.permissionDenied }
  let content = try await SCShareableContent.excludingDesktopWindows(
    false,
    onScreenWindowsOnly: true
  )
  guard let display = content.displays.first else { throw HelperError.captureFailed }
  let configuration = SCStreamConfiguration()
  configuration.width = display.width
  configuration.height = display.height
  configuration.showsCursor = false
  let filter = SCContentFilter(display: display, excludingWindows: [])
  let image = try await SCScreenshotManager.captureImage(
    contentFilter: filter,
    configuration: configuration
  )
  let url = URL(fileURLWithPath: destination) as CFURL
  guard
    let png = CGImageDestinationCreateWithURL(
      url,
      UTType.png.identifier as CFString,
      1,
      nil
    )
  else {
    throw HelperError.pngDestinationFailed
  }
  CGImageDestinationAddImage(png, image, nil)
  guard CGImageDestinationFinalize(png) else { throw HelperError.pngDestinationFailed }
}

@main
private enum MacosNativeNotificationEvidenceHelper {
  static func main() async {
    do {
      prepareGuiApplication()
      let arguments = Array(CommandLine.arguments.dropFirst())
      if arguments == ["preflight"] {
        let state = permissionState()
        try printPermissionState(state)
        if !state.accessibility || !state.screenCapture {
          throw HelperError.permissionDenied
        }
      } else if arguments == ["request"] {
        try requestPermissions()
      } else if arguments.count == 2, arguments[0] == "capture" {
        try await captureScreen(to: arguments[1])
      } else if arguments == ["click"] {
        try clickSyntheticNotification()
      } else {
        throw HelperError.invalidArguments
      }
    } catch {
      FileHandle.standardError.write(
        Data("macOS evidence helper: \(error.localizedDescription)\n".utf8)
      )
      exit(1)
    }
  }
}
