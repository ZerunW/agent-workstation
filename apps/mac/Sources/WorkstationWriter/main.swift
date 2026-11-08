import Foundation
import WorkstationCore

// WorkstationWriter: the only code that changes files in linked folders.
//
// * As the XPC service (Contents/XPCServices/WorkstationWriter.xpc, no arguments): receives an approved
//   `WriteBatch` from AgentWorkstation.app and runs it in a FRESH child process (`WorkstationWriter --apply`,
//   empty environment): one batch, one project, one process. The service itself never writes.
// * `--apply`: reads the batch from stdin, sandboxes itself to the batch's folder
//   (`WriterSandbox.profile`: writes only inside that folder and the Trash, no network), executes
//   it, prints the result and exits. If the sandbox can't be applied, the batch is refused.
// * `--probe ROOT OUTSIDE PORT`: self-test of the same sandbox (used by the test suite).

let args = CommandLine.arguments

if args.count >= 2 && args[1] == WriterSandbox.applyArgument {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    let (result, status) = WriterSandbox.runApply(input: input, environment: ProcessInfo.processInfo.environment)
    FileHandle.standardOutput.write((try? JSONEncoder().encode(result)) ?? Data())
    exit(status)
}

if args.count >= 5 && args[1] == WriterSandbox.probeArgument {
    let r = WriterSandbox.runProbe(root: args[2], outside: args[3], port: UInt16(args[4]) ?? 9, trash: args.count >= 6 ? args[5] : nil)
    FileHandle.standardOutput.write((try? JSONEncoder().encode(r)) ?? Data())
    exit(0)
}

final class WriterService: NSObject, WorkstationWriterXPC {
    let writer = ChildProcessWriter(executable: Bundle.main.executableURL ?? URL(fileURLWithPath: CommandLine.arguments[0]))

    func apply(_ batch: Data, withReply reply: @escaping (Data) -> Void) {
        let result: WriteBatchResult
        if let b = try? JSONDecoder().decode(WriteBatch.self, from: batch) {
            do {
                result = try ChildProcessWriter.run(writer.executable, b, [:]).result
            } catch {
                result = WriteBatchResult(refused: b.items.map { WriteRefusal(path: $0.path, reason: error.localizedDescription) })
            }
        } else {
            result = WriteBatchResult(refused: [WriteRefusal(path: "", reason: "malformed batch")])
        }
        reply((try? JSONEncoder().encode(result)) ?? Data())
    }
}

final class ListenerDelegate: NSObject, NSXPCListenerDelegate {
    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        connection.exportedInterface = NSXPCInterface(with: WorkstationWriterXPC.self)
        connection.exportedObject = WriterService()
        connection.resume()
        return true
    }
}

let delegate = ListenerDelegate()
let listener = NSXPCListener.service()
listener.delegate = delegate
listener.resume()
