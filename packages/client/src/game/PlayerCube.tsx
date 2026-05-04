import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import type { Mesh } from "three";
import { SnapshotBuffer } from "../net/snapshots.js";
import { hudState } from "../net/hudState.js";
import type { LocalPredictor } from "../net/prediction.js";

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
  predictor?: LocalPredictor; // present iff this is the local player
};

export function PlayerCube({ sessionId, buffer, predictor }: PlayerCubeProps) {
  const ref = useRef<Mesh>(null);
  const color = useMemo(() => colorFor(sessionId), [sessionId]);

  useEffect(() => {
    if (!ref.current) return;
    if (predictor) {
      ref.current.position.set(predictor.predictedX, 0.5, predictor.predictedZ);
      return;
    }
    const sample = buffer.sample(performance.now() - hudState.interpDelayMs);
    if (sample) ref.current.position.set(sample.x, 0.5, sample.z);
  }, [buffer, predictor]);

  useFrame(() => {
    if (!ref.current) return;
    if (predictor) {
      ref.current.position.x = predictor.predictedX;
      ref.current.position.z = predictor.predictedZ;
      ref.current.position.y = 0.5;
      return;
    }
    const sample = buffer.sample(performance.now() - hudState.interpDelayMs);
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
