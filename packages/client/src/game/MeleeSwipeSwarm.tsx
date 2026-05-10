import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { InstancedMesh, Matrix4, Quaternion, Vector3, Color } from "three";
import type { MeleeSwipeEvent } from "@mp/shared";
import type { ServerTime } from "../net/serverTime.js";
import { hudState } from "../net/hudState.js";

// M8 US-005: client-side melee swipe VFX. The server emits one
// `melee_swipe` per swing; the client tracks each in-flight swipe in a
// Map and renders a brief horizontal slash arc in front of the player.
// Lifetime ~80ms per AC; we add a small grace before pruning to absorb
// `interpDelayMs` so the rendered fade-out aligns with the rendered hit
// flashes (which arrive on the same time-base).
//
// Visuals are deliberately placeholder. Damascus and Claymore weapons
// (US-006 + US-007) will exercise this code path in playtest; a polish
// pass after the milestone can refine the slash mesh + shader.

// US-008 playtest tuning: 80ms was too brief — the slash flashed and was
// gone before you could read which weapon hit. 250ms gives the brain a
// moment to register the swing direction and the crit cue. Server-side
// timing is unaffected (damage and cooldown are unchanged); only the VFX
// duration on the client extends.
export const MELEE_SWIPE_LIFETIME_MS = 250;
const MELEE_SWIPE_GRACE_MS = 50;

// Capacity bound — far more than typical concurrent swipes (a high-tempo
// Damascus at L5 fires every 0.25s; a single player can have at most ~4
// in flight at once across all weapons).
const MELEE_SWIPE_MAX_CAPACITY = 32;

export type ActiveMeleeSwipe = {
  id: number;
  msg: MeleeSwipeEvent;
  startMs: number;
};

export type MeleeSwipeSwarmProps = {
  swipes: Map<number, ActiveMeleeSwipe>;
  serverTime: ServerTime;
};

const Y_AXIS = new Vector3(0, 1, 0);
const FORWARD_Z = new Vector3(0, 0, 1);
const COLOR_DEFAULT = new Color("#cfe5ff"); // cool white-blue
const COLOR_CRIT = new Color("#ffe066");    // warm yellow

export function MeleeSwipeSwarm({ swipes, serverTime }: MeleeSwipeSwarmProps) {
  const meshRef = useRef<InstancedMesh>(null);
  const matrix = useMemo(() => new Matrix4(), []);
  const position = useMemo(() => new Vector3(), []);
  const facingVec = useMemo(() => new Vector3(), []);
  const yawQuat = useMemo(() => new Quaternion(), []);
  const tiltQuat = useMemo(() => new Quaternion(), []);
  const composedQuat = useMemo(() => new Quaternion(), []);
  const scaleVec = useMemo(() => new Vector3(), []);

  // The placeholder geometry is a flat thin disc (CircleGeometry) sized to
  // the weapon's range; rendered semi-transparent and FADED OVER ITS
  // LIFETIME. Per-instance scale uniformly applies the weapon's range so
  // arcAngle isn't visually represented yet — that's a polish-pass concern.

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const renderServerTimeMs = serverTime.serverNow() - hudState.interpDelayMs;
    let i = 0;

    for (const [id, sw] of swipes) {
      const elapsedMs = renderServerTimeMs - sw.msg.serverSwingTimeMs;
      // Render-time clamp: skip swipes that haven't visually started yet
      // (negative elapsed) or have visually expired.
      if (elapsedMs < 0) continue;
      if (elapsedMs >= MELEE_SWIPE_LIFETIME_MS + MELEE_SWIPE_GRACE_MS) {
        // Expired — the GameView setTimeout cleanup is the primary
        // pruner, but as a backstop also drop here so the InstancedMesh
        // count never lags reality.
        swipes.delete(id);
        continue;
      }
      if (i >= MELEE_SWIPE_MAX_CAPACITY) break;

      const t = elapsedMs / MELEE_SWIPE_LIFETIME_MS; // 0..1
      // Two-phase brightness: the first 30% of the lifetime is the bright
      // strike flash (peak intensity); the remaining 70% fades out. Gives
      // a visible "pop then trail" feel rather than a linear fade.
      const intensity = t < 0.3 ? 1.0 : 1.0 - (t - 0.3) / 0.7;
      // Slash visibly EXPANDS over its lifetime — the swing extends through
      // the arc rather than appearing as a static stamp. Grows from 80% to
      // 110% of full size.
      const scaleEnvelope = 0.8 + 0.3 * t;

      // US-008 round 2: disc center sits AT the player (not halfRange
      // forward) — paired with the corrected geometry, the disc's flat
      // edge passes through the player and the bulge fans forward in
      // facing direction. Combined with radius 1.0 in the geometry +
      // per-instance scale = range, the disc's forward extent matches
      // the weapon's actual hit reach (Damascus L1 = 2.2; Claymore L1
      // = 3.5). Y bumped 0.15 to sit above terrain (no z-fighting).
      position.set(
        sw.msg.originX,
        sw.msg.originY + 0.15,
        sw.msg.originZ,
      );

      // Orient: yaw from atan2(facingX, facingZ); tilt -90° about X so a
      // CircleGeometry (default in XY plane) lays flat in XZ. Compose:
      // yaw * tilt — yaw applied last in world space.
      facingVec.set(sw.msg.facingX, 0, sw.msg.facingZ);
      yawQuat.setFromUnitVectors(FORWARD_Z, facingVec);
      tiltQuat.setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
      composedQuat.copy(yawQuat).multiply(tiltQuat);

      // Scale by range × expanding envelope. Damascus L1 range 2.2 →
      // base scale 2.2; Claymore range 3.5 → 3.5. Envelope multiplies on
      // top so the visible swing reads as a "swooping" motion.
      const visualScale = sw.msg.range * scaleEnvelope;
      scaleVec.set(visualScale, visualScale, visualScale);

      matrix.compose(position, composedQuat, scaleVec);
      mesh.setMatrixAt(i, matrix);
      // Per-instance color; brighter on crit. Multiply by intensity for
      // emissive-like dimming.
      const color = sw.msg.isCrit ? COLOR_CRIT : COLOR_DEFAULT;
      const r = color.r * intensity;
      const g = color.g * intensity;
      const b = color.b * intensity;
      mesh.setColorAt(i, new Color(r, g, b));
      i++;
    }

    mesh.count = i;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, MELEE_SWIPE_MAX_CAPACITY]}
      frustumCulled={false}
    >
      {/* US-008 playtest tuning round 2: thetaStart fixed so the disc
          bulges in player facing direction (was thetaStart=-π/2 which
          put the bulge perpendicular to facing — invisible for narrow
          weapons like Damascus).
          Frame chain: CircleGeometry's bulge at -Y → tilt -π/2 about X
          maps -Y to +Z (local frame after tilt) → yaw quaternion rotates
          local +Z onto world facing direction. Net: half-disc fans
          OUTWARD in front of the player.
          thetaStart=-π, thetaLength=π → vertices span angles -π to 0
          (the lower half of the original CircleGeometry's circle). */}
      <circleGeometry args={[1.0, 24, -Math.PI, Math.PI]} />
      <meshBasicMaterial color="#ffffff" transparent opacity={0.7} depthWrite={false} />
    </instancedMesh>
  );
}
