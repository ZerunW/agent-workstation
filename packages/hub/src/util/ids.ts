import { randomBytes, randomUUID } from "node:crypto";

export const uuid = (): string => randomUUID();

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
/** Short url-safe id (lowercase alnum), e.g. for terminal ids. */
export function shortId(len = 8): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string): boolean => UUID_RE.test(s);
