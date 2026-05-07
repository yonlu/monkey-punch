import type { Room } from "colyseus.js";
import { useEffect, useState } from "react";
import { getStateCallbacks } from "colyseus.js";
import type { RoomState, Player } from "@mp/shared";
import { TICK_RATE } from "@mp/shared";

type Row = {
  sessionId: string;
  name: string;
  level: number;
  kills: number;
  xpGained: number;
  joinTick: number;
  weapons: { kind: number; level: number }[];
};

type Props = { room: Room<RoomState>; onLeave: () => void };

export function RunOverPanel({ room, onLeave }: Props) {
  const [runEnded, setRunEnded] = useState<boolean>(room.state.runEnded);
  const [runEndedTick, setRunEndedTick] = useState<number>(room.state.runEndedTick);
  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    const $ = getStateCallbacks(room);
    const offRun = $(room.state).listen("runEnded", (v) => setRunEnded(!!v));
    const offTick = $(room.state).listen("runEndedTick", (v) => setRunEndedTick(Number(v)));
    return () => { offRun(); offTick(); };
  }, [room]);

  useEffect(() => {
    if (!runEnded) return;
    const next: Row[] = [];
    room.state.players.forEach((p: Player) => {
      next.push({
        sessionId: p.sessionId,
        name: p.name || "Player",
        level: p.level,
        kills: p.kills,
        xpGained: p.xpGained,
        joinTick: p.joinTick,
        weapons: Array.from(p.weapons.values()).map((w) => ({ kind: w.kind, level: w.level })),
      });
    });
    setRows(next);
  }, [runEnded, room]);

  if (!runEnded) return null;

  function formatSurvived(joinTick: number) {
    const secs = Math.max(0, (runEndedTick - joinTick) / TICK_RATE);
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  return (
    <div style={{
      position: "absolute", inset: 0,
      background: "rgba(8,12,18,0.78)",
      display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", gap: 16,
      fontFamily: "monospace", color: "#eee", zIndex: 10,
    }}>
      <h2 style={{ color: "#ff8a52", margin: 0 }}>Run Over</h2>
      <table style={{ borderCollapse: "collapse", fontSize: 14 }}>
        <thead>
          <tr>
            <th style={{ padding: "4px 12px", borderBottom: "1px solid #4a5d70", textAlign: "left" }}>player</th>
            <th style={{ padding: "4px 12px", borderBottom: "1px solid #4a5d70", textAlign: "left" }}>level</th>
            <th style={{ padding: "4px 12px", borderBottom: "1px solid #4a5d70", textAlign: "left" }}>kills</th>
            <th style={{ padding: "4px 12px", borderBottom: "1px solid #4a5d70", textAlign: "left" }}>xp</th>
            <th style={{ padding: "4px 12px", borderBottom: "1px solid #4a5d70", textAlign: "left" }}>survived</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.sessionId}>
              <td style={{ padding: "4px 12px" }}>{r.name}{r.sessionId === room.sessionId ? " (you)" : ""}</td>
              <td style={{ padding: "4px 12px" }}>{r.level}</td>
              <td style={{ padding: "4px 12px" }}>{r.kills}</td>
              <td style={{ padding: "4px 12px" }}>{r.xpGained}</td>
              <td style={{ padding: "4px 12px" }}>{formatSurvived(r.joinTick)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        onClick={() => { room.leave(true); onLeave(); }}
        style={{
          background: "#ff5252", color: "#fff",
          padding: "8px 18px", borderRadius: 4, border: "none",
          fontFamily: "inherit", cursor: "pointer",
        }}
      >Leave room</button>
    </div>
  );
}
