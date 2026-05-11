import { useMemo, useRef, useEffect } from "react";
import { useFrame } from "@react-three/fiber";
import { InstancedMesh, Matrix4 } from "three";
import type { Room } from "@colyseus/sdk";
import type { Player, RoomState } from "@mp/shared";
import {
  MAX_ORB_COUNT_EVER,
  TICK_RATE,
  WEAPON_KINDS,
  isOrbitWeapon,
  statsAt,
} from "@mp/shared";
import type { LocalPredictor } from "../net/prediction.js";
import type { SnapshotBuffer } from "../net/snapshots.js";
import type { ServerTime } from "../net/serverTime.js";
import { hudState } from "../net/hudState.js";

// Must agree with the server's MAX_PLAYERS in packages/server/src/GameRoom.ts.
// The client doesn't import server constants, so this is a deliberate copy.
const MAX_PLAYERS = 10;
// M7 US-013: orbit Y comes from the player's Y (not a constant) — when
// the player jumps the orbs lift with them. ORB_LIFT is the small offset
// above the player's feet that keeps the orbs visually centered on the
// torso/cube.
const ORB_LIFT = 0.7;
const ORB_CAPACITY = MAX_PLAYERS * MAX_ORB_COUNT_EVER;
const SIM_DT_MS = 1000 / TICK_RATE; // 50 ms — matches server tick interval
// Cap sub-tick extrapolation if no new tick has arrived (e.g. tab
// backgrounded or server stalled). 2 ticks of forward extrapolation
// keeps the orbs spinning briefly before they freeze.
const MAX_SUB_TICK_EXTRAPOLATION = 2;

export type OrbitSwarmProps = {
  room: Room<RoomState>;
  predictor: LocalPredictor;
  buffers: Map<string, SnapshotBuffer>;
  serverTime: ServerTime;
};

/**
 * Per spec §AD2: orbit positions are computed deterministically from
 * (state.tick, player render-pos, weapon level). Both clients reading the
 * same synced tick produce the same orb angles. Player render-pos is the
 * predictor for the local player and the interpolated buffer sample for
 * remote players — matches PlayerCube so orbs visually stick to the
 * player at all times.
 *
 * Sub-tick smoothing: state.tick only updates at 20 Hz, so reading it
 * directly each render frame produced visible 50-ms steps in the orb
 * angle. We anchor on the latest observed tick + the server-time it
 * arrived at, then advance the angle smoothly between ticks using
 * `serverTime.serverNow()`. Both clients have a converged
 * `serverTimeOffsetMs`, so the smoothed tickTime stays in sync across
 * clients while rendering at 60 fps. At tick boundaries the smoothed
 * value re-anchors to the discrete `state.tick`, so the long-run phase
 * never drifts from the server's hit-detection clock.
 *
 * Single InstancedMesh with capacity MAX_PLAYERS * MAX_ORB_COUNT_EVER. No
 * per-orb attribute updates other than translation matrix.
 */
export function OrbitSwarm({ room, predictor, buffers, serverTime }: OrbitSwarmProps) {
  const meshRef = useRef<InstancedMesh>(null);
  const matrix = useMemo(() => new Matrix4(), []);
  // Anchor for sub-tick interpolation: the most recent tick value we
  // observed, plus the server-clock moment we observed it. Updated each
  // frame whenever room.state.tick advances.
  const tickAnchor = useRef({ tick: -1, atServerMs: 0 });

  useEffect(() => {
    if (meshRef.current) meshRef.current.count = 0;
  }, []);

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    // Re-anchor on each new tick so the smoothed value collapses to the
    // discrete tick at every server-tick boundary.
    const currentTick = room.state.tick;
    const nowServerMs = serverTime.serverNow();
    if (currentTick !== tickAnchor.current.tick) {
      tickAnchor.current = { tick: currentTick, atServerMs: nowServerMs };
    }
    const elapsedSinceAnchorMs = Math.max(0, nowServerMs - tickAnchor.current.atServerMs);
    const subTickFraction = Math.min(elapsedSinceAnchorMs / SIM_DT_MS, MAX_SUB_TICK_EXTRAPOLATION);
    const tickTime = (tickAnchor.current.tick + subTickFraction) / TICK_RATE;
    let i = 0;

    room.state.players.forEach((player: Player) => {
      // Player render position: predictor for local, interpolated remote.
      let rx: number;
      let ry: number;
      let rz: number;
      if (player.sessionId === room.sessionId) {
        // Use the smoothed render-pos PlayerCube publishes each frame —
        // predictor.predictedX/Y/Z only updates at 20Hz, which makes the
        // orb attach point step visibly when moving. PlayerCube renders
        // before us in JSX/mount order, so renderX/Y/Z is current-frame.
        rx = predictor.renderX;
        ry = predictor.renderY;
        rz = predictor.renderZ;
      } else {
        const sample = buffers.get(player.sessionId)?.sample(performance.now() - hudState.interpDelayMs);
        if (!sample) {
          rx = player.x;
          ry = player.y;
          rz = player.z;
        } else {
          rx = sample.x;
          ry = sample.y;
          rz = sample.z;
        }
      }

      player.weapons.forEach((weapon) => {
        const def = WEAPON_KINDS[weapon.kind];
        if (!def || !isOrbitWeapon(def)) return;
        const stats = statsAt(def, weapon.level);

        for (let k = 0; k < stats.orbCount; k++) {
          if (i >= ORB_CAPACITY) return;
          const angle = tickTime * stats.orbAngularSpeed + k * (2 * Math.PI / stats.orbCount);
          matrix.makeTranslation(
            rx + Math.cos(angle) * stats.orbRadius,
            ry + ORB_LIFT,
            rz + Math.sin(angle) * stats.orbRadius,
          );
          mesh.setMatrixAt(i, matrix);
          i++;
        }
      });
    });

    mesh.count = i;
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    // No castShadow — same Three 0.164 InstancedMesh + shadow-camera
    // landmine that EnemySwarm/ProjectileSwarm dodge.
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, ORB_CAPACITY]}
      frustumCulled={false}
    >
      <sphereGeometry args={[0.25, 10, 8]} />
      <meshStandardMaterial color="#7af0ff" emissive="#7af0ff" emissiveIntensity={1.0} />
    </instancedMesh>
  );
}
