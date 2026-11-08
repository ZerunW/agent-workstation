export type Clock = () => Date;
export const systemClock: Clock = () => new Date();
export const iso = (d: Date = new Date()): string => d.toISOString();

/** Resolves true if `p` settles before `ms`, false on timeout. Never rejects. */
export async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((res) => {
    timer = setTimeout(() => res(false), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([p.then(() => true, () => true), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
