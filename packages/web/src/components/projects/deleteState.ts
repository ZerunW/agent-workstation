export interface DeleteInputs {
  projectName: string;
  typed: string;
  pending: number;
  undownloaded: number;
  discard: boolean;
}

/** True when anything exists only on the server (unaccepted changes or files never downloaded). */
export const hasRemaining = (pending: number, undownloaded: number): boolean => pending > 0 || undownloaded > 0;

/** Step 2 gate: the exact project name, plus the "discard remaining changes" box whenever something would be lost. */
export function canConfirmDelete({ projectName, typed, pending, undownloaded, discard }: DeleteInputs): boolean {
  if (typed.trim() !== projectName) return false;
  return !hasRemaining(pending, undownloaded) || discard;
}
