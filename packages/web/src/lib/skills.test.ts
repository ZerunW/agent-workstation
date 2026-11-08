import { describe, expect, it } from "vitest";
import { parseFrontmatter, skillNameForUpload, skillTemplate, slugifySkillName, validSkillName } from "./skills";

describe("validSkillName", () => {
  it("allows a-z 0-9 and - (1-64 chars)", () => {
    for (const ok of ["a", "my-skill", "pdf-extract2", "0", "-x-", "a".repeat(64)]) expect(validSkillName(ok)).toBe(true);
    for (const bad of ["", "My-Skill", "my skill", "my_skill", "über", "a".repeat(65), "a/b", "a.b"]) expect(validSkillName(bad)).toBe(false);
  });
});

describe("skillTemplate", () => {
  it("is a SKILL.md with name and description frontmatter that round-trips through parseFrontmatter", () => {
    const md = skillTemplate("release-notes");
    expect(md.startsWith("---\nname: release-notes\ndescription: ")).toBe(true);
    expect(md).toContain("\n---\n");
    expect(md).toContain("# release-notes");
    expect(parseFrontmatter(md).name).toBe("release-notes");
    expect(parseFrontmatter(md).description).toMatch(/^Describe what this skill does/);
  });
});

describe("parseFrontmatter", () => {
  it("reads name/description, strips quotes, tolerates CRLF and a BOM", () => {
    expect(parseFrontmatter('---\nname: "my-skill"\ndescription: \'Does things\'\nother: x\n---\nbody')).toEqual({ name: "my-skill", description: "Does things" });
    expect(parseFrontmatter("﻿---\r\nname: crlf\r\n---\r\nbody")).toEqual({ name: "crlf" });
  });
  it("returns nothing without a leading frontmatter block", () => {
    expect(parseFrontmatter("# Title\n\nname: nope")).toEqual({});
    expect(parseFrontmatter("text\n---\nname: later\n---")).toEqual({});
  });
});

describe("slugifySkillName / skillNameForUpload", () => {
  it("slugifies file names", () => {
    expect(slugifySkillName("My Skill (v2).md")).toBe("my-skill-v2");
    expect(slugifySkillName("SKILL.md")).toBe("skill");
    expect(slugifySkillName("###")).toBe("");
  });
  it("prefers a valid frontmatter name, then a slugified one, then the file name", () => {
    expect(skillNameForUpload("---\nname: from-front\n---\n", "other.md")).toBe("from-front");
    expect(skillNameForUpload("---\nname: From Front!\n---\n", "other.md")).toBe("from-front");
    expect(skillNameForUpload("no frontmatter", "Release Notes.md")).toBe("release-notes");
    expect(skillNameForUpload("no frontmatter", "###.md")).toBeNull();
  });
});
