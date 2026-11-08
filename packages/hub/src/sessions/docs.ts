/**
 * `read_workstation_docs`: Agent Workstation's own readme pages for agents (read-only). Offered to every session that is not a research
 * subagent (chat and code) through the in-process MCP server
 * `workstation_docs` (pre-approved). It is a plain tool call, so it follows the session's own model and billing.
 */
import { z } from "zod";
import type { ReadmeDocName } from "@agent-workstation/protocol";
import { isReadmeDoc, README_DOCS } from "../readme.js";
import type { HubToolResult, HubToolSpec } from "./sdk.js";

export const DOCS_SERVER = "workstation_docs";
export const DOCS_TOOL = "read_workstation_docs";

export const DOCS_TOOL_DESCRIPTION =
  "Read one of Agent Workstation's own documentation pages (Markdown): `features` (what Agent Workstation can do and how its parts work) or `getting-started` (setting up and first steps, common problems). Use it when the user asks how Agent Workstation works or has a problem with it.";

/** Reads a page; null when it is missing. */
export type DocsReader = (doc: ReadmeDocName) => Promise<string | null>;

export function docsTool(read: DocsReader): HubToolSpec {
  return {
    name: DOCS_TOOL,
    description: DOCS_TOOL_DESCRIPTION,
    schema: { doc: z.enum(README_DOCS as [ReadmeDocName, ...ReadmeDocName[]]).describe("Which page: features or getting-started.") },
    handler: async (args): Promise<HubToolResult> => {
      const doc = args.doc;
      if (!isReadmeDoc(doc)) return { text: `Unknown page: give doc as one of ${README_DOCS.join(", ")}.`, isError: true };
      const text = await read(doc);
      if (text === null) return { text: `The page ${doc} is not available on this server.`, isError: true };
      return text;
    },
  };
}
