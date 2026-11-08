import { t } from "../i18n";

/** Matches the protocol's `Skill.name`. */
export const SKILL_NAME_RE = /^[a-z0-9-]{1,64}$/;

export const validSkillName = (name: string): boolean => SKILL_NAME_RE.test(name);

/** Template for a new skill: frontmatter the CLI reads (`name`, `description`) plus a body to fill in. */
export function skillTemplate(name: string): string {
  return `---\nname: ${name}\ndescription: ${t("skills.template.description")}\n---\n\n# ${name}\n\nWhen this skill is invoked:\n\n1. …\n2. …\n`;
}

/** Reads `name` and `description` from a leading `---` frontmatter block (flat `key: value` lines only). */
export function parseFrontmatter(md: string): { name?: string; description?: string } {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(md);
  if (!m) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^(name|description):\s*(.*?)\s*$/.exec(line);
    if (!kv) continue;
    const value = kv[2]!.replace(/^(['"])(.*)\1$/, "$2");
    out[kv[1] as "name" | "description"] = value;
  }
  return out;
}

/** "My Skill (v2).md" → "my-skill-v2": lowercase, runs of other characters become one "-", trimmed, max 64. */
export function slugifySkillName(raw: string): string {
  return raw
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

/** Skill name for an uploaded file: the frontmatter `name` when it is valid (or slugifies to something valid), else the file name. */
export function skillNameForUpload(content: string, filename: string): string | null {
  const fm = parseFrontmatter(content).name;
  for (const candidate of [fm, fm ? slugifySkillName(fm) : undefined, slugifySkillName(filename)]) {
    if (candidate && validSkillName(candidate)) return candidate;
  }
  return null;
}
