import type { FileDiff } from "@agent-workstation/protocol";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { z } from "zod";
import type { AcceptBody, AcceptResponse, RejectBody, ReviewResponse } from "@agent-workstation/protocol";
import { request } from "../lib/api";

export type AcceptRequest = z.infer<typeof AcceptBody>;
export type RejectRequest = z.infer<typeof RejectBody>;
export type AcceptResult = z.infer<typeof AcceptResponse>;
export type ReviewList = z.infer<typeof ReviewResponse>;

const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}`;

/** GET /api/projects/:id/review — the files with unaccepted changes. */
export const getReview = (projectId: string, signal?: AbortSignal) => request<ReviewList>("GET", `${base(projectId)}/review`, { signal });

/** GET /api/projects/:id/review/diff?path= — both sides of one file plus the git hunks. */
export const getReviewDiff = (projectId: string, path: string, signal?: AbortSignal) => request<FileDiff>("GET", `${base(projectId)}/review/diff`, { query: { path }, signal });

/** POST /api/projects/:id/review/accept — `{path, hunks?}` (omit hunks for the whole file) or `{all: true}`. */
export const accept = async (projectId: string, body: AcceptRequest): Promise<AcceptResult> => {
  const response = await request<AcceptResult>("POST", `${base(projectId)}/review/accept`, { body });
  await reportAcceptedToShell(projectId, response);
  return response;
};

/**
 * Tells AgentWorkstation.app which accepts the user clicked (docs/MAC-APP.md, "Server changes back to the Mac"). No-op in a plain
 * browser; never throws. A file without inline content that was not deleted is left out, so the app asks natively.
 */
async function reportAcceptedToShell(projectId: string, response: AcceptResult): Promise<void> {
  try {
    const shell = window.__workstationShell;
    if (typeof shell?.reportAccepted !== "function") return;
    const files: Array<{ path: string; sha256: string | null }> = [];
    for (const f of response.files) {
      if (f.deleted) files.push({ path: f.path, sha256: null });
      else if (f.contentBase64 !== null) {
        // Pure-JS SHA-256: Web Crypto's subtle is missing on the plain-http LAN origin the app loads.
        const bytes = Uint8Array.from(atob(f.contentBase64), (c) => c.charCodeAt(0));
        files.push({ path: f.path, sha256: bytesToHex(sha256(bytes)) });
      }
    }
    shell.reportAccepted({ projectId, localCommit: response.localCommit, files });
  } catch {
    /* reporting is best effort: it must never break the accept flow */
  }
}

/** POST /api/projects/:id/review/reject — same body shape as accept. */
export const reject = (projectId: string, body: RejectRequest) => request<unknown>("POST", `${base(projectId)}/review/reject`, { body });
