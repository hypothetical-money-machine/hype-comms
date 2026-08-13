import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

private let syntheticBody = "Synthetic direct message for native notification evidence"
private let hypeCommsBundleIdentifier = "com.hypotheticalmoneymachine.hmmchat"

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
      "Expected preflight, request, capture notification|application <absolute-path>, or click"
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

private func axPoint(_ element: AXUIElement, _ attribute: CFString) -> CGPoint? {
  guard let rawValue = copyAttribute(element, attribute), CFGetTypeID(rawValue) == AXValueGetTypeID()
  else { return nil }
  var point = CGPoint.zero
  guard AXValueGetValue(rawValue as! AXValue, .cgPoint, &point) else { return nil }
  return point
}

private func axSize(_ element: AXUIElement, _ attribute: CFString) -> CGSize? {
  guard let rawValue = copyAttribute(element, attribute), CFGetTypeID(rawValue) == AXValueGetTypeID()
  else { return nil }
  var size = CGSize.zero
  guard AXValueGetValue(rawValue as! AXValue, .cgSize, &size) else { return nil }
  return size
}

private func frame(_ element: AXUIElement) -> CGRect? {
  guard
    let position = axPoint(element, kAXPositionAttribute as CFString),
    let size = axSize(element, kAXSizeAttribute as CFString),
    size.width > 0,
    size.height > 0
  else { return nil }
  return CGRect(origin: position, size: size)
}

private func notificationApplications() -> [NSRunningApplication] {
  NSWorkspace.shared.runningApplications.filter {
    $0.bundleIdentifier == "com.apple.notificationcenterui" ||
      $0.bundleIdentifier == "com.apple.UserNotificationCenter" ||
      $0.localizedName == "NotificationCenter" ||
      $0.localizedName == "UserNotificationCenter"
  }
}

private func notificationElementAndCropRect() throws -> (AXUIElement, CGRect) {
  let applications = notificationApplications()
  guard !applications.isEmpty else { throw HelperError.notificationCenterUnavailable }
  for application in applications {
    let root = AXUIElementCreateApplication(application.processIdentifier)
    guard let match = findSyntheticNotification(in: root), let initialFrame = frame(match) else {
      continue
    }
    var cropFrame = initialFrame
    var current = match
    for _ in 0..<8 {
      guard
        let rawParent = copyAttribute(current, kAXParentAttribute as CFString),
        CFGetTypeID(rawParent) == AXUIElementGetTypeID()
      else { break }
      let parent = rawParent as! AXUIElement
      guard let parentFrame = frame(parent) else { break }
      if parentFrame.width > 900 || parentFrame.height > 350 { break }
      cropFrame = parentFrame
      current = parent
      if cropFrame.width >= 250 && cropFrame.height >= 80 { break }
    }
    return (match, cropFrame.insetBy(dx: -24, dy: -24))
  }
  throw HelperError.notificationNotFound
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

private func clickSyntheticNotification() async throws {
  guard AXIsProcessTrusted() else { throw HelperError.permissionDenied }
  let applications = notificationApplications()
  guard !applications.isEmpty else { throw HelperError.notificationCenterUnavailable }
  let (match, _) = try await waitForNotificationElementAndCropRect()
  if pressElementOrAncestor(match) {
    print("notification-clicked")
    return
  }
  throw HelperError.notificationNotFound
}

private func waitForNotificationElementAndCropRect() async throws -> (AXUIElement, CGRect) {
  let deadline = Date().addingTimeInterval(15)
  while true {
    do {
      return try notificationElementAndCropRect()
    } catch HelperError.notificationNotFound where Date() < deadline {
      try await Task.sleep(nanoseconds: 200_000_000)
    }
  }
}

private func writePng(_ image: CGImage, to destination: String) throws {
  guard destination.hasPrefix("/"), destination != "/" else {
    throw HelperError.invalidArguments
  }
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

private func captureNotification(to destination: String) async throws {
  guard CGPreflightScreenCaptureAccess(), AXIsProcessTrusted() else {
    throw HelperError.permissionDenied
  }
  let (_, cropFrame) = try await waitForNotificationElementAndCropRect()
  let content = try await SCShareableContent.excludingDesktopWindows(
    false,
    onScreenWindowsOnly: true
  )
  guard
    let display = content.displays.max(by: {
      $0.frame.intersection(cropFrame).width * $0.frame.intersection(cropFrame).height <
        $1.frame.intersection(cropFrame).width * $1.frame.intersection(cropFrame).height
    }),
    !display.frame.intersection(cropFrame).isNull
  else { throw HelperError.captureFailed }
  let configuration = SCStreamConfiguration()
  configuration.width = display.width
  configuration.height = display.height
  configuration.showsCursor = false
  let filter = SCContentFilter(display: display, excludingWindows: [])
  let displayImage = try await SCScreenshotManager.captureImage(
    contentFilter: filter,
    configuration: configuration
  )
  let visibleCrop = cropFrame.intersection(display.frame)
  let scaleX = CGFloat(displayImage.width) / display.frame.width
  let scaleY = CGFloat(displayImage.height) / display.frame.height
  let pixelCrop = CGRect(
    x: (visibleCrop.minX - display.frame.minX) * scaleX,
    y: (visibleCrop.minY - display.frame.minY) * scaleY,
    width: visibleCrop.width * scaleX,
    height: visibleCrop.height * scaleY
  ).integral
  guard let croppedImage = displayImage.cropping(to: pixelCrop) else {
    throw HelperError.captureFailed
  }
  try writePng(croppedImage, to: destination)
}

private func captureApplication(to destination: String) async throws {
  guard CGPreflightScreenCaptureAccess() else { throw HelperError.permissionDenied }
  let content = try await SCShareableContent.excludingDesktopWindows(
    false,
    onScreenWindowsOnly: true
  )
  let windows = content.windows.filter {
    $0.owningApplication?.bundleIdentifier == hypeCommsBundleIdentifier && $0.frame.width > 0 &&
      $0.frame.height > 0
  }
  guard let window = windows.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height })
  else { throw HelperError.captureFailed }
  let configuration = SCStreamConfiguration()
  configuration.width = max(1, Int(window.frame.width * 2))
  configuration.height = max(1, Int(window.frame.height * 2))
  configuration.showsCursor = false
  let filter = SCContentFilter(desktopIndependentWindow: window)
  let image = try await SCScreenshotManager.captureImage(
    contentFilter: filter,
    configuration: configuration
  )
  try writePng(image, to: destination)
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
      } else if arguments.count == 3, arguments[0] == "capture",
        arguments[1] == "notification"
      {
        try await captureNotification(to: arguments[2])
      } else if arguments.count == 3, arguments[0] == "capture",
        arguments[1] == "application"
      {
        try await captureApplication(to: arguments[2])
      } else if arguments == ["click"] {
        try await clickSyntheticNotification()
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
