/**
 * Chat attachments the model reads itself. Files too large to inline into a Chat prompt are listed in the message
 * with their absolute paths; the model opens them with a read-only file tool (the built-in Read tool) that the hub allows for exactly those paths: the file_ref attachments of the session
 * (`hub.attachments` of its stored user messages), nothing else.
 *
 * A read is allowed only when the requested path, made absolute against the session cwd, is lexically one of the
 * attachment paths (under the user root or its realpath), contains no `..` segment, and resolves on disk to that very
 * path (no symlink anywhere below the user root) as a regular file inside the root.
 */
import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { isProbablyText } from "../files/mime.js";
import { resolveInRootSync } from "../files/paths.js";

export interface AttachmentScope {
  /** Absolute user root, as configured. */
  root: string;
  /** realpath of the user root. */
  rootReal: string;
  /** Absolute cwd of the session (relative paths resolve against it). */
  cwdAbs: string;
  /** Attachment paths of the session, relative to the user root. */
  attachments: Iterable<string>;
}

/** The absolute path the model may read when `requested` names one of the session's attachments, else null. */
export function attachmentReadPath(scope: AttachmentScope, requested: unknown): string | null {
  if (typeof requested !== "string" || !requested.trim() || requested.includes("\0")) return null;
  let raw = requested.trim();
  if (raw.startsWith("file://")) {
    try {
      raw = decodeURIComponent(raw.slice("file://".length));
    } catch {
      return null;
    }
  }
  if (raw.split(/[\\/]+/).includes("..")) return null;
  const abs = resolve(scope.cwdAbs, raw);
  for (const rel of scope.attachments) {
    const exact = join(scope.rootReal, rel);
    if (abs !== exact && abs !== join(scope.root, rel)) continue;
    try {
      resolveInRootSync(scope.root, rel, { mustExist: true });
      if (realpathSync(abs) !== exact) return null;
      return statSync(exact).isFile() ? abs : null;
    } catch {
      return null;
    }
  }
  return null;
}

export const ATTACHMENT_READ_DENIED = "Only the files the user attached to this conversation can be opened, by the exact paths listed in their message.";

/** What a listed attachment is, for the note that tells the model how to read it. */
export type ReadableKind = "pdf" | "image" | "text" | "binary";

export function readableKind(abs: string, mediaType: string): ReadableKind {
  if (mediaType === "application/pdf") return "pdf";
  if (mediaType.startsWith("image/")) return "image";
  let fd: number | null = null;
  try {
    fd = openSync(abs, "r");
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return isProbablyText(buf.subarray(0, n)) ? "text" : "binary";
  } catch {
    return "binary";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
