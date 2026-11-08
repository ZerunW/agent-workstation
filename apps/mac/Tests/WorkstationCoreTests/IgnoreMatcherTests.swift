import Testing
@testable import WorkstationCore

@Suite("IgnoreMatcher")
struct IgnoreMatcherTests {
    @Test func defaultsIgnoreCommonJunk() {
        let m = IgnoreMatcher()
        #expect(m.isIgnored(".git", isDirectory: true))
        #expect(m.isIgnored(".git/HEAD", isDirectory: false))
        #expect(m.isIgnored("sub/.git/config", isDirectory: false))
        #expect(m.isIgnored("node_modules/x/index.js", isDirectory: false))
        #expect(m.isIgnored("web/node_modules", isDirectory: true))
        #expect(m.isIgnored("build/out.o", isDirectory: false))
        #expect(m.isIgnored("dist", isDirectory: true))
        #expect(m.isIgnored(".DS_Store", isDirectory: false))
        #expect(m.isIgnored("a/b/.DS_Store", isDirectory: false))
        #expect(m.isIgnored("pkg/__pycache__/x.pyc", isDirectory: false))
        #expect(m.isIgnored(".venv/bin/python", isDirectory: false))
        #expect(m.isIgnored("rust/target/debug/app", isDirectory: false))
        #expect(!m.isIgnored("src/main.swift", isDirectory: false))
        #expect(!m.isIgnored("builder.txt", isDirectory: false))
    }

    @Test func extensionPatternsMatchWholeSuffixOnly() {
        var m = IgnoreMatcher()
        m.add(patterns: ["*.log", "*.tmp"], base: "")
        #expect(m.isIgnored("data/run1.log", isDirectory: false))
        #expect(m.isIgnored("scratch.tmp", isDirectory: false))
        #expect(!m.isIgnored("my.login", isDirectory: false))
        #expect(!m.isIgnored("data/run1.csv", isDirectory: false))
    }

    @Test func singleStarDoesNotCrossSlash() {
        var m = IgnoreMatcher(patterns: [])
        m.add(patterns: ["src/*.js"], base: "")
        #expect(m.isIgnored("src/a.js", isDirectory: false))
        #expect(!m.isIgnored("src/sub/a.js", isDirectory: false))
        #expect(!m.isIgnored("other/src/a.js", isDirectory: false), "pattern with a slash is anchored")
    }

    @Test func doubleStar() {
        var m = IgnoreMatcher(patterns: [])
        m.add(patterns: ["**/logs", "docs/**", "a/**/z.txt", "**/*.tmp"], base: "")
        #expect(m.isIgnored("logs", isDirectory: true))
        #expect(m.isIgnored("x/y/logs", isDirectory: true))
        #expect(m.isIgnored("docs/a/b.md", isDirectory: false))
        #expect(!m.isIgnored("docs", isDirectory: true), "docs/** matches inside docs, not docs itself")
        #expect(m.isIgnored("a/z.txt", isDirectory: false))
        #expect(m.isIgnored("a/b/c/z.txt", isDirectory: false))
        #expect(m.isIgnored("deep/er/file.tmp", isDirectory: false))
    }

    @Test func questionMarkAndClasses() {
        var m = IgnoreMatcher(patterns: [])
        m.add(patterns: ["file?.txt", "img[0-9].png", "x[!a].c"], base: "")
        #expect(m.isIgnored("file1.txt", isDirectory: false))
        #expect(!m.isIgnored("file10.txt", isDirectory: false))
        #expect(m.isIgnored("img7.png", isDirectory: false))
        #expect(!m.isIgnored("imgA.png", isDirectory: false))
        #expect(m.isIgnored("xb.c", isDirectory: false))
        #expect(!m.isIgnored("xa.c", isDirectory: false))
    }

    @Test func negationLastMatchWins() {
        var m = IgnoreMatcher(patterns: [])
        m.add(patterns: ["*.log", "!keep.log"], base: "")
        #expect(m.isIgnored("debug.log", isDirectory: false))
        #expect(!m.isIgnored("keep.log", isDirectory: false))
        #expect(!m.isIgnored("sub/keep.log", isDirectory: false))
    }

    @Test func cannotReincludeInsideIgnoredDirectory() {
        var m = IgnoreMatcher(patterns: [])
        m.add(patterns: ["vendor/", "!vendor/keep.txt"], base: "")
        #expect(m.isIgnored("vendor/keep.txt", isDirectory: false))
    }

    @Test func dirOnlyPatterns() {
        var m = IgnoreMatcher(patterns: [])
        m.add(patterns: ["cache/"], base: "")
        #expect(m.isIgnored("cache", isDirectory: true))
        #expect(m.isIgnored("a/cache/x", isDirectory: false))
        #expect(!m.isIgnored("cache", isDirectory: false), "a file named cache is not a directory")
    }

    @Test func anchoredLeadingSlash() {
        var m = IgnoreMatcher(patterns: [])
        m.add(patterns: ["/root.txt"], base: "")
        #expect(m.isIgnored("root.txt", isDirectory: false))
        #expect(!m.isIgnored("sub/root.txt", isDirectory: false))
    }

    @Test func nestedGitignoreIsScoped() {
        var m = IgnoreMatcher(patterns: [])
        m.add(gitignore: "*.gen\n/local.txt\n", base: "pkg")
        #expect(m.isIgnored("pkg/a.gen", isDirectory: false))
        #expect(m.isIgnored("pkg/deep/b.gen", isDirectory: false))
        #expect(!m.isIgnored("other/a.gen", isDirectory: false))
        #expect(m.isIgnored("pkg/local.txt", isDirectory: false))
        #expect(!m.isIgnored("pkg/deep/local.txt", isDirectory: false))
    }

    @Test func commentsBlanksEscapesAndTrailingSpaces() {
        var m = IgnoreMatcher(patterns: [])
        m.add(gitignore: "# comment\n\n\\#hash\n\\!bang\ntrail   \r\n", base: "")
        #expect(m.rules.count == 3)
        #expect(m.isIgnored("#hash", isDirectory: false))
        #expect(m.isIgnored("!bang", isDirectory: false))
        #expect(m.isIgnored("trail", isDirectory: false))
    }

    @Test func gitIsAlwaysExcludedEvenIfNegated() {
        var m = IgnoreMatcher(patterns: [])
        m.add(patterns: ["!.git"], base: "")
        #expect(m.isIgnored(".git/config", isDirectory: false))
    }
}
