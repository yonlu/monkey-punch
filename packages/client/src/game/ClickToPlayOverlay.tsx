import { useEffect, useState } from "react";
import { isPointerLocked, requestCameraLock, subscribeLock } from "../camera.js";

type Props = {
  /** Ref to the WebGL canvas. requestPointerLock is called on it. */
  canvasRef: React.MutableRefObject<HTMLCanvasElement | null>;
};

/**
 * Full-canvas overlay shown whenever pointer lock is NOT engaged: at
 * initial load, after ESC, after tab-out, after a pointerlockerror.
 * Clicking the overlay re-requests pointer lock on the canvas (must
 * happen inside a user-gesture handler, which an onClick is).
 *
 * Renders nothing while locked so gameplay receives all clicks (e.g. for
 * future click-to-attack).
 */
export function ClickToPlayOverlay({ canvasRef }: Props): JSX.Element | null {
  const [locked, setLocked] = useState<boolean>(isPointerLocked());

  useEffect(() => subscribeLock(setLocked), []);

  if (locked) return null;

  return (
    <div
      onClick={() => {
        const canvas = canvasRef.current;
        if (canvas) requestCameraLock(canvas);
      }}
      style={{
        position: "absolute",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        // Above the canvas (default z-index 0) but BELOW interactive
        // gameplay UI such as RunOverPanel (z=10) and LevelUpOverlay
        // (z=1100). Otherwise releasing the cursor (ESC) to click the
        // run-over "Leave room" button traps the user behind a re-lock
        // request.
        zIndex: 5,
        userSelect: "none",
      }}
    >
      <div
        style={{
          color: "#fff",
          fontSize: 28,
          fontFamily: "system-ui, sans-serif",
          fontWeight: 600,
          letterSpacing: 1,
        }}
      >
        Click to play
      </div>
      <div
        style={{
          color: "#bbb",
          fontSize: 14,
          fontFamily: "system-ui, sans-serif",
          marginTop: 8,
        }}
      >
        ESC to release the cursor
      </div>
    </div>
  );
}
