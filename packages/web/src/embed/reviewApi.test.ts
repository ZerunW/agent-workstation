import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiBase, setApiUser } from "../lib/api";
import { accept, getReview, getReviewDiff, reject } from "./reviewApi";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  setApiUser("alice");
  setApiBase("http://hub.test");
});
afterEach(() => vi.unstubAllGlobals());

describe("reviewApi", () => {
  it("sends the user header and hits the review routes with the protocol bodies", async () => {
    await getReview("p1");
    await getReviewDiff("p1", "src/a b.ts");
    await accept("p1", { path: "a.ts", hunks: [0, 2] });
    await reject("p1", { all: true });
    const [r0, r1, r2, r3] = fetchMock.mock.calls as Array<[string, RequestInit]>;
    expect(r0![0]).toBe("http://hub.test/api/projects/p1/review");
    expect(r1![0]).toBe("http://hub.test/api/projects/p1/review/diff?path=src%2Fa+b.ts");
    expect(r2![0]).toBe("http://hub.test/api/projects/p1/review/accept");
    expect(r2![1]).toMatchObject({ method: "POST", body: JSON.stringify({ path: "a.ts", hunks: [0, 2] }) });
    expect(r3![0]).toBe("http://hub.test/api/projects/p1/review/reject");
    expect(r3![1].body).toBe(JSON.stringify({ all: true }));
    expect((r2![1].headers as Record<string, string>)["X-Workstation-User"]).toBe("alice");
  });
});

describe("accept → AgentWorkstation.app report", () => {
  const ABC_SHA = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"; // sha256 of the bytes "abc"
  const response = {
    localCommit: "c1",
    files: [
      { path: "a.txt", contentBase64: "YWJj", deleted: false }, // "abc"
      { path: "gone.txt", contentBase64: null, deleted: true },
      { path: "huge.bin", contentBase64: null, deleted: false },
    ],
    skipped: [{ path: "link", reason: "symlink" }],
  };
  const reportAccepted = vi.fn();
  const reply = (body: unknown, status = 200) => fetchMock.mockImplementation(async () => new Response(JSON.stringify(body), { status }));
  const expected = { projectId: "p1", localCommit: "c1", files: [{ path: "a.txt", sha256: ABC_SHA }, { path: "gone.txt", sha256: null }] };

  beforeEach(() => {
    reportAccepted.mockReset();
    window.__workstationShell = { reportAccepted };
    reply(response);
  });
  afterEach(() => {
    delete window.__workstationShell;
  });

  it("reports single-file, hunk and all accepts once each, hashing the decoded bytes and leaving out files without content", async () => {
    await accept("p1", { path: "a.txt" });
    await accept("p1", { path: "a.txt", hunks: [0], diffId: "d" });
    await accept("p1", { all: true });
    expect(reportAccepted).toHaveBeenCalledTimes(3);
    for (const call of reportAccepted.mock.calls) expect(call).toEqual([expected]);
  });

  it("hashes without Web Crypto (the plain-http LAN origin has no crypto.subtle)", async () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis.crypto, "subtle");
    Object.defineProperty(globalThis.crypto, "subtle", { value: undefined, configurable: true });
    try {
      await accept("p1", { all: true });
      expect(reportAccepted).toHaveBeenCalledWith(expected);
    } finally {
      if (desc) Object.defineProperty(globalThis.crypto, "subtle", desc);
      else delete (globalThis.crypto as { subtle?: unknown }).subtle;
    }
  });

  it("does not report a reject or a failed accept", async () => {
    await reject("p1", { all: true });
    reply({ error: "nope" }, 500);
    await expect(accept("p1", { all: true })).rejects.toBeDefined();
    expect(reportAccepted).not.toHaveBeenCalled();
  });

  it("works without the shell (plain browser) or without reportAccepted", async () => {
    delete window.__workstationShell;
    await expect(accept("p1", { all: true })).resolves.toMatchObject({ localCommit: "c1" });
    window.__workstationShell = {};
    await expect(accept("p1", { all: true })).resolves.toMatchObject({ localCommit: "c1" });
  });

  it("an exception inside reportAccepted does not break the accept", async () => {
    reportAccepted.mockImplementation(() => {
      throw new Error("bridge down");
    });
    await expect(accept("p1", { all: true })).resolves.toMatchObject({ localCommit: "c1" });
    expect(reportAccepted).toHaveBeenCalledTimes(1);
  });
});
