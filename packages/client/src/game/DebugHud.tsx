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
  const lastFrameMs = useRef<number | null>(null);

  useEffect(() => {
    const tick = () => {
      const now = performance.now();
      if (lastFrameMs.current != null) {
        const dt = now - lastFrameMs.current;
        if (dt > 0) {
          // Exponential smoothing — keeps the number stable enough to read.
          const instantFps = 1000 / dt;
          hudState.fps = hudState.fps === 0
            ? instantFps
            : hudState.fps * 0.9 + instantFps * 0.1;
        }
      }
      lastFrameMs.current = now;
      force((n) => (n + 1) & 0x7fffffff);
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current != null) cancelAnimationFrame(raf.current);
      lastFrameMs.current = null;
    };
  }, []);

  if (!hudState.visible) return null;

  const lines = [
    `fps        ${hudState.fps.toFixed(0)}`,
    `ping       ${hudState.pingMs.toFixed(0)} ms`,
    `server tick ${hudState.serverTick}`,
    `snapshots  ${hudState.snapshotsPerSec.toFixed(1)} / s`,
    `interp     ${hudState.interpDelayMs} ms`,
    `players    ${hudState.playerCount}`,
    `recon err  ${hudState.reconErr.toFixed(3)} u`,
    `enemies    ${hudState.enemyCount}`,
    `draw calls ${hudState.enemyDrawCalls}`,
  ];
  return <div style={HUD_STYLE}>{lines.join("\n")}</div>;
}
