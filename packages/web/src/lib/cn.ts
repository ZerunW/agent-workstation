export type ClassValue = string | number | false | null | undefined | ClassValue[];

/** Tiny classnames helper (no tailwind-merge: components avoid conflicting utilities). */
export function cn(...parts: ClassValue[]): string {
  const out: string[] = [];
  for (const p of parts) {
    if (!p && p !== 0) continue;
    if (Array.isArray(p)) {
      const inner = cn(...p);
      if (inner) out.push(inner);
    } else out.push(String(p));
  }
  return out.join(" ");
}
