import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import type { Mesh } from "three";
import { SnapshotBuffer, INTERP_DELAY_MS } from "../net/snapshots.js";

export type PlayerView = {
  sessionId: string;
  name: string;
  x: number;
  y: number;
  z: number;
};

function colorFor(sessionId: string): string {
  let hash = 0;
  for (let i = 0; i < sessionId.length; i++) {
    hash = (hash * 31 + sessionId.charCodeAt(i)) | 0;
  }
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 70%, 55%)`;
}

export type PlayerCubeProps = {
  sessionId: string;
  name: string;
  buffer: SnapshotBuffer;
};

export function PlayerCube({ sessionId, buffer }: PlayerCubeProps) {
  const ref = useRef<Mesh>(null);
  const color = useMemo(() => colorFor(sessionId), [sessionId]);

  useEffect(() => {
    if (!ref.current) return;
    const sample = buffer.sample(performance.now() - INTERP_DELAY_MS);
    if (sample) ref.current.position.set(sample.x, 0.5, sample.z);
  }, [buffer]);

  useFrame(() => {
    if (!ref.current) return;
    const sample = buffer.sample(performance.now() - INTERP_DELAY_MS);
    if (!sample) return;
    ref.current.position.x = sample.x;
    ref.current.position.z = sample.z;
    ref.current.position.y = 0.5;
  });

  return (
    <mesh ref={ref} castShadow>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color={color} />
    </mesh>
  );
}
