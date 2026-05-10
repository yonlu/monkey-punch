import { Text } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, forwardRef, useRef, useState } from "react";
import type { Group } from "three";
import type { Room } from "colyseus.js";
import type { HitEvent, PlayerDamagedEvent, RoomState } from "@mp/shared";
import { SnapshotBuffer } from "../net/snapshots.js";
import { hudState } from "../net/hudState.js";
import type { LocalPredictor } from "../net/prediction.js";

const POOL_SIZE = 30;
const RISE_PER_SEC = 1.0;
const LIFETIME_S = 0.8;
// Floating numbers render `BASE_LIFT` above the impact altitude (so the
// glyph appears around chest height rather than at the enemy's feet) and
// rise from there. Pre-US-013 this was a constant because the world was
// flat; now `slot.y` is the impact altitude and we add this lift on top.
const BASE_LIFT = 1.5;

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

  // Re-render driver — slot text/color live in a ref (mutated by useFrame +
  // spawn), so React doesn't see them change unless we force a re-render.
  // Without this, the JSX `<Text>{s.text}</Text>` reads stale props,
  // particularly during a runEnded frozen state where parent re-renders stop.
  // Pattern mirrors CombatVfx.tsx.
  const [, forceRender] = useState(0);

  function spawn(text: string, x: number, y: number, z: number, color: string) {
    let idx = slots.current.findIndex((s) => !s.active);
    if (idx === -1) {
      // Drop oldest.
      let oldestAge = -1, oldestIdx = 0;
      slots.current.forEach((s, i) => { if (s.age > oldestAge) { oldestAge = s.age; oldestIdx = i; } });
      idx = oldestIdx;
    }
    slots.current[idx] = { active: true, age: 0, text, x, y, z, color };
  }

  useEffect(() => {
    const offHit = room.onMessage("hit", (msg: HitEvent) => {
      // M7 US-013: hit altitude comes from the server-authoritative
      // payload (msg.y); X/Z are still sampled from the interpolated
      // enemy buffer so the glyph anchors to the rendered enemy
      // position rather than a server-tick-discrete one.
      const buf = enemyBuffers.get(msg.enemyId);
      const sample = buf?.sample(performance.now() - hudState.interpDelayMs);
      const x = sample?.x ?? msg.x;
      const z = sample?.z ?? msg.z;
      spawn(String(msg.damage), x, msg.y, z, "#ffffff");
    });
    const offPlayerDamaged = room.onMessage("player_damaged", (msg: PlayerDamagedEvent) => {
      // M7 US-013: per-axis fallback. msg.y is the player's authoritative
      // altitude at hit; the interpolated buffer's Y matches it within
      // snapshot tolerance for remote players, while predictor.renderY
      // matches it for the local player.
      let x = msg.x, y = msg.y, z = msg.z;
      if (msg.playerId === room.sessionId) {
        x = predictor.renderX; y = predictor.renderY; z = predictor.renderZ;
      } else {
        const sample = buffers.get(msg.playerId)?.sample(performance.now() - hudState.interpDelayMs);
        if (sample) { x = sample.x; y = sample.y; z = sample.z; }
      }
      spawn(String(msg.damage), x, y, z, "#ff5a5a");
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
      ref.position.set(s.x, s.y + BASE_LIFT + s.age * RISE_PER_SEC, s.z);
      // The drei Text exposes `material.opacity` via fillOpacity prop or via mesh.material.
      const text = ref.children[0] as { material?: { opacity: number; transparent: boolean } } | undefined;
      if (text?.material) {
        text.material.transparent = true;
        text.material.opacity = Math.max(0, 1 - s.age / LIFETIME_S);
      }
    }
    // Re-evaluate JSX so each slot's text/color reflects the latest spawn().
    forceRender((n) => (n + 1) & 0x7fffffff);
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
