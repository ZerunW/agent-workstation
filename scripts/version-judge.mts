#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type VersionBump = "major" | "minor" | "patch";

export interface ParseResult {
  bump: VersionBump;
  reason: string;
}

export const TARGET_PATHS = ["Sources", "Packaging", "Package.swift"] as const;

export function bumpVersion(version: string, bump: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) throw new Error(`Invalid semver version: ${version}`);
  const major = parseInt(match[1]!, 10);
  const minor = parseInt(match[2]!, 10);
  const patch = parseInt(match[3]!, 10);
  const normalizedBump = bump.toLowerCase().trim();
  switch (normalizedBump) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default:
      return `${major}.${minor}.${patch + 1}`;
  }
}

export function parseAnswer(rawText: string | null | undefined): ParseResult {
  if (!rawText || !rawText.trim()) {
    return { bump: "patch", reason: "fallback: empty answer" };
  }

  const trimmed = rawText.trim();
  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const firstLine = lines[0] ?? "";

  const match = /^[^\w]*([a-zA-Z]+)/.exec(firstLine);
  const firstWord = match ? match[1]!.toLowerCase() : "";

  if (firstWord !== "major" && firstWord !== "minor" && firstWord !== "patch") {
    const preview = trimmed.replace(/\s+/g, " ").slice(0, 100);
    return {
      bump: "patch",
      reason: `fallback: unparsable answer: "${preview}"`,
    };
  }

  const bump = firstWord as VersionBump;

  const afterFirstWord = firstLine
    .slice((match ? match.index + match[0]!.length : 0))
    .replace(/^[:\s\-–—*_`~]+/, "")
    .trim();
  const subsequentLines = lines.slice(1).join(" ").trim();

  let reason = "";
  if (afterFirstWord && subsequentLines) {
    reason = `${afterFirstWord} - ${subsequentLines}`;
  } else if (subsequentLines) {
    reason = subsequentLines;
  } else if (afterFirstWord) {
    reason = afterFirstWord;
  } else {
    reason = bump;
  }

  reason = reason.replace(/[\r\n]+/g, " ").trim();

  return { bump, reason };
}

export function buildDiff(baseDir: string, currentDir: string, capBytes = 60 * 1024): string {
  let combinedDiff = "";

  for (const relPath of TARGET_PATHS) {
    const basePath = join(baseDir, relPath);
    const currentPath = join(currentDir, relPath);

    const baseExists = existsSync(basePath);
    const currentExists = existsSync(currentPath);

    if (!baseExists && !currentExists) {
      continue;
    }

    const r = spawnSync("diff", ["-ruN", basePath, currentPath], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });

    if (r.status === 1 && r.stdout) {
      combinedDiff += r.stdout;
    }
  }

  if (combinedDiff.length > capBytes) {
    combinedDiff = combinedDiff.slice(0, capBytes) + `\n\n[... diff truncated at ${capBytes} bytes ...]\n`;
  }

  return combinedDiff;
}

export function extractLastAssistantText(body: unknown): string | null {
  const list = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as any).messages)
      ? (body as any).messages
      : [];

  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m) continue;
    const isAssistant = m.role === "assistant" || m.kind === "assistant";
    if (isAssistant || (!m.role && !m.kind)) {
      const text = extractTextFromMessage(m);
      if (text !== null && text.trim().length > 0) return text;
    }
  }
  return null;
}

function extractTextFromMessage(m: any): string | null {
  if (typeof m === "string") return m;
  if (!m || typeof m !== "object") return null;
  if (typeof m.text === "string") return m.text;
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    const parts = m.content
      .map((c: any) => (typeof c === "string" ? c : c?.type === "text" && typeof c.text === "string" ? c.text : ""))
      .filter((s: string) => s.length > 0);
    if (parts.length > 0) return parts.join("\n");
  }
  if (m.payload) {
    const t = extractTextFromMessage(m.payload);
    if (t !== null) return t;
  }
  if (m.message) {
    const t = extractTextFromMessage(m.message);
    if (t !== null) return t;
  }
  return null;
}

export function buildPrompt(diffText: string): string {
  return [
    "You are deciding the semantic version bump (major, minor, or patch) for a macOS app release.",
    "",
    "Rules:",
    "- major = incompatible changes for users or a redesign",
    "- minor = new user-visible features",
    "- patch = fixes and internal changes",
    "",
    "Instructions:",
    "Answer on the first line with only the word: major, minor, or patch.",
    "On the following line, provide a brief one-line reason explaining the decision.",
    "",
    "Unified diff of changes since the last release:",
    "```diff",
    diffText,
    "```",
  ].join("\n");
}

export interface HubJudgeOptions {
  hubUrl?: string;
  hubUser?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  model?: string;
  effort?: string;
}

export async function askModel(
  diffText: string,
  opts?: HubJudgeOptions,
): Promise<{ bump: VersionBump; reason: string }> {
  const hubUrl = (opts?.hubUrl ?? process.env.HUB_URL ?? "https://workstation.example.com").replace(/\/+$/, "");
  const hubUser = opts?.hubUser ?? process.env.HUB_USER ?? "admin";
  const timeoutMs = opts?.timeoutMs ?? 120_000;
  const pollIntervalMs = opts?.pollIntervalMs ?? 500;
  const model = opts?.model ?? "haiku";
  const effort = opts?.effort ?? "low";

  let sessionId: string | null = null;

  try {
    // 1. Create chat session: POST /api/sessions
    let createRes: Response;
    try {
      createRes = await fetch(`${hubUrl}/api/sessions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Workstation-User": hubUser,
        },
        body: JSON.stringify({
          kind: "chat",
          model,
          effort,
          incognito: true,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err: any) {
      return { bump: "patch", reason: `fallback: hub unreachable (${err.message || String(err)})` };
    }

    if (!createRes.ok) {
      const errText = await createRes.text().catch(() => "");
      return {
        bump: "patch",
        reason: `fallback: the model is unavailable (HTTP ${createRes.status}${errText ? `: ${errText.slice(0, 100)}` : ""})`,
      };
    }

    const sessionData = await createRes.json().catch(() => null) as any;
    sessionId = sessionData?.id ?? sessionData?.session?.id;
    if (!sessionId) {
      return { bump: "patch", reason: "fallback: no session id in response" };
    }

    // 2. Send message: POST /api/sessions/:id/messages
    const prompt = buildPrompt(diffText);
    const msgRes = await fetch(`${hubUrl}/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Workstation-User": hubUser,
      },
      body: JSON.stringify({
        uuid: randomUUID(),
        text: prompt,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!msgRes.ok) {
      const errText = await msgRes.text().catch(() => "");
      return {
        bump: "patch",
        reason: `fallback: the model is unavailable (HTTP ${msgRes.status}${errText ? `: ${errText.slice(0, 100)}` : ""})`,
      };
    }

    // 3. Poll GET /api/sessions/:id until status "idle"
    const start = Date.now();
    let isIdle = false;
    while (Date.now() - start < timeoutMs) {
      const remainingTime = Math.max(1000, timeoutMs - (Date.now() - start));
      const pollRes = await fetch(`${hubUrl}/api/sessions/${sessionId}`, {
        method: "GET",
        headers: { "X-Workstation-User": hubUser },
        signal: AbortSignal.timeout(remainingTime),
      });

      if (!pollRes.ok) {
        const errText = await pollRes.text().catch(() => "");
        return {
          bump: "patch",
          reason: `fallback: the model is unavailable (HTTP ${pollRes.status}${errText ? `: ${errText.slice(0, 100)}` : ""})`,
        };
      }

      const pollData = await pollRes.json().catch(() => null) as any;
      const status = pollData?.status ?? pollData?.session?.status;
      if (status === "idle") {
        isIdle = true;
        break;
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    if (!isIdle) {
      return { bump: "patch", reason: `fallback: timeout waiting for session idle (${Math.round(timeoutMs / 1000)}s)` };
    }

    // 4. Read assistant text: GET /api/sessions/:id/messages
    const messagesRes = await fetch(`${hubUrl}/api/sessions/${sessionId}/messages`, {
      method: "GET",
      headers: { "X-Workstation-User": hubUser },
      signal: AbortSignal.timeout(Math.min(10000, timeoutMs)),
    });

    if (!messagesRes.ok) {
      const errText = await messagesRes.text().catch(() => "");
      return {
        bump: "patch",
        reason: `fallback: the model is unavailable (HTTP ${messagesRes.status}${errText ? `: ${errText.slice(0, 100)}` : ""})`,
      };
    }

    const messagesData = await messagesRes.json().catch(() => null);
    const assistantText = extractLastAssistantText(messagesData);
    if (!assistantText) {
      return { bump: "patch", reason: "fallback: unparsable answer: no assistant message" };
    }

    return parseAnswer(assistantText);
  } catch (err: any) {
    return { bump: "patch", reason: `fallback: ${err.message || String(err)}` };
  } finally {
    if (sessionId) {
      try {
        await fetch(`${hubUrl}/api/sessions/${sessionId}`, {
          method: "DELETE",
          headers: { "X-Workstation-User": hubUser },
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        // ignore errors on DELETE
      }
    }
  }
}

export interface JudgeOptions extends HubJudgeOptions {
  baseDir: string;
  currentDir: string;
}

export async function judge(opts: JudgeOptions): Promise<{ bump: VersionBump; reason: string }> {
  if (!existsSync(opts.baseDir)) {
    return { bump: "patch", reason: "fallback: first run without snapshot" };
  }

  const hasSnapshot = TARGET_PATHS.some((p) => existsSync(join(opts.baseDir, p)));
  if (!hasSnapshot) {
    return { bump: "patch", reason: "fallback: first run without snapshot" };
  }

  let diff: string;
  try {
    diff = buildDiff(opts.baseDir, opts.currentDir);
  } catch (err: any) {
    return { bump: "patch", reason: `fallback: failed to build diff: ${err.message || String(err)}` };
  }

  return await askModel(diff, opts);
}

export function parseCliArgs(argv: string[]) {
  let base: string | undefined;
  let current: string | undefined;
  let hubUrl: string | undefined;
  let hubUser: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--base" && i + 1 < argv.length) {
      base = argv[++i];
    } else if (arg.startsWith("--base=")) {
      base = arg.slice("--base=".length);
    } else if (arg === "--current" && i + 1 < argv.length) {
      current = argv[++i];
    } else if (arg.startsWith("--current=")) {
      current = arg.slice("--current=".length);
    } else if (arg === "--hub-url" && i + 1 < argv.length) {
      hubUrl = argv[++i];
    } else if (arg.startsWith("--hub-url=")) {
      hubUrl = arg.slice("--hub-url=".length);
    } else if (arg === "--hub-user" && i + 1 < argv.length) {
      hubUser = argv[++i];
    } else if (arg.startsWith("--hub-user=")) {
      hubUser = arg.slice("--hub-user=".length);
    }
  }

  return { base, current, hubUrl, hubUser };
}

// CLI entrypoint
if (
  process.argv[1] &&
  (resolve(process.argv[1]) === fileURLToPath(import.meta.url) || process.argv[1].endsWith("version-judge.mts"))
) {
  const args = parseCliArgs(process.argv.slice(2));
  const baseDir = args.base ?? "apps/mac/.release-base";
  const currentDir = args.current ?? "apps/mac";

  judge({
    baseDir,
    currentDir,
    hubUrl: args.hubUrl,
    hubUser: args.hubUser,
  })
    .then(({ bump, reason }) => {
      process.stdout.write(bump + "\n");
      process.stderr.write(reason + "\n");
      process.exit(0);
    })
    .catch((err) => {
      process.stdout.write("patch\n");
      process.stderr.write(`fallback: ${err.message || String(err)}\n`);
      process.exit(0);
    });
}
