import Foundation
import LocalAuthentication

// This helper performs system authentication only. It never receives or returns passwords.
func reply(_ requestID: String, ok: Bool, error: String = "") {
    let result: [String: Any] = ["requestID": requestID, "ok": ok, "error": error, "backend": "macOS LocalAuthentication"]
    if let data = try? JSONSerialization.data(withJSONObject: result), let line = String(data: data, encoding: .utf8) {
        print(line)
        fflush(stdout)
    }
}
while let line = readLine() {
    guard line.utf8.count < 8192, let data = line.data(using: .utf8),
          let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let requestID = request["requestID"] as? String, requestID.count <= 128 else { continue }
    switch request["action"] as? String {
    case "status": reply(requestID, ok: true)
    case "authenticate":
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            reply(requestID, ok: false, error: "系统认证不可用，请检查 Touch ID 或登录密码设置")
            continue
        }
        do {
            let accepted = try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "解锁 Arco 密码保险库")
            reply(requestID, ok: accepted, error: accepted ? "" : "系统认证已取消")
        } catch {
            reply(requestID, ok: false, error: "系统认证已取消或失败")
        }
    default: reply(requestID, ok: false, error: "不支持的认证操作")
    }
}
