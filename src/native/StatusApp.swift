import AppKit
import Foundation
import WebKit

final class StatusAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSToolbarDelegate {
  private static let refreshToolbarItemIdentifier = NSToolbarItem.Identifier("ai.model-router.refresh")
  private let dashboardURL: URL
  private let healthURL: URL
  private let appTitle: String
  private let routerBinary: String
  private let configPath: String?
  private var window: NSWindow?
  private var webView: WKWebView?
  private var statusItem: NSStatusItem?

  init(dashboardURL: URL, appTitle: String, routerBinary: String, configPath: String?) {
    self.dashboardURL = dashboardURL
    self.healthURL = StatusAppDelegate.makeHealthURL(for: dashboardURL)
    self.appTitle = appTitle
    self.routerBinary = routerBinary.trimmingCharacters(in: .whitespacesAndNewlines)
    self.configPath = configPath?.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
    configureStatusItem()
    configureWindow()
    loadPlaceholder(title: "Starting daemon…", message: "Checking the local model router.")
    showWindow()
    refreshDashboardIfNeeded()
  }

  private static func makeHealthURL(for dashboardURL: URL) -> URL {
    var components = URLComponents(url: dashboardURL, resolvingAgainstBaseURL: false) ?? URLComponents()
    components.path = "/api/health"
    components.query = nil
    components.fragment = nil
    return components.url ?? dashboardURL
  }

  private func configureStatusItem() {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    if let button = item.button {
      if let image = NSImage(systemSymbolName: "chart.pie.fill", accessibilityDescription: appTitle) {
        image.isTemplate = true
        button.image = image
      } else {
        button.title = "MR"
      }
      button.toolTip = appTitle
      button.action = #selector(toggleWindow)
      button.target = self
    }

    let menu = NSMenu()
    menu.addItem(withTitle: "Open Panel", action: #selector(showWindow), keyEquivalent: "o")
    menu.addItem(withTitle: "Refresh", action: #selector(refreshDashboard), keyEquivalent: "r")
    menu.addItem(NSMenuItem.separator())
    menu.addItem(withTitle: "Quit", action: #selector(quitApp), keyEquivalent: "q")
    menu.items.forEach { $0.target = self }
    item.menu = menu
    statusItem = item
  }

  private func configureWindow() {
    let rect = NSRect(x: 0, y: 0, width: 1200, height: 840)
    let style: NSWindow.StyleMask = [.titled, .closable, .resizable, .miniaturizable]
    let window = NSWindow(
      contentRect: rect,
      styleMask: style,
      backing: .buffered,
      defer: false
    )
    window.title = appTitle
    window.isReleasedWhenClosed = false
    window.center()
    window.delegate = self
    window.minSize = NSSize(width: 900, height: 640)

    let webView = WKWebView(frame: rect)
    webView.autoresizingMask = [.width, .height]
    webView.load(URLRequest(url: dashboardURL))
    window.contentView = webView

    let toolbar = NSToolbar(identifier: "ai.model-router.toolbar")
    toolbar.delegate = self
    toolbar.displayMode = .iconOnly
    toolbar.allowsUserCustomization = false
    window.toolbar = toolbar
    if #available(macOS 11.0, *) {
      window.toolbarStyle = .unifiedCompact
    }

    self.window = window
    self.webView = webView
  }

  private func loadDashboard() {
    DispatchQueue.main.async { [weak self] in
      guard let self, let webView = self.webView else { return }
      webView.load(URLRequest(url: self.dashboardURL))
    }
  }

  private func escapeHTML(_ text: String) -> String {
    text
      .replacingOccurrences(of: "&", with: "&amp;")
      .replacingOccurrences(of: "<", with: "&lt;")
      .replacingOccurrences(of: ">", with: "&gt;")
      .replacingOccurrences(of: "\"", with: "&quot;")
      .replacingOccurrences(of: "'", with: "&#39;")
  }

  private func loadPlaceholder(title: String, message: String) {
    let html = """
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>
          :root {
            color-scheme: dark;
            --bg: #10151f;
            --panel: rgba(17, 24, 39, 0.88);
            --text: #e5e7eb;
            --muted: #94a3b8;
            --accent: #60a5fa;
          }
          html, body {
            margin: 0;
            width: 100%;
            height: 100%;
            background: radial-gradient(circle at top, rgba(96, 165, 250, 0.24), transparent 44%), var(--bg);
            font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
            color: var(--text);
          }
          .wrap {
            box-sizing: border-box;
            min-height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 32px;
          }
          .card {
            width: min(640px, 100%);
            border: 1px solid rgba(148, 163, 184, 0.18);
            border-radius: 24px;
            padding: 28px 30px;
            background: var(--panel);
            box-shadow: 0 24px 80px rgba(2, 6, 23, 0.45);
          }
          h1 {
            margin: 0 0 12px;
            font-size: 28px;
            line-height: 1.15;
          }
          p {
            margin: 0;
            font-size: 15px;
            line-height: 1.6;
            color: var(--muted);
          }
          .hint {
            margin-top: 18px;
            padding-top: 18px;
            border-top: 1px solid rgba(148, 163, 184, 0.14);
            color: var(--text);
          }
          code {
            color: var(--accent);
          }
        </style>
      </head>
      <body>
        <div class="wrap">
          <div class="card">
            <h1>\(escapeHTML(title))</h1>
            <p>\(escapeHTML(message))</p>
            <p class="hint">The dashboard will load automatically once the local daemon responds on <code>\(escapeHTML(healthURL.absoluteString))</code>.</p>
          </div>
        </div>
      </body>
    </html>
    """

    DispatchQueue.main.async { [weak self] in
      self?.webView?.loadHTMLString(html, baseURL: nil)
    }
  }

  private func isDaemonHealthy(timeout: TimeInterval = 2.0) -> Bool {
    var request = URLRequest(url: healthURL)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.timeoutInterval = timeout

    let semaphore = DispatchSemaphore(value: 0)
    var healthy = false

    let task = URLSession.shared.dataTask(with: request) { _, response, _ in
      if let httpResponse = response as? HTTPURLResponse {
        healthy = (200..<300).contains(httpResponse.statusCode)
      }
      semaphore.signal()
    }
    task.resume()

    if semaphore.wait(timeout: .now() + timeout + 1.0) == .timedOut {
      task.cancel()
      return false
    }

    return healthy
  }

  private func waitForDaemon(timeout: TimeInterval = 20.0) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if isDaemonHealthy() {
        return true
      }
      Thread.sleep(forTimeInterval: 0.25)
    }
    return false
  }

  private func startDaemonProcess() -> Bool {
    let command = routerBinary.isEmpty ? "model-router" : routerBinary
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    var arguments = [command, "daemon", "start"]
    if let configPath, !configPath.isEmpty {
      arguments.append(contentsOf: ["--config", configPath])
    }
    process.arguments = arguments
    process.standardInput = nil
    process.standardOutput = nil
    process.standardError = nil

    do {
      try process.run()
    } catch {
      loadPlaceholder(title: "Daemon unavailable", message: "Failed to launch the router daemon: \(error.localizedDescription)")
      return false
    }

    return true
  }

  private func refreshDashboardIfNeeded() {
    DispatchQueue.global(qos: .utility).async { [weak self] in
      guard let self else { return }

      if self.isDaemonHealthy() {
        self.loadDashboard()
        return
      }

      guard self.startDaemonProcess() else {
        return
      }
      if self.waitForDaemon() {
        self.loadDashboard()
      } else {
        self.loadPlaceholder(
          title: "Daemon unavailable",
          message: "The local model router did not respond. Use Refresh after the daemon is ready."
        )
      }
    }
  }

  @objc private func showWindow() {
    guard let window else { return }
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  @objc private func toggleWindow() {
    guard let window else { return }
    if window.isVisible {
      window.orderOut(nil)
    } else {
      showWindow()
    }
  }

  @objc private func refreshDashboard() {
    refreshDashboardIfNeeded()
  }

  @objc private func quitApp() {
    NSApp.terminate(nil)
  }

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    sender.orderOut(nil)
    return false
  }

  func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
    [.flexibleSpace, Self.refreshToolbarItemIdentifier]
  }

  func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
    [Self.refreshToolbarItemIdentifier, .flexibleSpace]
  }

  func toolbar(
    _ toolbar: NSToolbar,
    itemForItemIdentifier itemIdentifier: NSToolbarItem.Identifier,
    willBeInsertedIntoToolbar flag: Bool
  ) -> NSToolbarItem? {
    guard itemIdentifier == Self.refreshToolbarItemIdentifier else {
      return nil
    }

    let button = NSButton(title: "Refresh", target: self, action: #selector(refreshDashboard))
    button.bezelStyle = .texturedRounded
    let item = NSToolbarItem(itemIdentifier: itemIdentifier)
    item.label = "Refresh"
    item.paletteLabel = "Refresh"
    item.view = button
    return item
  }
}

@main
struct StatusAppMain {
  static func main() {
    let arguments = CommandLine.arguments
    var urlString = ProcessInfo.processInfo.environment["AI_MODEL_ROUTER_DAEMON_URL"] ?? "http://127.0.0.1:3077"
    var appTitle = "AI Model Router"

    var index = 1
    while index < arguments.count {
      switch arguments[index] {
      case "--url":
        if index + 1 < arguments.count {
          urlString = arguments[index + 1]
          index += 2
          continue
        }
      case "--title":
        if index + 1 < arguments.count {
          appTitle = arguments[index + 1]
          index += 2
          continue
        }
      default:
        break
      }
      index += 1
    }

    guard let dashboardURL = URL(string: urlString) else {
      fputs("Invalid dashboard URL: \(urlString)\n", stderr)
      exit(1)
    }

    let application = NSApplication.shared
    let routerBinary = ProcessInfo.processInfo.environment["AI_MODEL_ROUTER_BIN"] ?? "model-router"
    let configPath = ProcessInfo.processInfo.environment["AI_MODEL_ROUTER_CONFIG"]
    let delegate = StatusAppDelegate(
      dashboardURL: dashboardURL,
      appTitle: appTitle,
      routerBinary: routerBinary,
      configPath: configPath
    )
    application.delegate = delegate
    application.run()
  }
}
