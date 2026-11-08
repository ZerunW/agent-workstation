/** An error that maps directly onto an HTTP status + protocol ErrorBody. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (code: string, message: string, details?: unknown) => new HttpError(400, code, message, details);
export const forbidden = (code: string, message: string) => new HttpError(403, code, message);
export const notFound = (message = "not found", code = "not_found") => new HttpError(404, code, message);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
