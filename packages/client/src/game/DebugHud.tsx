import { useEffect, useRef, useState } from "react";
import { hudState } from "../net/hudState.js";

const HUD_STYLE: React.CSSProperties = {
  position: "fixed",
  top: 8,
  right: 8,
  padding: "6px 10px",
  background: "rgba(0,0,0,0.7)",
  color: "#0f0",
  font: "12px/1.4 ui-monospace, Menlo, monospace",
  pointerEvents: "none",
  whiteSpace: "pre",
  zIndex: 1000,
};

export function DebugHud() {
  const [, force] = useState(0);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    const tick = () => {
      force((n) => (n + 1) & 0x7fffffff);
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current != null) cancelAnimationFrame(raf.current);
    };
  }, []);

  if (!hudState.visible) return null;

  const lines = [
    `ping       ${hudState.pingMs.toFixed(0)} ms`,
    `server tick ${hudState.serverTick}`,
    `snapshots  ${hudState.snapshotsPerSec.toFixed(1)} / s`,
    `interp     ${hudState.interpDelayMs} ms`,
    `players    ${hudState.playerCount}`,
    `recon err  ${hudState.reconErr.toFixed(3)} u`,
    `enemies    ${hudState.enemyCount}`,
    `draw calls ${hudState.enemyDrawCalls}`,
    `snap bytes ${hudState.lastSnapshotBytes} B`,
  ];
  return <div style={HUD_STYLE}>{lines.join("\n")}</div>;
}
