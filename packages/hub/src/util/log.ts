/** Minimal structural logger so services accept pino, Fastify's logger, or a test stub. */
export interface Logger {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  child?(bindings: Record<string, unknown>): Logger;
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export function childLogger(log: Logger, bindings: Record<string, unknown>): Logger {
  return log.child ? log.child(bindings) : log;
}
