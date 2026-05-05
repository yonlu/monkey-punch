import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import type { Mesh } from "three";
import { PLAYER_SPEED } from "@mp/shared";
import { SnapshotBuffer } from "../net/snapshots.js";
import { hudState } from "../net/hudState.js";
import {
  STEP_INTERVAL_MS,
  SMOOTHING_TAU_S,
  type LocalPredictor,
} from "../net/prediction.js";
import { getLiveInputDir } from "./input.js";

const STEP_INTERVAL_S = STEP_INTERVAL_MS / 1000;
const RENDER_Y = 0.5;

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

/**
 * SIDE EFFECT: mutates predictor.renderOffset.x/.z (decays + jump-capture)
 * and predictor.lastLiveDirX/Z (records this frame's liveDir for next-frame
 * jump detection). Call once per frame; calling twice double-decays the
 * offset and double-stamps lastLiveDir.
 *
 * Compute the visible position for the local player from authoritative
 * predicted state plus two render-only contributions:
 *  1. Live-input extrapolation: predictedX/Z is updated only every
 *     STEP_INTERVAL_MS (20Hz), but render runs at ~60Hz. Between steps,
 *     extrapolate using the *current* keyboard direction (not the last
 *     sent input — see AD2) so key release stops the cube immediately.
 *     Clamped to one step's worth (AD3) so a stalled main thread can't
 *     catapult the cube.
 *  2. Decaying renderOffset: absorbs jumps from two sources — reconcile()
 *     snaps in predictedX/Z (AD4) and liveDir changes between render
 *     frames (AD6 — diagonal release, direction reversal). Both are
 *     captured additively, then exponentially decayed here so the visible
 *     cube smoothly catches up to authoritative truth over ~100ms.
 */
function localPlayerRenderPos(
  predictor: LocalPredictor,
  delta: number,
): { x: number; z: number } {
  const decay = Math.exp(-delta / SMOOTHING_TAU_S);
  predictor.renderOffset.x *= decay;
  predictor.renderOffset.z *= decay;

  const tSinceStep = Math.min(
    (performance.now() - predictor.lastStepTime) / 1000,
    STEP_INTERVAL_S,
  );
  const liveDir = getLiveInputDir();

  // Absorb extrapolation-term jump from a liveDir change (diagonal release,
  // direction reversal) into renderOffset, so the visible position stays
  // continuous when the user switches keys mid-step. Same pattern as the
  // reconcile-snap absorption (AD4) — capture the jump, let render decay
  // walk it to zero. Skip on first frame (NaN sentinel).
  if (!Number.isNaN(predictor.lastLiveDirX)) {
    const jumpX = (liveDir.x - predictor.lastLiveDirX) * PLAYER_SPEED * tSinceStep;
    const jumpZ = (liveDir.z - predictor.lastLiveDirZ) * PLAYER_SPEED * tSinceStep;
    predictor.renderOffset.x -= jumpX;
    predictor.renderOffset.z -= jumpZ;
  }
  predictor.lastLiveDirX = liveDir.x;
  predictor.lastLiveDirZ = liveDir.z;

  return {
    x: predictor.predictedX + liveDir.x * PLAYER_SPEED * tSinceStep + predictor.renderOffset.x,
    z: predictor.predictedZ + liveDir.z * PLAYER_SPEED * tSinceStep + predictor.renderOffset.z,
  };
}

export function PlayerCube({ sessionId, buffer, predictor }: PlayerCubeProps) {
  const ref = useRef<Mesh>(null);
  const color = useMemo(() => colorFor(sessionId), [sessionId]);

  useEffect(() => {
    if (!ref.current) return;
    if (predictor) {
      // First paint: delta=0 makes decay a no-op, and renderOffset is 0
      // post-construction, so position is exactly predictedX/Z.
      const pos = localPlayerRenderPos(predictor, 0);
      ref.current.position.set(pos.x, RENDER_Y, pos.z);
      return;
    }
    const sample = buffer.sample(performance.now() - hudState.interpDelayMs);
    if (sample) ref.current.position.set(sample.x, RENDER_Y, sample.z);
  }, [buffer, predictor]);

  useFrame((_state, delta) => {
    if (!ref.current) return;
    if (predictor) {
      const pos = localPlayerRenderPos(predictor, delta);
      ref.current.position.x = pos.x;
      ref.current.position.z = pos.z;
      ref.current.position.y = RENDER_Y;
      return;
    }
    const sample = buffer.sample(performance.now() - hudState.interpDelayMs);
    if (!sample) return;
    ref.current.position.x = sample.x;
    ref.current.position.z = sample.z;
    ref.current.position.y = RENDER_Y;
  });

  return (
    <mesh ref={ref} castShadow>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color={color} />
    </mesh>
  );
}
