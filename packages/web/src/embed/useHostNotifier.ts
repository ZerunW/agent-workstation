import { useEffect, useRef } from "react";
import { toolMeta } from "../lib/toolSummary";
import { resultInfo } from "../lib/sdk";
import { addServerEventTap } from "../store/hub";
import { useSessions } from "../store/sessions";
import { post } from "./bridge";

/**
 * Mirrors session state to the macOS host: status, settings, title, permission requests/resolutions and
 * finished turns. Only changes after the first snapshot are reported (replayed history is not "new").
 */
export function useHostNotifier(sessionId: string | null): void {
  const seen = useRef({ status: "", settings: "", title: "", maxResultSeq: -1, perms: new Map<string, string>(), primed: false });

  useEffect(() => {
    const s = seen.current;
    s.status = "";
    s.settings = "";
    s.title = "";
    s.maxResultSeq = -1;
    s.perms = new Map();
    s.primed = false;
    if (!sessionId) return;

    const check = () => {
      const view = useSessions.getState().views[sessionId];
      if (!view) return;
      const session = view.session;
      if (session) {
        const status = `${session.status}|${session.queuePosition ?? ""}`;
        if (status !== s.status) {
          s.status = status;
          post({ type: "state", sessionId, status: session.status, queuePosition: session.queuePosition });
        }
        const settings = `${session.model}|${session.permissionMode}|${session.effort ?? ""}`;
        if (settings !== s.settings) {
          s.settings = settings;
          post({ type: "settings", sessionId, model: session.model, permissionMode: session.permissionMode, effort: session.effort });
        }
        if (session.title !== s.title) {
          if (s.title !== "") post({ type: "title", sessionId, title: session.title });
          s.title = session.title;
        }
      }
      if (!view.snapshotReceived) return;
      if (!s.primed) {
        // First snapshot: remember what already exists so history is not reported as new.
        s.primed = true;
        for (const m of view.messages) if (m.kind === "result") s.maxResultSeq = Math.max(s.maxResultSeq, m.seq);
        for (const p of view.permissions) s.perms.set(p.request.requestId, p.status);
        for (const p of view.permissions) {
          if (p.status === "pending") post({ type: "permission", sessionId, requestId: p.request.requestId, toolName: p.request.toolName, summary: toolMeta(p.request.toolName, p.request.input).summary });
        }
        return;
      }
      for (const m of view.messages) {
        if (m.kind === "result" && m.seq > s.maxResultSeq) {
          s.maxResultSeq = m.seq;
          const r = resultInfo(m.payload);
          post({ type: "turn_done", sessionId, costUsd: r.costUsd, durationMs: r.durationMs, subtype: r.subtype });
        }
      }
      for (const p of view.permissions) {
        const prev = s.perms.get(p.request.requestId);
        if (prev === p.status) continue;
        s.perms.set(p.request.requestId, p.status);
        if (prev === undefined && p.status === "pending") post({ type: "permission", sessionId, requestId: p.request.requestId, toolName: p.request.toolName, summary: toolMeta(p.request.toolName, p.request.input).summary });
        else if (prev === "pending") post({ type: "permission_resolved", sessionId, requestId: p.request.requestId });
      }
    };

    check();
    const unsub = useSessions.subscribe(check);
    const unTap = addServerEventTap((ev) => {
      if (ev.type === "notice") post({ type: "notice", level: ev.level, code: ev.code, message: ev.message });
      else if (ev.type === "error") post({ type: "notice", level: "error", code: ev.code, message: ev.message });
    });
    return () => {
      unsub();
      unTap();
    };
  }, [sessionId]);
}
