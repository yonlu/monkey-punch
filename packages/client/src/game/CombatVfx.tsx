import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import type { JSX } from "react";

const VFX_LIFETIME_S = 0.2;
const HIT_BASE_SCALE = 0.6;
const HIT_BASE_Y = 0.8;
const HIT_BASE_COLOR = "#ffd24a";
const DEATH_BASE_SCALE = 1.4;
const DEATH_BASE_Y = 0.8;
const DEATH_BASE_COLOR = "#ff5050";
const PICKUP_BASE_SCALE = 0.9;
const PICKUP_BASE_Y = 0.6;
const PICKUP_BASE_COLOR = "#5be6ff";

type Flash = { x: number; z: number; t0: number };

/**
 * CombatVfx is a small, ref-driven transient effect manager. GameView's
 * message handlers (fire/hit/enemy_died/gem_collected) call into the
 * singleton API exposed by `vfxRef` to push a flash; useFrame walks
 * each list and removes entries past their lifetime. Plain <mesh>
 * children — peak count is single digits.
 *
 * Why ref-driven instead of state: pushing a flash on every hit at 20Hz
 * across 10 players would re-render the entire CombatVfx tree. Mutating
 * the underlying arrays via a ref + a single forced setState per frame
 * keeps the React tree stable.
 */
export type VfxApi = {
  pushHit: (x: number, z: number) => void;
  pushDeath: (x: number, z: number) => void;
  pushPickup: (x: number, z: number) => void;
};

export function useCombatVfxRef(): { api: VfxApi; component: JSX.Element } {
  const hits = useRef<Flash[]>([]);
  const deaths = useRef<Flash[]>([]);
  const pickups = useRef<Flash[]>([]);
  const [, force] = useState(0);
  const lastForceMs = useRef<number>(0);

  const api = useMemo<VfxApi>(
    () => ({
      pushHit: (x, z) => { hits.current.push({ x, z, t0: performance.now() }); },
      pushDeath: (x, z) => { deaths.current.push({ x, z, t0: performance.now() }); },
      pushPickup: (x, z) => { pickups.current.push({ x, z, t0: performance.now() }); },
    }),
    [],
  );

  const component = (
    <CombatVfxRenderer
      hits={hits}
      deaths={deaths}
      pickups={pickups}
      onPrune={() => {
        const now = performance.now();
        if (now - lastForceMs.current > 16) {
          lastForceMs.current = now;
          force((n) => (n + 1) & 0x7fffffff);
        }
      }}
    />
  );
  return { api, component };
}

type RendererProps = {
  hits: React.MutableRefObject<Flash[]>;
  deaths: React.MutableRefObject<Flash[]>;
  pickups: React.MutableRefObject<Flash[]>;
  onPrune: () => void;
};

function CombatVfxRenderer({ hits, deaths, pickups, onPrune }: RendererProps) {
  useFrame(() => {
    const now = performance.now();
    const cutoff = now - VFX_LIFETIME_S * 1000;
    for (const arr of [hits.current, deaths.current, pickups.current]) {
      let w = 0;
      for (let r = 0; r < arr.length; r++) {
        const f = arr[r]!;
        if (f.t0 >= cutoff) {
          if (w !== r) arr[w] = f;
          w++;
        }
      }
      arr.length = w;
    }
    onPrune();
  });

  const now = performance.now();
  const renderFlash = (
    f: Flash,
    baseScale: number,
    baseY: number,
    baseColor: string,
    keyPrefix: string,
  ) => {
    const age = (now - f.t0) / 1000;
    const u = Math.max(0, 1 - age / VFX_LIFETIME_S);
    const scale = baseScale * (0.5 + 0.5 * u);
    const opacity = u;
    return (
      <mesh
        key={`${keyPrefix}-${f.t0}-${f.x.toFixed(3)}-${f.z.toFixed(3)}`}
        position={[f.x, baseY, f.z]}
        scale={scale}
      >
        <sphereGeometry args={[0.5, 8, 6]} />
        <meshStandardMaterial
          color={baseColor}
          emissive={baseColor}
          emissiveIntensity={1.5}
          transparent
          opacity={opacity}
          depthWrite={false}
        />
      </mesh>
    );
  };

  return (
    <group>
      {hits.current.map((f) => renderFlash(f, HIT_BASE_SCALE, HIT_BASE_Y, HIT_BASE_COLOR, "h"))}
      {deaths.current.map((f) => renderFlash(f, DEATH_BASE_SCALE, DEATH_BASE_Y, DEATH_BASE_COLOR, "d"))}
      {pickups.current.map((f) => renderFlash(f, PICKUP_BASE_SCALE, PICKUP_BASE_Y, PICKUP_BASE_COLOR, "p"))}
    </group>
  );
}
