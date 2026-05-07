import { Text } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, forwardRef, useRef } from "react";
import type { Group } from "three";
import type { Room } from "colyseus.js";
import type { HitEvent, PlayerDamagedEvent, RoomState } from "@mp/shared";
import { SnapshotBuffer } from "../net/snapshots.js";
import { hudState } from "../net/hudState.js";
import type { LocalPredictor } from "../net/prediction.js";

const POOL_SIZE = 30;
const RISE_PER_SEC = 1.0;
const LIFETIME_S = 0.8;

type Slot = {
  active: boolean;
  age: number;
  text: string;
  x: number; y: number; z: number;
  color: string;
};

type Props = {
  room: Room<RoomState>;
  predictor: LocalPredictor;
  buffers: Map<string, SnapshotBuffer>;
  enemyBuffers: Map<number, SnapshotBuffer>;
};

export const DamageNumberPool = forwardRef<unknown, Props>(function DamageNumberPool(
  { room, predictor, buffers, enemyBuffers },
  _ref,
) {
  const slots = useRef<Slot[]>(
    Array.from({ length: POOL_SIZE }, () => ({
      active: false, age: 0, text: "", x: 0, y: 0, z: 0, color: "#ffffff",
    })),
  );
  const groupRefs = useRef<(Group | null)[]>(Array.from({ length: POOL_SIZE }, () => null));

  function spawn(text: string, x: number, z: number, color: string) {
    let idx = slots.current.findIndex((s) => !s.active);
    if (idx === -1) {
      // Drop oldest.
      let oldestAge = -1, oldestIdx = 0;
      slots.current.forEach((s, i) => { if (s.age > oldestAge) { oldestAge = s.age; oldestIdx = i; } });
      idx = oldestIdx;
    }
    slots.current[idx] = { active: true, age: 0, text, x, y: 1.5, z, color };
  }

  useEffect(() => {
    const offHit = room.onMessage("hit", (msg: HitEvent) => {
      const buf = enemyBuffers.get(msg.enemyId);
      const sample = buf?.sample(performance.now() - hudState.interpDelayMs);
      if (sample) spawn(String(msg.damage), sample.x, sample.z, "#ffffff");
    });
    const offPlayerDamaged = room.onMessage("player_damaged", (msg: PlayerDamagedEvent) => {
      let x = msg.x, z = msg.z;
      if (msg.playerId === room.sessionId) {
        x = predictor.renderX; z = predictor.renderZ;
      } else {
        const sample = buffers.get(msg.playerId)?.sample(performance.now() - hudState.interpDelayMs);
        if (sample) { x = sample.x; z = sample.z; }
      }
      spawn(String(msg.damage), x, z, "#ff5a5a");
    });
    return () => { offHit(); offPlayerDamaged(); };
  }, [room, predictor, buffers, enemyBuffers]);

  useFrame((_, dt) => {
    for (let i = 0; i < POOL_SIZE; i++) {
      const s = slots.current[i]!;
      const ref = groupRefs.current[i];
      if (!ref) continue;
      if (!s.active) {
        ref.visible = false;
        continue;
      }
      s.age += dt;
      if (s.age >= LIFETIME_S) {
        s.active = false;
        ref.visible = false;
        continue;
      }
      ref.visible = true;
      ref.position.set(s.x, s.y + s.age * RISE_PER_SEC, s.z);
      // The drei Text exposes `material.opacity` via fillOpacity prop or via mesh.material.
      const text = ref.children[0] as { material?: { opacity: number; transparent: boolean } } | undefined;
      if (text?.material) {
        text.material.transparent = true;
        text.material.opacity = Math.max(0, 1 - s.age / LIFETIME_S);
      }
    }
  });

  return (
    <>
      {slots.current.map((s, i) => (
        <group key={i} ref={(el) => { groupRefs.current[i] = el; }}>
          <Text fontSize={0.35} color={s.color} outlineColor="#000" outlineWidth={0.02}>
            {s.text}
          </Text>
        </group>
      ))}
    </>
  );
});
