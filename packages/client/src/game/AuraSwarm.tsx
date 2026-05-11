import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { InstancedMesh, Matrix4, Quaternion, Vector3 } from "three";
import type { Room } from "@colyseus/sdk";
import type { Player, RoomState } from "@mp/shared";
import { WEAPON_KINDS, isAuraWeapon, statsAt } from "@mp/shared";
import type { LocalPredictor } from "../net/prediction.js";
import type { SnapshotBuffer } from "../net/snapshots.js";
import { hudState } from "../net/hudState.js";

// Must agree with the server's MAX_PLAYERS in packages/server/src/GameRoom.ts.
// One aura per player at most (Kronos is the only aura weapon today; even
// a future second aura weapon would be visually subordinate to the first
// — auras don't stack visually like orbs do).
const MAX_PLAYERS = 10;
const AURA_CAPACITY = MAX_PLAYERS;

// Visual lift: the dome's bottom rim sits at terrain level, with the dome
// extending upward by its radius. A small lift above ground avoids
// z-fighting with terrain and the player cube's base.
const AURA_GROUND_LIFT = 0.05;

export type AuraSwarmProps = {
  room: Room<RoomState>;
  predictor: LocalPredictor;
  buffers: Map<string, SnapshotBuffer>;
};

const IDENTITY_QUAT = new Quaternion();

/**
 * M8 US-010: per-player aura visualization. Walks room.state.players each
 * frame and renders one translucent hemispherical dome per player who has
 * an aura weapon equipped (Kronos today). Per-instance scale matches the
 * aura's actual radius so the visual reads as the real hit zone.
 *
 * Render position mirrors OrbitSwarm: predictor for the local player,
 * interpolated snapshot buffer for remote players. This keeps the dome
 * pinned to where the player visibly is, NOT where the schema says they
 * are (~100ms behind for remotes).
 *
 * No per-frame state — the dome is a closed-form function of (player
 * position, weapon level). Two clients with the same room state render
 * identical domes (rule 12 spirit: cross-client deterministic rendering).
 */
export function AuraSwarm({ room, predictor, buffers }: AuraSwarmProps) {
  const meshRef = useRef<InstancedMesh>(null);
  const matrix = useMemo(() => new Matrix4(), []);
  const position = useMemo(() => new Vector3(), []);
  const scaleVec = useMemo(() => new Vector3(), []);

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    let i = 0;

    room.state.players.forEach((player: Player) => {
      // Find the player's aura weapon (if any). Iterating ArraySchema is
      // cheap (≤ a handful of weapons per player). The first aura weapon
      // wins — multi-aura visualization is out of scope (no second aura
      // weapon exists in M8).
      let auraKind = -1;
      let auraLevel = 0;
      player.weapons.forEach((w) => {
        if (auraKind !== -1) return; // already found one
        const def = WEAPON_KINDS[w.kind];
        if (def && isAuraWeapon(def)) {
          auraKind = w.kind;
          auraLevel = w.level;
        }
      });
      if (auraKind === -1) return;

      const def = WEAPON_KINDS[auraKind]!;
      if (!isAuraWeapon(def)) return; // unreachable; type narrowing
      const stats = statsAt(def, auraLevel);
      if (i >= AURA_CAPACITY) return;

      // Render position: predictor for local, interpolated snapshot for
      // remote players. Same time-base as OrbitSwarm + PlayerCube so the
      // dome stays pinned to the visible player position.
      let rx: number, ry: number, rz: number;
      if (player.sessionId === room.sessionId) {
        rx = predictor.renderX;
        ry = predictor.renderY;
        rz = predictor.renderZ;
      } else {
        const sample = buffers.get(player.sessionId)?.sample(performance.now() - hudState.interpDelayMs);
        if (!sample) {
          rx = player.x; ry = player.y; rz = player.z;
        } else {
          rx = sample.x; ry = sample.y; rz = sample.z;
        }
      }

      position.set(rx, ry + AURA_GROUND_LIFT, rz);
      // Per-instance uniform scale = aura radius. Base hemisphere has
      // radius 1, so scale=R gives a dome of radius R units (matches the
      // server's actual hit detection).
      scaleVec.set(stats.radius, stats.radius, stats.radius);
      matrix.compose(position, IDENTITY_QUAT, scaleVec);
      mesh.setMatrixAt(i, matrix);
      i++;
    });

    mesh.count = i;
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, AURA_CAPACITY]}
      frustumCulled={false}
    >
      {/* Hemispherical dome — upper half of a unit sphere. SphereGeometry
          (radius, widthSegments, heightSegments, phiStart, phiLength,
          thetaStart, thetaLength). thetaStart=0, thetaLength=π/2 → upper
          hemisphere. */}
      <sphereGeometry args={[1, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2]} />
      {/* Translucent blue-purple. transparent=true with low opacity reads
          as a faint magical bubble. depthWrite=false avoids the dome
          occluding things behind it via the depth buffer (transparent
          objects shouldn't write to depth). */}
      <meshBasicMaterial
        color="#9c7cff"
        transparent
        opacity={0.18}
        depthWrite={false}
      />
    </instancedMesh>
  );
}
