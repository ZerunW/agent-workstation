import { afterEach, describe, expect, it } from "vitest";
import { HeadsUpInput, SessionSnapshot } from "@agent-workstation/protocol";
import { HEADS_UP_GUIDANCE } from "../src/sessions/guide.js";
import { checkHeadsUp, HEADS_UP_TOOL, HEADS_UP_TOOL_NAME, headsUpTool, parseWrapUp, TURN_SERVER, WRAP_UP_TOOL } from "../src/sessions/turn.js";
import { msgBody, runtimeFixture, until, type RuntimeFixture } from "./helpers.js";

let fixtures: RuntimeFixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});

const idle = (fx: RuntimeFixture, id: string, n: number) =>
  until(() => fx.sessions.statusOf(id).status === "idle" && fx.store.getSession(id)!.turnCount >= n, 3000, `turn ${n}`);

describe("wrap_up: validation", () => {
  const long = (n: number) => "x".repeat(n);
  it("accepts a recap alone, or a recap with an ask and 1–3 actions (trimmed)", () => {
    expect(parseWrapUp({ recap: "  Done.  " })).toEqual({ ok: true, step: { recap: "Done." } });
    expect(parseWrapUp({ recap: long(600), ask: long(200), actions: [{ label: long(40) }, { label: "No" }, { label: " Later " }] })).toEqual({
      ok: true,
      step: { recap: long(600), ask: long(200), actions: [{ label: long(40) }, { label: "No" }, { label: "Later" }] },
    });
    expect(parseWrapUp({ recap: "Done.", ask: "Deploy?" })).toEqual({ ok: true, step: { recap: "Done.", ask: "Deploy?" } });
    expect(parseWrapUp({ recap: "Done.", ask: "Deploy?", actions: [] })).toEqual({ ok: true, step: { recap: "Done.", ask: "Deploy?" } });
  });

  it("refuses a missing or too long recap, a too long ask, too many or too long actions, and actions without an ask", () => {
    const bad: Record<string, unknown>[] = [
      {},
      { recap: "   " },
      { recap: 42 },
      { recap: long(601) },
      { recap: "ok", ask: long(201) },
      { recap: "ok", ask: "?", actions: [{ label: "a" }, { label: "b" }, { label: "c" }, { label: "d" }] },
      { recap: "ok", ask: "?", actions: [{ label: long(41) }] },
      { recap: "ok", ask: "?", actions: [{ label: " " }] },
      { recap: "ok", actions: [{ label: "Yes" }] },
    ];
    for (const b of bad) {
      const r = parseWrapUp(b);
      expect(r.ok, JSON.stringify(b)).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/^Not shown: /);
    }
  });
});

describe("wrap_up in Claude sessions", () => {
  const clock = { now: new Date("2026-10-31T10:00:00.000Z") };

  async function started(kind: "code" | "chat" = "code"): Promise<{ fx: RuntimeFixture; id: string }> {
    const fx = runtimeFixture({ clock: () => clock.now });
    fixtures.push(fx);
    const id = fx.newSession(kind);
    await fx.sessions.send(id, msgBody("hi"));
    await idle(fx, id, 1);
    return { fx, id };
  }
  const wrapUp = (fx: RuntimeFixture) => fx.sdk.mcpServers.get(TURN_SERVER)!.find((t) => t.name === WRAP_UP_TOOL)!;

  it("is offered to code sessions only, pre-approved (no permission card)", async () => {
    const { fx } = await started("code");
    const o = fx.sdk.last.options;
    expect(Object.keys(o.mcpServers ?? {})).toContain(TURN_SERVER);
    expect(o.allowedTools).toContain("mcp__workstation_turn__wrap_up");
    expect(await fx.sdk.last.askPermission("mcp__workstation_turn__wrap_up", { recap: "x" })).toMatchObject({ behavior: "allow" });
    expect(fx.bus.ofType("permission_request")).toEqual([]);

    const chat = await started("chat");
    const co = chat.fx.sdk.last.options;
    // A chat's turn server carries only heads_up.
    expect(chat.fx.sdk.mcpServers.get(TURN_SERVER)!.map((t) => t.name)).toEqual([HEADS_UP_TOOL]);
    expect(co.allowedTools ?? []).not.toContain("mcp__workstation_turn__wrap_up");
    expect(co.allowedTools ?? []).not.toContain("TodoWrite");
  });

  it("stores the box, broadcasts next_step, puts it in the snapshot; a second call replaces it; a bad call changes nothing", async () => {
    const { fx, id } = await started();
    expect(fx.sessions.snapshot(id).nextStep).toBeNull();
    fx.bus.clear();
    expect(await wrapUp(fx).handler({ recap: "Tests pass; docs not updated.", ask: "Update the docs?", actions: [{ label: "Yes" }, { label: "Not now" }] })).toBe("Shown to the user.");
    const step = { recap: "Tests pass; docs not updated.", ask: "Update the docs?", actions: [{ label: "Yes" }, { label: "Not now" }], at: "2026-10-31T10:00:00.000Z" };
    expect(fx.bus.ofType("next_step")).toEqual([{ type: "next_step", sessionId: id, step }]);
    expect(fx.bus.events.find((e) => e.event.type === "next_step")!.scope).toBe("session");
    expect(SessionSnapshot.parse(fx.sessions.snapshot(id)).nextStep).toEqual(step);
    expect(JSON.parse(fx.store.getSession(id)!.nextStep!)).toEqual(step);

    clock.now = new Date("2026-10-31T10:01:00.000Z");
    await wrapUp(fx).handler({ recap: "Docs updated too." });
    expect(fx.bus.ofType("next_step").at(-1)!.step).toEqual({ recap: "Docs updated too.", at: "2026-10-31T10:01:00.000Z" });
    expect(fx.sessions.snapshot(id).nextStep).toEqual({ recap: "Docs updated too.", at: "2026-10-31T10:01:00.000Z" });

    const bad = await wrapUp(fx).handler({ recap: "ok", actions: [{ label: "Yes" }] });
    expect(bad).toMatchObject({ isError: true });
    expect(fx.bus.ofType("next_step")).toHaveLength(2);
    expect(fx.sessions.snapshot(id).nextStep?.recap).toBe("Docs updated too.");
  });

  it("survives a new runtime instance (hub restart) on the same database", async () => {
    const { fx, id } = await started();
    await wrapUp(fx).handler({ recap: "Built and tested." });
    const again = runtimeFixture(() => ({ store: fx.store, clock: () => clock.now }));
    fixtures.unshift(again); // cleaned up before `fx` closes the shared store
    again.sessions.recoverAfterRestart();
    expect(again.sessions.snapshot(id).nextStep).toEqual({ recap: "Built and tested.", at: clock.now.toISOString() });
  });

  it("is cleared when the user sends the next message (stored null, next_step null broadcast once)", async () => {
    const { fx, id } = await started();
    await wrapUp(fx).handler({ recap: "Done.", ask: "Ship it?", actions: [{ label: "Ship it" }] });
    fx.bus.clear();
    await fx.sessions.send(id, msgBody("Ship it"));
    expect(fx.bus.ofType("next_step")).toEqual([{ type: "next_step", sessionId: id, step: null }]);
    expect(fx.store.getSession(id)!.nextStep).toBeNull();
    expect(fx.sessions.snapshot(id).nextStep).toBeNull();
    await idle(fx, id, 2);
    // Nothing to clear: no event.
    await fx.sessions.send(id, msgBody("and then?"));
    expect(fx.bus.ofType("next_step")).toHaveLength(1);
  });
});

describe("heads_up: validation", () => {
  it("is recorded as mcp__workstation_turn__heads_up; accepts protocol HeadsUpInput, refuses anything else", async () => {
    expect(HEADS_UP_TOOL_NAME).toBe("mcp__workstation_turn__heads_up");
    const t = headsUpTool();
    expect(t.name).toBe("heads_up");
    const good = [{ text: "This deletes the build cache." }, { text: "x".repeat(300), detail: "y".repeat(2000) }, { text: "  padded  " }];
    for (const g of good) {
      expect(checkHeadsUp(g)).toBeNull();
      expect(await t.handler(g)).toBe("Shown to the user.");
    }
    expect(HeadsUpInput.safeParse(good[1]).success).toBe(true);
    const bad: Record<string, unknown>[] = [{}, { text: "" }, { text: "   " }, { text: 42 }, { text: "x".repeat(301) }, { text: "ok", detail: "y".repeat(2001) }, { text: "ok", detail: 1 }];
    for (const b of bad) {
      expect(checkHeadsUp(b), JSON.stringify(b)).toMatch(/^Not shown: /);
      expect(await t.handler(b)).toMatchObject({ isError: true });
    }
  });
});

describe("heads_up in Claude sessions", () => {
  async function started(kind: "code" | "chat", incognito = false): Promise<{ fx: RuntimeFixture; id: string }> {
    const fx = runtimeFixture();
    fixtures.push(fx);
    fx.store.ensureUser("alice");
    const id = incognito
      ? fx.sessions.create({ user: "alice", kind: "chat", cwd: ".chat", model: "default", permissionMode: "default", effort: null, incognito: true }).id
      : fx.newSession(kind);
    await fx.sessions.send(id, msgBody("hi"));
    await idle(fx, id, 1);
    return { fx, id };
  }
  const promptOf = (fx: RuntimeFixture): string => {
    const p = fx.sdk.last.options.systemPrompt;
    return typeof p === "string" ? p : String((p as { append?: string }).append ?? "");
  };

  for (const [label, kind, incognito] of [["code", "code", false], ["chat", "chat", false], ["incognito chat", "chat", true]] as const) {
    it(`${label}: on the workstation_turn server, pre-approved (no card), described in the prompt`, async () => {
      const { fx } = await started(kind, incognito);
      const o = fx.sdk.last.options;
      expect(fx.sdk.mcpServers.get(TURN_SERVER)!.map((t) => t.name)).toContain(HEADS_UP_TOOL);
      expect(o.allowedTools).toContain(HEADS_UP_TOOL_NAME);
      fx.bus.clear();
      expect(await fx.sdk.last.askPermission(HEADS_UP_TOOL_NAME, { text: "Careful." })).toMatchObject({ behavior: "allow" });
      expect(fx.bus.ofType("permission_request")).toEqual([]);
      const tool = fx.sdk.mcpServers.get(TURN_SERVER)!.find((t) => t.name === HEADS_UP_TOOL)!;
      expect(await tool.handler({ text: "Careful." })).toBe("Shown to the user.");
      expect(promptOf(fx)).toContain(HEADS_UP_GUIDANCE);
    });
  }
});
