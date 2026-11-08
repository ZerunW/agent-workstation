import { describe, expect, it } from "vitest";
import { makeZip } from "../test/makeZip";
import { findSkillMd, readZip } from "./zip";

const decode = async (e: { data(): Promise<Uint8Array> }) => new TextDecoder().decode(await e.data());

describe("readZip", () => {
  it("lists entries and reads stored data", async () => {
    const entries = readZip(makeZip([{ name: "SKILL.md", text: "---\nname: x\n---\nhello" }, { name: "dir/", text: "" }, { name: "dir/extra.txt", text: "more" }]));
    expect(entries.map((e) => e.name)).toEqual(["SKILL.md", "dir/extra.txt"]); // directory entries are skipped
    expect(await decode(entries[0]!)).toBe("---\nname: x\n---\nhello");
    expect(await decode(entries[1]!)).toBe("more");
  });

  it("inflates deflated entries and finds the end record behind a zip comment", async () => {
    const text = "line\n".repeat(500);
    const entries = readZip(makeZip([{ name: "a.md", text, deflate: true }], "made by test"));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.size).toBe(text.length);
    expect(await decode(entries[0]!)).toBe(text);
  });

  it("rejects things that are not zip files", () => {
    expect(() => readZip(new TextEncoder().encode("just some text, definitely not a zip archive").buffer as ArrayBuffer)).toThrow(/not a zip/);
  });
});

describe("findSkillMd", () => {
  const entries = (names: string[]) => readZip(makeZip(names.map((name) => ({ name, text: name }))));
  it("finds SKILL.md at the root or inside one top-level folder and counts the other files", () => {
    const root = findSkillMd(entries(["SKILL.md", "scripts/run.sh", "README.md"]));
    expect(root.skill?.name).toBe("SKILL.md");
    expect(root.others).toBe(2);
    const nested = findSkillMd(entries(["my-skill/SKILL.md", "my-skill/notes.txt", "__MACOSX/my-skill/._SKILL.md", "my-skill/.DS_Store"]));
    expect(nested.skill?.name).toBe("my-skill/SKILL.md");
    expect(nested.others).toBe(1);
  });
  it("prefers the shallowest SKILL.md and reports none when absent", () => {
    expect(findSkillMd(entries(["a/b/SKILL.md", "a/SKILL.md"])).skill?.name).toBe("a/SKILL.md");
    expect(findSkillMd(entries(["README.md"])).skill).toBeNull();
  });
});
