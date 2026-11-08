import Foundation
import Testing
@testable import WorkstationCore

@Suite("Sync batch builder + echo suppression")
struct SyncBatchTests {
    let content: (String) throws -> Data = { Data("content of \($0)".utf8) }

    @Test func baseHashBookkeeping() {
        let known = ["a.txt": "h-a-old", "gone.txt": "h-gone"]
        let changes: [LocalChange] = [
            .present(path: "a.txt", hash: "h-a-new", size: 3, mode: 0o644),     // modified → baseHash = known
            .present(path: "new.txt", hash: "h-new", size: 3, mode: 0o755),     // new → baseHash nil
            .present(path: "same.txt", hash: "h-same", size: 3, mode: 0o644),   // unchanged vs known → no op
            .absent(path: "gone.txt"),                                          // deleted → delete op
            .absent(path: "never.txt"),                                         // never pushed → no op
        ]
        var k = known
        k["same.txt"] = "h-same"
        let plan = SyncBatchBuilder().plan(changes: changes, known: k, content: content)
        #expect(plan.batches.count == 1)
        let ops = plan.batches[0]
        #expect(ops.map(\.path) == ["a.txt", "gone.txt", "new.txt"])
        #expect(ops[0].baseHash == "h-a-old")
        #expect(ops[0].carriesContent)
        #expect(ops[1] == .delete(path: "gone.txt", baseHash: "h-gone", force: nil))
        #expect(ops[2].baseHash == nil)
        if case let .write(_, _, _, mode, _, b64, _) = ops[2] {
            #expect(mode == 0o755)
            #expect(Data(base64Encoded: b64!) == Data("content of new.txt".utf8))
        }
    }

    @Test func dedupeContentByHashWithinBatch() {
        let changes: [LocalChange] = [
            .present(path: "dup1.txt", hash: "H", size: 4, mode: 0o644),
            .present(path: "dup2.txt", hash: "H", size: 4, mode: 0o644),
            .present(path: "other.txt", hash: "O", size: 4, mode: 0o644),
        ]
        let plan = SyncBatchBuilder().plan(changes: changes, known: [:], content: content)
        let ops = plan.batches.flatMap { $0 }
        #expect(ops.filter(\.carriesContent).map(\.path) == ["dup1.txt", "other.txt"])
        #expect(ops.count == 3)
    }

    @Test func splitsBatchesBySizeAndResendsContentPerBatch() {
        let changes: [LocalChange] = (0..<5).map { .present(path: "f\($0)", hash: $0 < 4 ? "h\($0)" : "h0", size: 40, mode: 0o644) }
        let plan = SyncBatchBuilder(maxBatchContentBytes: 100).plan(changes: changes, known: [:], content: content)
        // 40 B each, 100 B per batch → [f0 f1] [f2 f3] [f4]
        #expect(plan.batches.map { $0.map(\.path) } == [["f0", "f1"], ["f2", "f3"], ["f4"]])
        // f4 has the same hash as f0 but lands in another batch → its content is sent again.
        #expect(plan.batches[2][0].carriesContent)
        #expect(plan.opCount == 5)
    }

    @Test func forceAndMustSend() {
        let known = ["a": "h1"]
        let plan = SyncBatchBuilder().plan(
            changes: [.present(path: "a", hash: "h1", size: 1, mode: 0o644), .absent(path: "b")],
            known: known, force: ["a"], mustSend: ["b"], content: content)
        let ops = plan.batches[0]
        #expect(ops.count == 2)
        if case let .write(_, _, _, _, base, _, force) = ops[0] { #expect(base == "h1"); #expect(force == true) }
        #expect(ops[1] == .delete(path: "b", baseHash: nil, force: nil))
    }

    @Test func tooLargeFilesAreSkipped() {
        var b = SyncBatchBuilder()
        b.maxFileBytes = 10
        let plan = b.plan(changes: [.present(path: "big", hash: "x", size: 11, mode: 0o644)], known: [:], content: content)
        #expect(plan.batches.isEmpty)
        #expect(plan.skipped.map(\.path) == ["big"])
    }

    @Test func applyResultsUpdatesKnown() {
        let ops: [SyncOp] = [
            .write(path: "a", hash: "A2", size: 1, mode: 0o644, baseHash: "A1", contentBase64: "eA==", force: nil),
            .write(path: "m", hash: "M2", size: 1, mode: 0o644, baseHash: "M1", contentBase64: "eA==", force: nil),
            .write(path: "c", hash: "C2", size: 1, mode: 0o644, baseHash: "C1", contentBase64: "eA==", force: nil),
            .write(path: "n", hash: "N1", size: 1, mode: 0o644, baseHash: nil, contentBase64: nil, force: nil),
            .delete(path: "d", baseHash: "D1", force: nil),
        ]
        var known = ["a": "A1", "m": "M1", "c": "C1", "d": "D1"]
        let result = SyncResult(localCommit: "x", results: [
            .init(path: "a", status: .applied), .init(path: "m", status: .merged),
            .init(path: "c", status: .conflict, reason: "both changed"), .init(path: "n", status: .needContent),
            .init(path: "d", status: .applied),
        ])
        let out = SyncBatchBuilder.apply(result, ops: ops, known: &known)
        #expect(known == ["a": "A2", "m": "M2", "c": "C1"])
        #expect(out.conflicts.map(\.path) == ["c"])
        #expect(out.needContent == ["n"])
        #expect(Set(out.applied) == ["a", "m", "d"])
    }

    @Test func echoSuppression() {
        let e = EchoSuppressor(ttl: 60)
        let t0 = Date()
        e.expect("a.txt", hash: "H", now: t0)
        #expect(e.pending("a.txt") == .content("H"))
        #expect(!e.shouldSuppress("a.txt", observedHash: "OTHER", now: t0), "user edit after our write is not suppressed")
        #expect(e.shouldSuppress("a.txt", observedHash: "H", now: t0))
        #expect(!e.shouldSuppress("a.txt", observedHash: "H", now: t0), "expectation is consumed")
        e.expect("gone.txt", hash: nil, now: t0)
        #expect(e.shouldSuppress("gone.txt", observedHash: nil, now: t0))
        e.expect("late.txt", hash: "L", now: t0)
        #expect(!e.shouldSuppress("late.txt", observedHash: "L", now: t0.addingTimeInterval(61)), "expired")
        #expect(!e.shouldSuppress("unknown", observedHash: "x", now: t0))
        e.expect("p", hash: "1", now: t0)
        e.purgeExpired(now: t0.addingTimeInterval(100))
        #expect(e.count == 0)
    }
}
