export type Dir2 = { x: number; z: number };

/**
 * Validate and clamp a 2D direction vector. Non-finite components produce a zero
 * vector. Magnitudes greater than 1 are rescaled to length 1; magnitudes ≤ 1 are
 * preserved. Direction is preserved (uniform scale, not per-axis clamp).
 */
export function clampDirection(x: number, z: number): Dir2 {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return { x: 0, z: 0 };
  const len = Math.hypot(x, z);
  if (len === 0) return { x: 0, z: 0 };
  const scale = len > 1 ? 1 / len : 1;
  return { x: x * scale, z: z * scale };
}

/**
 * Validate and normalize a 2D facing vector. Non-finite components or zero
 * magnitude fall back to (0, 1) — the schema default. Magnitude is always
 * normalized to 1, unlike `clampDirection` which preserves sub-unit lengths
 * (input dir can be partial; facing is always a unit vector by contract).
 */
export function clampFacing(x: number, z: number): Dir2 {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return { x: 0, z: 1 };
  const len = Math.hypot(x, z);
  if (len === 0) return { x: 0, z: 1 };
  return { x: x / len, z: z / len };
}
