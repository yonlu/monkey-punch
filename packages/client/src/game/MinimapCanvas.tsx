import { useEffect, useRef } from "react";
import type { Room } from "colyseus.js";
import type { RoomState } from "@mp/shared";
import { MAP_RADIUS } from "@mp/shared";
import type { LocalPredictor } from "../net/prediction.js";

const CANVAS_SIZE = 200;
const SCALE = (CANVAS_SIZE / 2 - 6) / MAP_RADIUS;   // inscribed circle, 6px margin

function colorFor(sessionId: string): string {
  let hash = 0;
  for (let i = 0; i < sessionId.length; i++) hash = (hash * 31 + sessionId.charCodeAt(i)) | 0;
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 70%, 55%)`;
}

type Props = { room: Room<RoomState>; predictor: LocalPredictor };

export function MinimapCanvas({ room, predictor }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    const cx = CANVAS_SIZE / 2;
    const cy = CANVAS_SIZE / 2;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

      // Boundary ring.
      ctx.strokeStyle = "rgba(90, 138, 255, 0.5)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, MAP_RADIUS * SCALE, 0, Math.PI * 2);
      ctx.stroke();

      // Enemies — low-alpha red dots; clustering forms a haze naturally.
      ctx.fillStyle = "rgba(255, 80, 80, 0.4)";
      room.state.enemies.forEach((e) => {
        const px = cx + e.x * SCALE;
        const py = cy + e.z * SCALE;
        ctx.fillRect(px - 1, py - 1, 2, 2);
      });

      // Remote players — 3x3 hue squares.
      const localId = room.sessionId;
      let localFacingX = 0, localFacingZ = 1;
      let localX = predictor.renderX;
      let localZ = predictor.renderZ;
      room.state.players.forEach((p) => {
        if (p.sessionId === localId) {
          localFacingX = p.facingX;
          localFacingZ = p.facingZ;
          return;
        }
        ctx.fillStyle = colorFor(p.sessionId);
        const px = cx + p.x * SCALE;
        const py = cy + p.z * SCALE;
        ctx.fillRect(px - 1.5, py - 1.5, 3, 3);
      });

      // Local player — yellow triangle pointed along facing.
      ctx.save();
      ctx.translate(cx + localX * SCALE, cy + localZ * SCALE);
      ctx.rotate(Math.atan2(localFacingX, -localFacingZ));
      ctx.fillStyle = "#ffd34a";
      ctx.beginPath();
      ctx.moveTo(0, -5);
      ctx.lineTo(4, 4);
      ctx.lineTo(-4, 4);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [room, predictor]);

  return (
    <canvas
      ref={ref}
      width={CANVAS_SIZE}
      height={CANVAS_SIZE}
      style={{
        position: "absolute", top: 12, right: 12,
        width: CANVAS_SIZE, height: CANVAS_SIZE,
        background: "rgba(0,0,0,0.55)",
        border: "1px solid #4a5d70", borderRadius: 4,
        pointerEvents: "none",
      }}
    />
  );
}
