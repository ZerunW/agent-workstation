/**
 * The turn tools. `heads_up` (chat and code, not subagents): a short caveat card under the message (protocol
 * HeadsUpInput); recorded as `mcp__workstation_turn__heads_up`, the call itself is the record.
 * The end-of-turn tool of Code sessions (chats do not get it):
 *   - `wrap_up`: the agent's end-of-turn box (protocol NextStep): a short recap and, when the user must decide
 *     something, one question with 1–3 answer buttons. The runtime stores it on the session row, broadcasts `next_step`
 *     and clears it when the user sends the next message. Calling it again replaces the box.
 * Both come from the in-process MCP server `workstation_turn` (pre-approved). The task list is Claude Code's own TodoWrite.
 */
import { z } from "zod";
import type { NextStep } from "@agent-workstation/protocol";
import type { HubToolResult, HubToolSpec } from "./sdk.js";

export const TURN_SERVER = "workstation_turn";
export const WRAP_UP_TOOL = "wrap_up";
export const MAX_RECAP = 600;
export const MAX_ASK = 200;
export const MAX_ACTION_LABEL = 40;
export const MAX_ACTIONS = 3;
export const HEADS_UP_TOOL = "heads_up";
/** How heads_up calls are recorded. */
export const HEADS_UP_TOOL_NAME = `mcp__${TURN_SERVER}__${HEADS_UP_TOOL}`;
export const MAX_HEADS_UP_TEXT = 300;
export const MAX_HEADS_UP_DETAIL = 2000;

const WrapUpInput = z
  .object({
    recap: z.string().trim().min(1, "recap is required").max(MAX_RECAP, `recap is longer than ${MAX_RECAP} characters`),
    ask: z.string().trim().max(MAX_ASK, `ask is longer than ${MAX_ASK} characters`).optional(),
    actions: z
      .array(z.object({ label: z.string().trim().min(1, "an action label is empty").max(MAX_ACTION_LABEL, `an action label is longer than ${MAX_ACTION_LABEL} characters`) }))
      .max(MAX_ACTIONS, `at most ${MAX_ACTIONS} actions`)
      .optional(),
  })
  .refine((v) => !v.actions?.length || !!v.ask, { message: "actions need an ask" });

const issueText = (err: z.ZodError): string => err.issues.map((i) => i.message).join("; ");

/** Validates a wrap_up call; the NextStep to show (without `at`) or the reason it was refused. */
export function parseWrapUp(args: Record<string, unknown>): { ok: true; step: Omit<NextStep, "at"> } | { ok: false; error: string } {
  const r = WrapUpInput.safeParse(args);
  if (!r.success) return { ok: false, error: `Not shown: ${issueText(r.error)}.` };
  const { recap, ask, actions } = r.data;
  return { ok: true, step: { recap, ...(ask ? { ask } : {}), ...(ask && actions?.length ? { actions } : {}) } };
}

export function wrapUpTool(show: (step: Omit<NextStep, "at">) => void): HubToolSpec {
  return {
    name: WRAP_UP_TOOL,
    description:
      "End-of-turn box shown to the user below your answer: a two-or-three-sentence recap of what is now true and what is not done, and, only when the user must decide something, one question (`ask`) with 1–3 short answer buttons (`actions`; the first is the recommended answer). Calling it again replaces the box.",
    schema: {
      recap: z.string().describe(`What is now true and what is not done, in two or three sentences (at most ${MAX_RECAP} characters).`),
      ask: z.string().optional().describe(`Only when the user must decide something: the question (at most ${MAX_ASK} characters).`),
      actions: z
        .array(z.object({ label: z.string().describe(`The answer in the user's words, 1–4 words (at most ${MAX_ACTION_LABEL} characters).`) }))
        .optional()
        .describe(`With ask only: 1–${MAX_ACTIONS} answer buttons; the first is the recommended answer. A button sends its label as the user's next message.`),
    },
    handler: async (args): Promise<HubToolResult> => {
      const r = parseWrapUp(args);
      if (!r.ok) return { text: r.error, isError: true };
      show(r.step);
      return "Shown to the user.";
    },
  };
}

/** The heads-up card's input (protocol HeadsUpInput), with the refusal reasons the agent reads. */
const HeadsUpArgs = z.object({
  text: z.string().trim().min(1, "text is required").max(MAX_HEADS_UP_TEXT, `text is longer than ${MAX_HEADS_UP_TEXT} characters`),
  detail: z.string().max(MAX_HEADS_UP_DETAIL, `detail is longer than ${MAX_HEADS_UP_DETAIL} characters`).optional(),
});

/** Validates a heads_up call: null when it is fine, else the reason it was refused. */
export function checkHeadsUp(args: Record<string, unknown>): string | null {
  const r = HeadsUpArgs.safeParse(args);
  return r.success ? null : `Not shown: ${issueText(r.error)}.`;
}

/**
 * The heads-up card (chat and code; pre-approved). The call itself is the record: clients render the
 * stored tool_use (`mcp__workstation_turn__heads_up`, input HeadsUpInput); the hub keeps nothing else.
 */
export function headsUpTool(): HubToolSpec {
  return {
    name: HEADS_UP_TOOL,
    description:
      "Show the user a short \"Heads up\" caveat card under your answer: something they should know before acting on it (a risk, a side effect, a limit). Use it sparingly; not for summaries, and never for something listed as already known to the user.",
    schema: {
      text: z.string().describe(`The caveat in one or two sentences (at most ${MAX_HEADS_UP_TEXT} characters).`),
      detail: z.string().optional().describe(`More explanation, shown behind Learn more (at most ${MAX_HEADS_UP_DETAIL} characters).`),
    },
    handler: async (args): Promise<HubToolResult> => {
      const err = checkHeadsUp(args);
      return err ? { text: err, isError: true } : "Shown to the user.";
    },
  };
}

