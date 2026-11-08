/**
 * Builds the SDKUserMessage fed to Claude from a SendMessageBody.
 *
 * - Pasted images become base64 image blocks.
 * - file_ref attachments: Code sessions get a pointer to the file (Claude
 *   reads it with its tools). Chat sessions inline small files: images as
 *   image blocks, PDFs as document blocks, small text files as fenced text.
 *   Anything larger (or of another type) is listed with its absolute path in
 *   a note that tells the model to open it with the Read tool (PDFs by page
 *   range), which the hub
 *   allows for exactly the session's attachment paths (attachments.ts).
 * - The hub's message uuid goes on `uuid` so the CLI transcript, echoes and
 *   getSessionMessages() reconciliation all line up with our row.
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, relative } from "node:path";
import type { Attachment, FileRefMeta, SessionKind, UserMessageMeta } from "@agent-workstation/protocol";
import { badRequest } from "../util/errors.js";
import { IMAGE_TYPES_FOR_CLAUDE, isProbablyText, mediaTypeFor } from "../files/mime.js";
import { resolveInRootSync } from "../files/paths.js";
import { formatBytes, readableKind, type ReadableKind } from "./attachments.js";
import type { SDKUserMessage } from "./sdk.js";

type Content = SDKUserMessage["message"]["content"];
type Block = Exclude<Content, string>[number];

export const MAX_IMAGE_BASE64 = 7_000_000; // ≈5 MB decoded
export const MAX_INLINE_TEXT_BYTES = 256 * 1024;
export const MAX_INLINE_BINARY_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS = 20;

export interface BuildPromptInput {
  uuid: string;
  text: string;
  attachments?: Attachment[];
  kind: SessionKind;
  /** Absolute user root (file_ref paths are relative to it). */
  userRoot: string;
  /** Absolute cwd of the session. */
  cwdAbs: string;
  timestamp?: string;
}

/** One attachment of a Chat message that the model reads itself (too large to inline, or of another type). */
interface ToRead {
  abs: string;
  size: number;
  kind: ReadableKind;
  mediaType: string;
}

const KIND_LABEL: Record<ReadableKind, string> = { pdf: "PDF", image: "image", text: "text", binary: "binary" };

/** The note listing the attachments a Chat model opens with its read-only file tool. */
function readNote(files: ToRead[]): string {
  const line = (f: ToRead) => {
    const what = `${f.kind === "binary" ? f.mediaType : KIND_LABEL[f.kind]}, ${formatBytes(f.size)}`;
    const how =
      f.kind === "pdf"
        ? ' — read a few pages at a time with `pages` (e.g. "1-20"; at most 20 pages per call)'
        : f.kind === "text"
          ? " — read it in parts with `offset` and `limit` (lines)"
          : "";
    return `- \`${f.abs}\` (${what})${how}`;
  };
  const head = "Attached files to open with the Read tool (use these absolute paths; only these files can be read):";
  return `${head}\n${files.map(line).join("\n")}`;
}

const block = (b: Record<string, unknown>): Block => b as unknown as Block;

export interface UserTurn {
  /** What Claude receives. */
  msg: SDKUserMessage;
  /** What people see (stored as `hub` on the payload); null when the message had no attachments. */
  meta: UserMessageMeta | null;
}

export function buildUserMessage(input: BuildPromptInput): SDKUserMessage {
  return buildUserTurn(input).msg;
}

export function buildUserTurn(input: BuildPromptInput): UserTurn {
  const atts = input.attachments ?? [];
  if (atts.length > MAX_ATTACHMENTS) throw badRequest("invalid_request", `at most ${MAX_ATTACHMENTS} attachments`);
  const files: FileRefMeta[] = [];
  let content: Content;
  if (atts.length === 0) {
    content = input.text;
  } else {
    const blocks: Block[] = [];
    const notes: string[] = [];
    const toRead: ToRead[] = [];
    for (const a of atts) {
      if (a.type === "image") {
        if (!IMAGE_TYPES_FOR_CLAUDE.has(a.mediaType)) throw badRequest("invalid_request", `unsupported image type ${a.mediaType}`);
        if (a.dataBase64.length > MAX_IMAGE_BASE64) throw badRequest("invalid_request", "image too large (max ~5 MB)");
        blocks.push(block({ type: "image", source: { type: "base64", media_type: a.mediaType, data: a.dataBase64 } }));
        continue;
      }
      const r = resolveInRootSync(input.userRoot, a.path, { mustExist: true });
      const st = statSync(r.abs);
      if (!st.isFile()) throw badRequest("invalid_request", `${r.rel} is not a file`);
      const mt = mediaTypeFor(r.abs);
      files.push({ type: "file_ref", path: r.rel, name: basename(r.rel), size: st.size, mediaType: mt });
      if (input.kind === "code") {
        let cwdReal = input.cwdAbs;
        try {
          cwdReal = realpathSync(input.cwdAbs);
        } catch {
          /* keep as given */
        }
        const fromCwd = relative(cwdReal, r.abs) || r.rel;
        notes.push(`- ${fromCwd.startsWith("..") ? r.abs : fromCwd} (${st.size} bytes)`);
        continue;
      }
      if (IMAGE_TYPES_FOR_CLAUDE.has(mt) && st.size <= MAX_INLINE_BINARY_BYTES) {
        blocks.push(block({ type: "image", source: { type: "base64", media_type: mt, data: readFileSync(r.abs).toString("base64") } }));
        continue;
      }
      if (mt === "application/pdf" && st.size <= MAX_INLINE_BINARY_BYTES) {
        blocks.push(block({ type: "document", source: { type: "base64", media_type: "application/pdf", data: readFileSync(r.abs).toString("base64") }, title: r.rel }));
        continue;
      }
      if (st.size <= MAX_INLINE_TEXT_BYTES) {
        const buf = readFileSync(r.abs);
        if (isProbablyText(buf)) {
          blocks.push(block({ type: "text", text: `Attached file \`${r.rel}\`:\n\n\`\`\`\n${buf.toString("utf8")}\n\`\`\`` }));
          continue;
        }
      }
      // Too large to inline (or a type that cannot be inlined): the model opens it itself, by its absolute path.
      toRead.push({ abs: r.abs, size: st.size, kind: readableKind(r.abs, mt), mediaType: mt });
    }
    let text = input.text;
    if (notes.length) {
      text += `${text ? "\n\n" : ""}Attached files (paths relative to the working directory):\n${notes.join("\n")}`;
    }
    if (toRead.length) text += `${text ? "\n\n" : ""}${readNote(toRead)}`;
    if (text) blocks.push(block({ type: "text", text }));
    content = blocks;
  }
  const msg: SDKUserMessage = {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    session_id: "",
    uuid: input.uuid as SDKUserMessage["uuid"],
    origin: { kind: "human" },
    ...(input.timestamp ? { timestamp: input.timestamp } : {}),
  };
  return { msg, meta: atts.length ? { text: input.text, attachments: files } : null };
}

/** First line of the prompt, trimmed, for auto-titling a new session. */
export function titleFromText(text: string): string | null {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  if (!line || line.startsWith("/")) return null;
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}
