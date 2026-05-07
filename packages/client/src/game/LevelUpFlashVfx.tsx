// packages/client/src/game/LevelUpFlashVfx.tsx
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Group, Mesh } from "three";
import type { Room } from "colyseus.js";
import type { Player, RoomState, LevelUpResolvedEvent } from "@mp/shared";
import type { LocalPredictor } from "../net/prediction.js";
import type { SnapshotBuffer } from "../net/snapshots.js";
import { hudState } from "../net/hudState.js";

const FLASH_DURATION_MS = 250;
const RING_START_RADIUS = 0.4;
const RING_END_RADIUS = 1.6;
const RING_Y = 0.05;
const MAX_FLASHES = 16; // 10 players, plenty of headroom for stacked level-ups

type FlashState = {
  playerId: string;
  startMs: number;
  meshIdx: number;
};

export type LevelUpFlashVfxProps = {
  room: Room<RoomState>;
  predictor: LocalPredictor;
  buffers: Map<string, SnapshotBuffer>;
};

/**
 * The single game-feel exception called out in the spec's non-goals
 * section. A 250ms ring flash on the leveling player. Single Group of
 * MAX_FLASHES preallocated Mesh children, scale-animated.
 */
export function LevelUpFlashVfx({ room, predictor, buffers }: LevelUpFlashVfxProps) {
  const groupRef = useRef<Group>(null);
  const flashes = useMemo<FlashState[]>(() => [], []);
  const free = useMemo<number[]>(
    () => Array.from({ length: MAX_FLASHES }, (_, i) => MAX_FLASHES - 1 - i),
    [],
  );

  useEffect(() => {
    const off = room.onMessage("level_up_resolved", (msg: LevelUpResolvedEvent) => {
      const slot = free.pop();
      if (slot === undefined) return; // out of capacity, drop
      flashes.push({
        playerId: msg.playerId,
        startMs: performance.now(),
        meshIdx: slot,
      });
    });
    return () => off();
  }, [room, flashes, free]);

  useFrame(() => {
    const group = groupRef.current;
    if (!group) return;

    const now = performance.now();

    // Hide all rings, then re-position active ones.
    for (let i = 0; i < group.children.length; i++) {
      group.children[i]!.visible = false;
    }

    let w = 0;
    for (let r = 0; r < flashes.length; r++) {
      const f = flashes[r]!;
      const elapsed = now - f.startMs;
      if (elapsed >= FLASH_DURATION_MS) {
        free.push(f.meshIdx);
        continue;
      }
      // Resolve player render-pos.
      let rx = 0, rz = 0;
      const p: Player | undefined = room.state.players.get(f.playerId);
      if (p) {
        if (f.playerId === room.sessionId) {
          rx = predictor.predictedX;
          rz = predictor.predictedZ;
        } else {
          const sample = buffers.get(f.playerId)?.sample(now - hudState.interpDelayMs);
          rx = sample?.x ?? p.x;
          rz = sample?.z ?? p.z;
        }
      }
      const t = elapsed / FLASH_DURATION_MS; // 0..1
      const radius = RING_START_RADIUS + (RING_END_RADIUS - RING_START_RADIUS) * t;
      const opacity = 1 - t;

      const mesh = group.children[f.meshIdx] as Mesh | undefined;
      if (mesh) {
        mesh.visible = true;
        mesh.position.set(rx, RING_Y, rz);
        mesh.scale.setScalar(radius);
        const mat = mesh.material as { opacity: number; transparent: boolean };
        mat.opacity = opacity;
        mat.transparent = true;
      }
      flashes[w++] = f;
    }
    flashes.length = w;
  });

  return (
    <group ref={groupRef}>
      {Array.from({ length: MAX_FLASHES }).map((_, i) => (
        <mesh key={i} visible={false} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.9, 1.0, 24]} />
          <meshBasicMaterial color="#ffd24a" transparent opacity={0} depthWrite={false} />
        </mesh>
      ))}
    </group>
  );
}
