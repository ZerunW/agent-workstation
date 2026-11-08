import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildUserMessage, titleFromText } from "../src/sessions/prompt.js";
import { tempDir } from "./helpers.js";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function workspace() {
  const t = tempDir();
  cleanups.push(t.cleanup);
  const root = join(t.dir, "alice");
  mkdirSync(join(root, "inbox"), { recursive: true });
  writeFileSync(join(root, "inbox", "notes.md"), "# Notes\nhello");
  writeFileSync(join(root, "inbox", "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(root, "inbox", "blob.bin"), Buffer.from([0, 1, 2, 0]));
  return root;
}

describe("buildUserMessage", () => {
  it("sends plain text as a string with our uuid and a human origin", () => {
    const m = buildUserMessage({ uuid: "u-1", text: "hi", kind: "chat", userRoot: "/nowhere", cwdAbs: "/nowhere" });
    expect(m).toMatchObject({ type: "user", uuid: "u-1", parent_tool_use_id: null, origin: { kind: "human" }, message: { role: "user", content: "hi" } });
  });

  it("inlines small files for chat sessions and lists the others for the read tool", () => {
    const root = workspace();
    const m = buildUserMessage({
      uuid: "u-2",
      text: "look",
      kind: "chat",
      userRoot: root,
      cwdAbs: join(root, ".chat"),
      attachments: [
        { type: "image", mediaType: "image/jpeg", dataBase64: "AAAA" },
        { type: "file_ref", path: "inbox/notes.md" },
        { type: "file_ref", path: "inbox/pic.png" },
        { type: "file_ref", path: "inbox/blob.bin" },
      ],
    });
    const blocks = m.message.content as { type: string; text?: string; source?: { media_type: string } }[];
    expect(blocks.map((b) => b.type)).toEqual(["image", "text", "image", "text"]);
    expect(blocks[1]!.text).toContain("# Notes");
    expect(blocks[2]!.source!.media_type).toBe("image/png");
    expect(blocks[3]!.text).toContain("look");
    expect(blocks[3]!.text).toContain("Attached files to open with the Read tool");
    expect(blocks[3]!.text).toContain(`- \`${join(realpathSync(root), "inbox", "blob.bin")}\` (application/octet-stream, 4 bytes)`);
  });

  it("chat: small SVGs inline as text; large files are listed by absolute path with how to read them", () => {
    const root = workspace();
    writeFileSync(join(root, "inbox", "logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(join(root, "inbox", "big.log"), "line\n".repeat(80_000));
    const pdf = Buffer.alloc(6 * 1024 * 1024, 0x20);
    pdf.write("%PDF-1.7\n");
    writeFileSync(join(root, "inbox", "big.pdf"), pdf);
    const atts = [{ type: "file_ref" as const, path: "inbox/logo.svg" }, { type: "file_ref" as const, path: "inbox/big.log" }, { type: "file_ref" as const, path: "inbox/big.pdf" }];
    const real = realpathSync(root);
    const claude = buildUserMessage({ uuid: "u", text: "see", kind: "chat", userRoot: root, cwdAbs: join(root, ".chat"), attachments: atts });
    const cb = claude.message.content as { type: string; text?: string }[];
    expect(cb.map((b) => b.type)).toEqual(["text", "text"]);
    expect(cb[0]!.text).toContain("<svg");
    expect(cb[1]!.text).toBe(
      [
        "see",
        "",
        "Attached files to open with the Read tool (use these absolute paths; only these files can be read):",
        `- \`${join(real, "inbox", "big.log")}\` (text, 390.6 KB) — read it in parts with \`offset\` and \`limit\` (lines)`,
        `- \`${join(real, "inbox", "big.pdf")}\` (PDF, 6.0 MB) — read a few pages at a time with \`pages\` (e.g. "1-20"; at most 20 pages per call)`,
      ].join("\n"),
    );
  });

  it("points code sessions at files relative to cwd and rejects escapes / bad images", () => {
    const root = workspace();
    const m = buildUserMessage({ uuid: "u-3", text: "fix", kind: "code", userRoot: root, cwdAbs: root, attachments: [{ type: "file_ref", path: "inbox/notes.md" }] });
    const blocks = m.message.content as { type: string; text: string }[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toContain("- inbox/notes.md (");
    expect(() => buildUserMessage({ uuid: "u", text: "", kind: "code", userRoot: root, cwdAbs: root, attachments: [{ type: "file_ref", path: "../x" }] })).toThrow();
    expect(() => buildUserMessage({ uuid: "u", text: "", kind: "chat", userRoot: root, cwdAbs: root, attachments: [{ type: "image", mediaType: "image/tiff", dataBase64: "AA" }] })).toThrow(/unsupported/);
  });

  it("derives titles", () => {
    expect(titleFromText("  Fix the build\nmore")).toBe("Fix the build");
    expect(titleFromText("/usage")).toBeNull();
    expect(titleFromText("x".repeat(80))!.length).toBe(58);
  });
});
