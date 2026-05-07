import { useCallback, useEffect, useState } from "react";
import type { Room } from "colyseus.js";
import type { RoomState } from "@mp/shared";
import { Landing } from "./Landing.js";
import { GameView } from "./game/GameView.js";
import { colyseusClient, waitForCode } from "./net/client.js";

type Phase =
  | { kind: "landing"; initialName?: string; initialCode?: string; banner?: string }
  | { kind: "playing"; room: Room<RoomState>; code: string; name: string; token: string }
  | { kind: "reconnecting"; code: string; name: string; token: string }
  | { kind: "disconnected"; code: string; name: string };

const OVERLAY: React.CSSProperties = {
  position: "fixed", inset: 0,
  background: "rgba(0,0,0,0.6)", color: "white",
  display: "flex", flexDirection: "column",
  alignItems: "center", justifyContent: "center",
  font: "16px/1.4 system-ui, sans-serif",
  zIndex: 2000,
};

export function App() {
  const [phase, setPhase] = useState<Phase>({ kind: "landing" });

  // Drive the reconnect attempt whenever we enter the reconnecting phase.
  useEffect(() => {
    if (phase.kind !== "reconnecting") return;
    let cancelled = false;
    (async () => {
      try {
        const room = await colyseusClient.reconnect<RoomState>(phase.token);
        await waitForCode(room);
        if (cancelled) {
          await room.leave();
          return;
        }
        setPhase({
          kind: "playing",
          room,
          code: room.state.code,
          name: phase.name,
          token: room.reconnectionToken,
        });
      } catch {
        if (!cancelled) {
          setPhase({ kind: "disconnected", code: phase.code, name: phase.name });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [phase]);

  // Stable handler for unexpected room.onLeave so GameView's effect doesn't
  // tear down on every App re-render. Captures the latest playing-phase
  // values via the closure recreated when phase changes.
  const onUnexpectedLeave = useCallback(() => {
    if (phase.kind !== "playing") return;
    setPhase({
      kind: "reconnecting",
      code: phase.code,
      name: phase.name,
      token: phase.token,
    });
  }, [phase]);

  // Consent leave — player clicked "Leave room" on RunOverPanel. Route back
  // to the landing screen pre-filled with the same name and code.
  const onConsentLeave = useCallback(() => {
    if (phase.kind !== "playing") return;
    setPhase({
      kind: "landing",
      initialName: phase.name,
      initialCode: phase.code,
    });
  }, [phase]);

  if (phase.kind === "landing") {
    return (
      <Landing
        initialName={phase.initialName}
        initialCode={phase.initialCode}
        banner={phase.banner}
        onJoined={(room, name) => {
          setPhase({
            kind: "playing",
            room,
            code: room.state.code,
            name,
            token: room.reconnectionToken,
          });
        }}
      />
    );
  }

  if (phase.kind === "reconnecting") {
    return (
      <div style={OVERLAY}>
        <div>Reconnecting…</div>
        <div style={{ opacity: 0.7, marginTop: 8 }}>room {phase.code}</div>
      </div>
    );
  }

  if (phase.kind === "disconnected") {
    return (
      <div style={OVERLAY}>
        <div>Disconnected</div>
        <button
          style={{ marginTop: 16, padding: "8px 16px" }}
          onClick={() => setPhase({
            kind: "landing",
            initialName: phase.name,
            initialCode: phase.code,
            banner: "session ended — rejoin?",
          })}
        >
          Rejoin
        </button>
      </div>
    );
  }

  // playing — key on phase.token so a new Room object (even with the same
  // sessionId after a successful reconnect) always re-mounts GameView and
  // gives LocalPredictor a clean slate. The token rotates on each connection.
  return (
    <GameView
      key={phase.token}
      room={phase.room}
      onUnexpectedLeave={onUnexpectedLeave}
      onConsentLeave={onConsentLeave}
    />
  );
}
