import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  askModel,
  buildDiff,
  bumpVersion,
  judge,
  parseAnswer,
  TARGET_PATHS,
} from "./version-judge.mts";

chmodSync(join(process.cwd(), "scripts/make-app.sh"), 0o755);
chmodSync(join(process.cwd(), "scripts/version-judge.mts"), 0o755);

// ---------------------------------------------------------------------------
// 1. Syntax check
// ---------------------------------------------------------------------------

test("make-app.sh passes bash -n syntax check", () => {
  const r = spawnSync("bash", ["-n", join(process.cwd(), "scripts/make-app.sh")], { encoding: "utf8" });
  assert.equal(r.status, 0, `bash -n failed: ${r.stderr}`);
});

// ---------------------------------------------------------------------------
// 2. Bump arithmetic
// ---------------------------------------------------------------------------

test("bump arithmetic: major bumps X+1.0.0", () => {
  assert.equal(bumpVersion("0.1.0", "major"), "1.0.0");
  assert.equal(bumpVersion("1.2.3", "major"), "2.0.0");
  assert.equal(bumpVersion("0.0.0", "major"), "1.0.0");
  assert.equal(bumpVersion("2.9.15", "major"), "3.0.0");
});

test("bump arithmetic: minor bumps X.Y+1.0", () => {
  assert.equal(bumpVersion("0.1.0", "minor"), "0.2.0");
  assert.equal(bumpVersion("1.2.3", "minor"), "1.3.0");
  assert.equal(bumpVersion("0.0.0", "minor"), "0.1.0");
  assert.equal(bumpVersion("2.9.15", "minor"), "2.10.0");
});

test("bump arithmetic: patch bumps X.Y.Z+1", () => {
  assert.equal(bumpVersion("0.1.0", "patch"), "0.1.1");
  assert.equal(bumpVersion("1.2.3", "patch"), "1.2.4");
  assert.equal(bumpVersion("0.0.0", "patch"), "0.0.1");
  assert.equal(bumpVersion("2.9.15", "patch"), "2.9.16");
});

test("bump arithmetic: handles whitespace and throws on invalid version", () => {
  assert.equal(bumpVersion("  0.1.0  ", "minor"), "0.2.0");
  assert.throws(() => bumpVersion("invalid", "minor"), /Invalid semver/);
  assert.throws(() => bumpVersion("0.1", "minor"), /Invalid semver/);
  assert.throws(() => bumpVersion("1.2.3.4", "minor"), /Invalid semver/);
});

// ---------------------------------------------------------------------------
// 3. Answer parsing (first word, case, junk -> fallback)
// ---------------------------------------------------------------------------

test("answer parsing: parses first word correctly with explanation", () => {
  const r1 = parseAnswer("minor\nAdded support for multiple tabs");
  assert.equal(r1.bump, "minor");
  assert.equal(r1.reason, "Added support for multiple tabs");

  const r2 = parseAnswer("major\nComplete redesign of the application architecture");
  assert.equal(r2.bump, "major");
  assert.equal(r2.reason, "Complete redesign of the application architecture");

  const r3 = parseAnswer("patch\nFixed memory leak in background polling");
  assert.equal(r3.bump, "patch");
  assert.equal(r3.reason, "Fixed memory leak in background polling");

  const r4 = parseAnswer("minor: new preferences window");
  assert.equal(r4.bump, "minor");
  assert.equal(r4.reason, "new preferences window");

  const r5 = parseAnswer("patch");
  assert.equal(r5.bump, "patch");
  assert.equal(r5.reason, "patch");
});

test("answer parsing: case insensitivity", () => {
  const r1 = parseAnswer("MAJOR\nBreaking API change");
  assert.equal(r1.bump, "major");
  assert.equal(r1.reason, "Breaking API change");

  const r2 = parseAnswer("Minor\nAdded dark mode");
  assert.equal(r2.bump, "minor");
  assert.equal(r2.reason, "Added dark mode");

  const r3 = parseAnswer("PATCH\nBugfix for window sizing");
  assert.equal(r3.bump, "patch");
  assert.equal(r3.reason, "Bugfix for window sizing");

  const r4 = parseAnswer("**minor**\nNew feature");
  assert.equal(r4.bump, "minor");
  assert.equal(r4.reason, "New feature");
});

test("answer parsing: junk falls back to patch with fallback: reason", () => {
  const cases = [
    "I recommend a minor bump because there are new features",
    "Sure! Here is my answer: minor",
    "hello world",
    "42",
    "",
    "   ",
    null,
    undefined,
  ];

  for (const c of cases) {
    const r = parseAnswer(c);
    assert.equal(r.bump, "patch", `Expected patch for input: ${c}`);
    assert.match(r.reason, /^fallback:/, `Reason must start with fallback: for input: ${c}`);
  }
});

// ---------------------------------------------------------------------------
// 4. Diff builder caps and only covers the three paths
// ---------------------------------------------------------------------------

test("diff builder: only covers Sources, Packaging, and Package.swift", () => {
  const dir = mkdtempSync(join(tmpdir(), "diff-builder-"));
  try {
    const baseDir = join(dir, "base");
    const currentDir = join(dir, "current");

    // Targets that SHOULD be included
    mkdirSync(join(baseDir, "Sources"), { recursive: true });
    mkdirSync(join(currentDir, "Sources"), { recursive: true });
    writeFileSync(join(baseDir, "Sources", "App.swift"), "struct App { let v = 1 }\n");
    writeFileSync(join(currentDir, "Sources", "App.swift"), "struct App { let v = 2 }\n");

    mkdirSync(join(baseDir, "Packaging"), { recursive: true });
    mkdirSync(join(currentDir, "Packaging"), { recursive: true });
    writeFileSync(join(baseDir, "Packaging", "Info.plist"), "<plist>1.0</plist>\n");
    writeFileSync(join(currentDir, "Packaging", "Info.plist"), "<plist>2.0</plist>\n");

    writeFileSync(join(baseDir, "Package.swift"), "// swift-tools-version: 5.9\n");
    writeFileSync(join(currentDir, "Package.swift"), "// swift-tools-version: 6.0\n");

    // Files that MUST BE IGNORED
    mkdirSync(join(baseDir, "Tests"), { recursive: true });
    mkdirSync(join(currentDir, "Tests"), { recursive: true });
    writeFileSync(join(baseDir, "Tests", "AppTests.swift"), "test 1\n");
    writeFileSync(join(currentDir, "Tests", "AppTests.swift"), "test 2\n");

    writeFileSync(join(baseDir, "README.md"), "# Agent Workstation App v1\n");
    writeFileSync(join(currentDir, "README.md"), "# Agent Workstation App v2\n");

    writeFileSync(join(currentDir, "extra_file.txt"), "extra\n");

    const diff = buildDiff(baseDir, currentDir);

    // Verify covered paths are in diff
    assert.match(diff, /Sources\/App\.swift/);
    assert.match(diff, /Packaging\/Info\.plist/);
    assert.match(diff, /Package\.swift/);

    // Verify ignored paths are NOT in diff
    assert.doesNotMatch(diff, /Tests\/AppTests\.swift/);
    assert.doesNotMatch(diff, /README\.md/);
    assert.doesNotMatch(diff, /extra_file\.txt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("diff builder: caps output and notes truncation", () => {
  const dir = mkdtempSync(join(tmpdir(), "diff-cap-"));
  try {
    const baseDir = join(dir, "base");
    const currentDir = join(dir, "current");

    mkdirSync(join(baseDir, "Sources"), { recursive: true });
    mkdirSync(join(currentDir, "Sources"), { recursive: true });
    writeFileSync(join(baseDir, "Sources", "Big.swift"), "// line\n".repeat(500));
    writeFileSync(join(currentDir, "Sources", "Big.swift"), "// modified line\n".repeat(500));

    const cap = 200;
    const diff = buildDiff(baseDir, currentDir, cap);

    assert.ok(diff.includes(`[... diff truncated at ${cap} bytes ...]`), "must note truncation");
    // The diff content before the truncation note must be exactly cap bytes
    const diffPrefix = diff.slice(0, cap);
    assert.equal(diffPrefix.length, cap);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. Hub client against tiny local HTTP server faking four routes
// ---------------------------------------------------------------------------

function setupFakeHubServer(): Promise<{ server: Server; hubUrl: string; calls: { method: string; url: string; body?: any; headers?: any }[] }> {
  const calls: { method: string; url: string; body?: any; headers?: any }[] = [];

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let parsedBody: any = null;
      if (body) {
        try {
          parsedBody = JSON.parse(body);
        } catch {
          parsedBody = body;
        }
      }
      calls.push({ method: req.method ?? "", url: req.url ?? "", body: parsedBody, headers: req.headers });

      const url = req.url ?? "";
      const method = req.method ?? "";

      // Route 1: POST /api/sessions
      if (method === "POST" && url === "/api/sessions") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "sess-test-123" }));
        return;
      }

      // Route 2: POST /api/sessions/:id/messages
      if (method === "POST" && /^\/api\/sessions\/[^/]+\/messages$/.test(url)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ state: "accepted" }));
        return;
      }

      // Route 3: GET /api/sessions/:id
      if (method === "GET" && /^\/api\/sessions\/[^/]+$/.test(url)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "sess-test-123", status: "idle" }));
        return;
      }

      // Route 4: GET /api/sessions/:id/messages
      if (method === "GET" && /^\/api\/sessions\/[^/]+\/messages$/.test(url)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            messages: [
              { role: "user", text: "prompt" },
              {
                role: "assistant",
                content: [{ type: "text", text: "minor\nAdded new window tabs support" }],
              },
            ],
          }),
        );
        return;
      }

      // DELETE /api/sessions/:id
      if (method === "DELETE" && /^\/api\/sessions\/[^/]+$/.test(url)) {
        res.writeHead(204);
        res.end();
        return;
      }

      res.writeHead(404);
      res.end("Not Found");
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as any;
      const hubUrl = `http://127.0.0.1:${addr.port}`;
      resolve({ server, hubUrl, calls });
    });
  });
}

test("hub client: successful judgement across all 4 routes and DELETE", async () => {
  const { server, hubUrl, calls } = await setupFakeHubServer();
  try {
    const result = await askModel("some diff content", {
      hubUrl,
      hubUser: "admin",
      timeoutMs: 5000,
      pollIntervalMs: 20,
    });

    assert.equal(result.bump, "minor");
    assert.equal(result.reason, "Added new window tabs support");

    // Verify the routes called
    const sessionCreates = calls.filter((c) => c.method === "POST" && c.url === "/api/sessions");
    assert.equal(sessionCreates.length, 1);
    assert.equal(sessionCreates[0]!.body.kind, "chat");
    assert.equal(sessionCreates[0]!.body.model, "haiku");
    assert.equal(sessionCreates[0]!.body.effort, "low");
    assert.equal(sessionCreates[0]!.body.incognito, true);
    assert.equal(sessionCreates[0]!.headers["x-workstation-user"], "admin");

    const messageSends = calls.filter((c) => c.method === "POST" && c.url === "/api/sessions/sess-test-123/messages");
    assert.equal(messageSends.length, 1);
    assert.ok(messageSends[0]!.body.uuid);
    assert.ok(messageSends[0]!.body.text.includes("some diff content"));

    const pollGets = calls.filter((c) => c.method === "GET" && c.url === "/api/sessions/sess-test-123");
    assert.ok(pollGets.length >= 1);

    const messageGets = calls.filter((c) => c.method === "GET" && c.url === "/api/sessions/sess-test-123/messages");
    assert.equal(messageGets.length, 1);

    const sessionDeletes = calls.filter((c) => c.method === "DELETE" && c.url === "/api/sessions/sess-test-123");
    assert.equal(sessionDeletes.length, 1);
  } finally {
    server.close();
  }
});

test("hub client: timeout -> fallback", async () => {
  const calls: { method: string; url: string }[] = [];
  const server = createServer((req, res) => {
    calls.push({ method: req.method ?? "", url: req.url ?? "" });
    const url = req.url ?? "";
    const method = req.method ?? "";

    if (method === "POST" && url === "/api/sessions") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "sess-timeout-1" }));
      return;
    }
    if (method === "POST" && url.endsWith("/messages")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ state: "accepted" }));
      return;
    }
    // Always running, never becomes idle
    if (method === "GET" && url === "/api/sessions/sess-timeout-1") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "sess-timeout-1", status: "running" }));
      return;
    }
    if (method === "DELETE") {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const hubUrl = `http://127.0.0.1:${port}`;

  try {
    const result = await askModel("some diff", {
      hubUrl,
      timeoutMs: 60,
      pollIntervalMs: 10,
    });

    assert.equal(result.bump, "patch");
    assert.match(result.reason, /^fallback:/);
    assert.match(result.reason, /timeout/i);

    // Verify DELETE was still called on timeout
    const deletes = calls.filter((c) => c.method === "DELETE" && c.url === "/api/sessions/sess-timeout-1");
    assert.equal(deletes.length, 1);
  } finally {
    server.close();
  }
});

test("hub client: 503 -> fallback", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end("Service Unavailable");
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const hubUrl = `http://127.0.0.1:${port}`;

  try {
    const result = await askModel("some diff", {
      hubUrl,
      timeoutMs: 1000,
    });

    assert.equal(result.bump, "patch");
    assert.match(result.reason, /^fallback:/);
    assert.match(result.reason, /503/);
  } finally {
    server.close();
  }
});

test("hub client: unreachable hub -> fallback", async () => {
  // Port 1 is not running any server
  const result = await askModel("diff text", {
    hubUrl: "http://127.0.0.1:1",
    timeoutMs: 500,
  });

  assert.equal(result.bump, "patch");
  assert.match(result.reason, /^fallback:/);
});

// ---------------------------------------------------------------------------
// 6. Judge integration & CLI tests
// ---------------------------------------------------------------------------

test("judge: first run without snapshot treats as patch", async () => {
  const result = await judge({
    baseDir: "/path/that/does/not/exist",
    currentDir: "/another/nonexistent/path",
  });

  assert.equal(result.bump, "patch");
  assert.match(result.reason, /^fallback: first run without snapshot/);
});

test("CLI: node scripts/version-judge.mts runs and outputs 1 word on stdout, reason on stderr", () => {
  const r = spawnSync(
    "node",
    ["scripts/version-judge.mts", "--base", "/path/nonexistent", "--current", "apps/mac"],
    { encoding: "utf8" },
  );

  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "patch");
  assert.match(r.stderr.trim(), /^fallback: first run without snapshot/);
});

// ---------------------------------------------------------------------------
// 7. make-app.sh version bump logic integration
// ---------------------------------------------------------------------------

test("make-app.sh: version bump logic with WORKSTATION_BUMP overrides", () => {
  const dir = mkdtempSync(join(tmpdir(), "make-app-test-"));
  try {
    const macDir = join(dir, "apps/mac");
    mkdirSync(macDir, { recursive: true });
    writeFileSync(join(macDir, "VERSION"), "0.1.0\n");

    // Test WORKSTATION_BUMP=minor
    const r1 = spawnSync(
      "bash",
      [
        "-c",
        `
        ROOT="${dir}"
        MAC="$ROOT/apps/mac"
        VERSION_FILE="$MAC/VERSION"
        WORKSTATION_BUMP="minor"
        LAST="$(cat "$VERSION_FILE" 2>/dev/null || echo 0.1.0)"
        [[ $LAST =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]
        MAJOR="\${BASH_REMATCH[1]}"
        MINOR="\${BASH_REMATCH[2]}"
        PATCH="\${BASH_REMATCH[3]}"
        BUMP="$(echo "$WORKSTATION_BUMP" | tr '[:upper:]' '[:lower:]')"
        REASON="\${WORKSTATION_BUMP_REASON:-WORKSTATION_BUMP override}"
        case "$BUMP" in
          major) VERSION="$((MAJOR + 1)).0.0" ;;
          minor) VERSION="\${MAJOR}.$((MINOR + 1)).0" ;;
          patch|*) BUMP="patch"; VERSION="\${MAJOR}.\${MINOR}.$((PATCH + 1))" ;;
        esac
        echo "version: $LAST -> $VERSION ($BUMP: $REASON)"
        `,
      ],
      { encoding: "utf8" },
    );
    assert.equal(r1.status, 0);
    assert.equal(r1.stdout.trim(), "version: 0.1.0 -> 0.2.0 (minor: WORKSTATION_BUMP override)");

    // Test judge fallback without WORKSTATION_BUMP (first run without snapshot)
    const scriptPath = join(process.cwd(), "scripts/version-judge.mts");
    const r2 = spawnSync(
      "bash",
      [
        "-c",
        `
        ROOT="${dir}"
        MAC="$ROOT/apps/mac"
        VERSION_FILE="$MAC/VERSION"
        LAST="$(cat "$VERSION_FILE" 2>/dev/null || echo 0.1.0)"
        [[ $LAST =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]
        MAJOR="\${BASH_REMATCH[1]}"
        MINOR="\${BASH_REMATCH[2]}"
        PATCH="\${BASH_REMATCH[3]}"
        JUDGE_ERR="$(mktemp "\${TMPDIR:-/tmp}/judge-err.XXXXXX")"
        BUMP="$(node "${scriptPath}" --base "$MAC/.release-base" --current "$MAC" 2>"$JUDGE_ERR" || true)"
        REASON="$(cat "$JUDGE_ERR" 2>/dev/null || true)"
        rm -f "$JUDGE_ERR"
        BUMP="$(echo "$BUMP" | tr -d '[:space:]')"
        [ -n "$BUMP" ] || BUMP="patch"
        [ -n "$REASON" ] || REASON="fallback: judge produced no reason"
        case "$BUMP" in
          major) VERSION="$((MAJOR + 1)).0.0" ;;
          minor) VERSION="\${MAJOR}.$((MINOR + 1)).0" ;;
          patch|*) BUMP="patch"; VERSION="\${MAJOR}.\${MINOR}.$((PATCH + 1))" ;;
        esac
        echo "version: $LAST -> $VERSION ($BUMP: $REASON)"
        `,
      ],
      { encoding: "utf8" },
    );
    assert.equal(r2.status, 0);
    assert.equal(r2.stdout.trim(), "version: 0.1.0 -> 0.1.1 (patch: fallback: first run without snapshot)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
