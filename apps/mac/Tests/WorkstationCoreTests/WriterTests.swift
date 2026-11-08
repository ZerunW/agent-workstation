import Foundation
@testable import WorkstationCore
import Testing

@Suite("Writer batch validation and execution")
struct WriterTests {
    func h(_ s: String) -> String { FileHasher.sha256(Data(s.utf8)) }

    func run(_ root: URL, _ items: [WriteItem]) -> WriteBatchResult {
        WriteBatchExecutor.execute(WriteBatch(root: root.path, items: items), deleteMode: .removeForTests)
    }

    @Test func writesAtomicallyWhenTheLocalFileIsTheExpectedVersion() throws {
        let t = TempDir("writer")
        t.write("a.txt", "old\n")
        chmod(t.url.appendingPathComponent("a.txt").path, 0o755)
        let r = run(t.url, [.write("a.txt", data: Data("new\n".utf8), expected: h("old\n")),
                            .write("dir/new.txt", data: Data("n\n".utf8), expected: nil)])
        #expect(r.applied == ["a.txt", "dir/new.txt"] && r.refused.isEmpty)
        #expect(t.read("a.txt") == "new\n" && t.read("dir/new.txt") == "n\n")
        if case .file(_, let mode, _) = LocalEntry.stat(t.url.appendingPathComponent("a.txt")) { #expect(mode == 0o755, "mode kept") }
        let leftovers = try FileManager.default.contentsOfDirectory(atPath: t.url.path).filter { $0.hasPrefix(".workstation-write") }
        #expect(leftovers.isEmpty)
    }

    @Test func refusesWhenTheLocalFileChanged() {
        let t = TempDir("writer")
        t.write("a.txt", "edited locally\n")
        var r = run(t.url, [.write("a.txt", data: Data("server\n".utf8), expected: h("old\n"))])
        #expect(r.applied.isEmpty && r.refused.first?.reason.contains("not on the server") == true)
        #expect(t.read("a.txt") == "edited locally\n")
        // Expected absent, but a file exists now.
        r = run(t.url, [.write("a.txt", data: Data("x".utf8), expected: nil)])
        #expect(r.applied.isEmpty)
        // Expected present, but it is gone.
        r = run(t.url, [.delete("gone.txt", expected: h("x"))])
        #expect(r.applied.isEmpty && r.refused.first?.reason.contains("removed") == true)
        #expect(t.read("a.txt") == "edited locally\n")
    }

    @Test func refusesPathsOutsideTheRoot() {
        let t = TempDir("writer"), outside = TempDir("writer-outside")
        for p in ["../escape.txt", "/etc/hosts", "a/../../escape.txt", "", "./a.txt", "a//b", ".git/config", "sub/.git/HEAD"] {
            let r = run(t.url, [.write(p, data: Data("x".utf8), expected: nil)])
            #expect(r.applied.isEmpty, "\(p) must be refused")
        }
        #expect(!FileManager.default.fileExists(atPath: t.url.deletingLastPathComponent().appendingPathComponent("escape.txt").path))
        _ = outside
    }

    @Test func refusesSymlinkEscapes() throws {
        let t = TempDir("writer"), outside = TempDir("writer-outside")
        outside.write("target.txt", "outside\n")
        try FileManager.default.createSymbolicLink(atPath: t.url.appendingPathComponent("linkdir").path, withDestinationPath: outside.url.path)
        try FileManager.default.createSymbolicLink(atPath: t.url.appendingPathComponent("linkfile").path,
                                                   withDestinationPath: outside.url.appendingPathComponent("target.txt").path)
        var r = run(t.url, [.write("linkdir/target.txt", data: Data("pwned".utf8), expected: h("outside\n"))])
        #expect(r.applied.isEmpty && r.refused.first?.reason.contains("symbolic link") == true)
        r = run(t.url, [.write("linkfile", data: Data("pwned".utf8), expected: h("outside\n"))])
        #expect(r.applied.isEmpty)
        r = run(t.url, [.delete("linkdir/target.txt", expected: h("outside\n"))])
        #expect(r.applied.isEmpty)
        #expect(outside.read("target.txt") == "outside\n")
        // A symlinked root is refused as a whole.
        let rootLink = outside.url.appendingPathComponent("rootlink")
        try FileManager.default.createSymbolicLink(atPath: rootLink.path, withDestinationPath: t.url.path)
        r = WriteBatchExecutor.execute(WriteBatch(root: rootLink.path, items: [.write("x.txt", data: Data("x".utf8), expected: nil)]), deleteMode: .removeForTests)
        #expect(r.applied.isEmpty && r.refused.first?.reason.contains("symbolic link") == true)
    }

    @Test func checksContentHashBackupBlobAndDuplicates() {
        let t = TempDir("writer")
        t.write("a.txt", "mine\n")
        var bad = WriteItem.write("b.txt", data: Data("x".utf8), expected: nil)
        bad.hash = h("something else")
        var r = run(t.url, [bad])
        #expect(r.refused.first?.reason.contains("does not match") == true)
        var item = WriteItem.write("a.txt", data: Data("server\n".utf8), expected: h("mine\n"))
        item.backedUpBlob = FileHasher.gitBlobOid(Data("not what is on disk".utf8))
        r = run(t.url, [item])
        #expect(r.applied.isEmpty && r.refused.first?.reason.contains("backed up") == true)
        item.backedUpBlob = FileHasher.gitBlobOid(Data("mine\n".utf8))
        r = run(t.url, [item, item])
        #expect(r.applied == ["a.txt"] && r.refused.first?.reason.contains("twice") == true)
        #expect(t.read("a.txt") == "server\n")
    }

    @Test func deletesOnlyTheExpectedVersion() {
        let t = TempDir("writer")
        t.write("a.txt", "synced\n")
        let r = run(t.url, [.delete("a.txt", expected: h("synced\n")), .delete("never.txt", expected: nil)])
        #expect(r.applied == ["a.txt", "never.txt"])
        #expect(!t.exists("a.txt"))
        #expect(WriteBatchExecutor.validateRoot(t.url.appendingPathComponent("missing").path).problem?.contains("no longer exists") == true)
        #expect(WriteBatchExecutor.validateRoot("relative/path").problem != nil)
    }

    @Test func gitBlobIdMatchesGit() {
        // `printf 'hello\n' | git hash-object --stdin`
        #expect(FileHasher.gitBlobOid(Data("hello\n".utf8)) == "ce013625030ba8dba906f756967f9e9ca394464a")
        #expect(FileHasher.gitBlobOid(Data()) == "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391")
    }

    @Test func historyRecordsAreNewestFirst() throws {
        let t = TempDir("history")
        let s = HistoryStore(directory: t.url)
        let now = Date()
        try s.record(HistoryBatch(id: "b1", at: now, projectId: "p", projectName: "P", files: [HistoryFile(path: "a", op: .write, oldHash: "1", newHash: "2", oldRef: "c1")]))
        try s.record(HistoryBatch(id: "b2", at: now.addingTimeInterval(0.01), projectId: "p", projectName: "P", files: [HistoryFile(path: "a", op: .delete, oldHash: "2", newHash: nil, backedUp: true)]))
        #expect(s.batches(projectId: "p").map(\.id) == ["b2", "b1"])
        #expect(s.batches(projectId: "p").last?.files.first?.oldRef == "c1")
        #expect(s.batches(projectId: "other").isEmpty)
    }
}

@Suite("Line diff")
struct LineDiffTests {
    func doc(_ a: String?, _ b: String?) -> DiffDocument { LineDiff.document(path: "f", old: a.map { Data($0.utf8) }, new: b.map { Data($0.utf8) }) }

    @Test func modifiedLineWithContext() {
        let old = (1...10).map { "line \($0)" }.joined(separator: "\n") + "\n"
        let new = old.replacingOccurrences(of: "line 5\n", with: "line five\n")
        let d = doc(old, new)
        #expect(d.hunks.count == 1)
        let h = d.hunks[0]
        #expect(h.header == "@@ -2,7 +2,7 @@")
        #expect(h.lines.map(\.kind) == [.context, .context, .context, .removed, .added, .context, .context, .context])
        #expect(h.lines[3].text == "line 5" && h.lines[3].oldNumber == 5 && h.lines[3].newNumber == nil)
        #expect(h.lines[4].text == "line five" && h.lines[4].newNumber == 5)
        #expect(d.additions == 1 && d.deletions == 1)
    }

    @Test func separateHunksAndAddedDeletedFiles() {
        let old = (1...40).map { "l\($0)" }.joined(separator: "\n")
        var lines = (1...40).map { "l\($0)" }
        lines[2] = "changed 3"; lines[35] = "changed 36"
        #expect(doc(old, lines.joined(separator: "\n")).hunks.count == 2)
        let added = doc(nil, "a\nb\n")
        #expect(added.hunks.first?.lines.map(\.kind) == [.added, .added] && added.oldSize == nil)
        let deleted = doc("a\nb\n", nil)
        #expect(deleted.hunks.first?.lines.map(\.kind) == [.removed, .removed] && deleted.newSize == nil)
        #expect(doc("same\n", "same\n").hunks.isEmpty && doc("same\n", "same\n").identical)
    }

    @Test func binaryFilesShowSizesAndHashesOnly() {
        let d = LineDiff.document(path: "logo.png", old: Data([0x89, 0x50, 0x00, 0x01]), new: Data([0x89, 0x50, 0x00, 0x02, 0x03]))
        #expect(d.isBinary && d.hunks.isEmpty)
        #expect(d.oldSize == 4 && d.newSize == 5 && d.oldHash != d.newHash)
    }

    @Test func insertionsAtStartAndEnd() {
        let d = doc("b\nc\n", "a\nb\nc\nd\n")
        #expect(d.additions == 2 && d.deletions == 0)
        #expect(d.hunks.flatMap(\.lines).filter { $0.kind == .added }.map(\.text) == ["a", "d"])
    }
}

@Suite("Link targets: picked, typed, dropped")
struct LinkTargetTests {
    @Test func typedPaths() throws {
        let home = NSHomeDirectory()
        #expect(try LinkTarget.url(fromTyped: "~/code/sample-app").path == home + "/code/sample-app")
        #expect(try LinkTarget.url(fromTyped: "  \"~/My Folder\"  ").path == home + "/My Folder")
        #expect(try LinkTarget.url(fromTyped: "'/tmp/a b'").path == "/tmp/a b")
        #expect(try LinkTarget.url(fromTyped: "/tmp/My\\ Folder/x.md").path == "/tmp/My Folder/x.md")
        #expect(try LinkTarget.url(fromTyped: "file:///tmp/a%20b").path == "/tmp/a b")
        #expect(throws: LinkTarget.Problem.empty) { try LinkTarget.url(fromTyped: "   ") }
        #expect(throws: LinkTarget.Problem.notAbsolute("code/sample-app")) { try LinkTarget.url(fromTyped: "code/sample-app") }
    }

    @Test func inspectFoldersFilesAndProblems() throws {
        let t = TempDir("link")
        t.write("notes.md", "n")
        t.write("sub/a.txt", "a")
        let folder = try LinkTarget.inspect(t.url.appendingPathComponent("sub"))
        #expect(!folder.isSingleFile && folder.root.lastPathComponent == "sub" && folder.name == "sub")
        let file = try LinkTarget.inspect(t.url.appendingPathComponent("notes.md"))
        #expect(file.isSingleFile && file.onlyPath == "notes.md" && file.root.path == t.url.standardizedFileURL.path && file.name == "notes.md")
        #expect(throws: LinkTarget.Problem.self) { try LinkTarget.inspect(t.url.appendingPathComponent("missing")) }
        try FileManager.default.createSymbolicLink(atPath: t.url.appendingPathComponent("ln").path, withDestinationPath: "notes.md")
        do { _ = try LinkTarget.inspect(t.url.appendingPathComponent("ln")); Issue.record("symlink accepted") } catch let p as LinkTarget.Problem {
            if case .symlink = p {} else { Issue.record("\(p)") }
        }
        t.write("big.bin", String(repeating: "x", count: 64))
        do { _ = try LinkTarget.inspect(t.url.appendingPathComponent("big.bin"), maxFileBytes: 10); Issue.record("too large accepted") } catch let p as LinkTarget.Problem {
            if case .tooLarge = p {} else { Issue.record("\(p)") }
        }
        let locked = t.write("locked.txt", "secret")
        chmod(locked.path, 0o000)
        defer { chmod(locked.path, 0o644) }
        do { _ = try LinkTarget.inspect(locked); Issue.record("unreadable accepted") } catch let p as LinkTarget.Problem {
            if case .unreadable = p {} else { Issue.record("\(p)") }
            #expect(p.localizedDescription.contains("can't be read"))
        }
        #expect(LinkTarget.Problem.missing("~/x").localizedDescription == "Nothing exists at ~/x.")
    }

    @Test func projectNames() {
        #expect(LinkTarget.projectName("My Project (2)") == "My-Project--2-")
        #expect(LinkTarget.projectName(".hidden") == "hidden")
        #expect(LinkTarget.projectName("报告.md") == "--.md")
        #expect(LinkTarget.projectName("") == "project")
    }
}
