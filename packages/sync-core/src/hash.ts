import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/**
 * Content hash used on the wire (manifest entries, SyncOp.hash / baseHash):
 * lowercase hex sha256 of the raw file bytes. The macOS app computes exactly
 * the same thing (CryptoKit SHA256 over the file data).
 */
export function hashBytes(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** git's object id for a blob with these bytes (sha1 of `blob <len>\0<bytes>`). */
export function gitBlobOid(data: Uint8Array): string {
  const h = createHash("sha1");
  h.update(`blob ${data.byteLength}\0`);
  h.update(data);
  return h.digest("hex");
}

/** Streaming variant of {@link gitBlobOid} for large files. */
export async function gitBlobOidOfFile(absPath: string, size: number): Promise<string> {
  const h = createHash("sha1");
  h.update(`blob ${size}\0`);
  for await (const chunk of createReadStream(absPath)) h.update(chunk as Buffer);
  return h.digest("hex");
}

export const ZERO_OID = "0000000000000000000000000000000000000000";
export const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
