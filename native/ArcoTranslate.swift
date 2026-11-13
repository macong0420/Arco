import AppKit
import NaturalLanguage
import SwiftUI
import Translation

// 本机翻译辅助程序：只调用 Apple Translation 框架，在这台 Mac 上完成翻译，页面文字不发往任何服务器。
// 协议与 ArcoVault 相同：stdin 每行一个 JSON 请求，stdout 每行一个 JSON 回复，按 requestID 对应。
// 目标语言固定为系统首选语言。
func reply(_ requestID: String, _ fields: [String: Any]) {
    var result = fields
    result["requestID"] = requestID
    if let data = try? JSONSerialization.data(withJSONObject: result), let line = String(data: data, encoding: .utf8) {
        print(line)
        fflush(stdout)
    }
}
func fail(_ requestID: String, _ message: String) { reply(requestID, ["ok": false, "error": message]) }

struct Job { let requestID: String; let source: Locale.Language; let texts: [String] }

@Observable @MainActor final class Model {
    var configuration: TranslationSession.Configuration?
    @ObservationIgnored var running: Job?
    @ObservationIgnored var queue: [Job] = []
    @ObservationIgnored var window: NSWindow?
    let target = Locale.Language(identifier: Locale.preferredLanguages.first ?? "en")

    func detect(_ requestID: String, _ text: String) async {
        let recognizer = NLLanguageRecognizer()
        recognizer.processString(text)
        guard let code = recognizer.dominantLanguage, code != .undetermined else { return fail(requestID, "无法识别这个页面的语言") }
        let source = Locale.Language(identifier: code.rawValue)
        guard source.languageCode != target.languageCode else { return fail(requestID, "这个页面已经是你的系统语言") }
        let status = await LanguageAvailability().status(from: source, to: target)
        guard status != .unsupported else { return fail(requestID, "系统翻译不支持这个页面的语言") }
        reply(requestID, ["ok": true, "source": code.rawValue, "installed": status == .installed])
    }

    // 一次只跑一个任务：会话由 SwiftUI 的 translationTask 发放，换配置会取消上一个任务。
    func enqueue(_ job: Job) { queue.append(job); next() }
    func next() {
        guard running == nil, !queue.isEmpty else { return }
        let job = queue.removeFirst()
        running = job
        Task {
            // 语言包未安装时，系统的下载确认框挂在这个窗口上：把它移到屏幕中间并置前。
            if await LanguageAvailability().status(from: job.source, to: target) != .installed {
                window?.center()
                window?.makeKeyAndOrderFront(nil)
                NSApp.activate(ignoringOtherApps: true)
            }
            configuration = TranslationSession.Configuration(source: job.source, target: target)
            configuration?.invalidate()
        }
    }
    func run(_ session: TranslationSession) async {
        guard let job = running else { return }
        do {
            let requests = job.texts.enumerated().map { TranslationSession.Request(sourceText: $0.element, clientIdentifier: String($0.offset)) }
            nonisolated(unsafe) let session = session
            let responses = try await session.translations(from: requests)
            var texts = job.texts
            for response in responses { if let index = response.clientIdentifier.flatMap(Int.init), texts.indices.contains(index) { texts[index] = response.targetText } }
            reply(job.requestID, ["ok": true, "texts": texts])
        } catch {
            fail(job.requestID, "翻译没有完成。首次使用需要在系统提示中下载语言，下载后请再试一次")
        }
        window?.setFrameOrigin(NSPoint(x: -10000, y: -10000))
        running = nil
        next()
    }
}

struct HostView: View {
    @Bindable var model: Model
    var body: some View {
        Color.clear.frame(width: 1, height: 1).translationTask(model.configuration) { session in await model.run(session) }
    }
}

@main @MainActor struct ArcoTranslate {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let model = Model()
        // 平时停在屏幕外：translationTask 需要一个在场的窗口才会执行。
        let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 360, height: 1), styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "Arco 翻译"
        window.contentView?.addSubview(NSHostingView(rootView: HostView(model: model)))
        window.orderFrontRegardless()
        model.window = window
        Thread.detachNewThread {
            while let line = readLine() {
                guard line.utf8.count < 4_000_000, let data = line.data(using: .utf8),
                      let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let requestID = request["requestID"] as? String, requestID.count <= 128 else { continue }
                let action = request["action"] as? String, text = request["text"] as? String
                let source = request["source"] as? String, texts = request["texts"] as? [String]
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        if action == "detect", let text { Task { await model.detect(requestID, text) } }
                        else if action == "translate", let source, let texts, !texts.isEmpty { model.enqueue(Job(requestID: requestID, source: Locale.Language(identifier: source), texts: texts)) }
                        else { fail(requestID, "不支持的翻译操作") }
                    }
                }
            }
            exit(0) // 主进程关闭了管道
        }
        app.run()
    }
}
