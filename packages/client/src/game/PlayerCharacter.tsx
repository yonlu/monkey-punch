import { useEffect, useMemo, useRef } from "react";
import { useGLTF, useAnimations } from "@react-three/drei";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { LoopOnce, type AnimationAction, type Object3D } from "three";

const MODEL_URL = `${import.meta.env.BASE_URL}models/character.glb`;
useGLTF.preload(MODEL_URL);

export type AnimName = "Idle" | "Run" | "Death";

const CLIP_BY_ANIM: Record<AnimName, string> = {
  Idle: "Rig|Idle_Loop",
  Run: "Rig|Jog_Fwd_Loop",
  Death: "Rig|Death01",
};

export type PlayerCharacterProps = {
  anim: AnimName;
  facingY: number;
};

export function PlayerCharacter({ anim, facingY }: PlayerCharacterProps) {
  const { scene, animations } = useGLTF(MODEL_URL) as unknown as {
    scene: Object3D;
    animations: import("three").AnimationClip[];
  };
  const cloned = useMemo(() => cloneSkinned(scene), [scene]);
  const { actions } = useAnimations(animations, cloned);
  const current = useRef<AnimationAction | null>(null);

  useEffect(() => {
    const next = actions[CLIP_BY_ANIM[anim]];
    if (!next || next === current.current) return;
    if (anim === "Death") {
      next.reset();
      next.setLoop(LoopOnce, 1);
      next.clampWhenFinished = true;
    } else {
      next.reset();
    }
    next.fadeIn(0.18).play();
    current.current?.fadeOut(0.18);
    current.current = next;
  }, [anim, actions]);

  return (
    <group rotation-y={facingY} scale={0.9}>
      <primitive object={cloned} />
    </group>
  );
}
