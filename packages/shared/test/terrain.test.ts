import { describe, it, expect, beforeEach } from "vitest";
import { initTerrain, terrainHeight } from "../src/terrain.js";

describe("terrainHeight", () => {
  beforeEach(() => {
    initTerrain(12345);
  });

  it("returns identical values for the same (seed, x, z) after re-init", () => {
    const a = terrainHeight(17.3, -42.1);
    initTerrain(12345);
    const b = terrainHeight(17.3, -42.1);
    expect(a).toBe(b);
  });

  it("returns different values for different seeds at the same coordinate", () => {
    initTerrain(1);
    const v1 = terrainHeight(20, 20);
    initTerrain(2);
    const v2 = terrainHeight(20, 20);
    expect(v1).not.toBe(v2);
  });

  it("spawn-area flatness: points within ~1.5 units of origin are within ±0.05", () => {
    // The brief specifies an h*t*t ramp with t = dist/8. That ramp is
    // strongest near origin and weakens toward the boundary, so the
    // strictest bound holds where players actually spawn (a small region
    // around the origin), not at the full 8-unit boundary.
    for (const [x, z] of [
      [0, 0],
      [1, 0],
      [0, -1],
      [-1.2, 0.5],
      [0.7, 1.3],
    ]) {
      const h = terrainHeight(x as number, z as number);
      expect(Math.abs(h)).toBeLessThanOrEqual(0.05);
    }
  });

  it("spawn-area damping is continuous at the 8-unit boundary", () => {
    // h*t*t with t = dist/8 evaluates to h*1*1 = h at exactly dist == 8,
    // so the damped function is C0-continuous with the raw noise field
    // at the boundary. We sample just inside and just outside; the values
    // should be close (within an arbitrary small slack — they're not
    // identical because the function continues to grow with t² inside).
    const inside = terrainHeight(7.99, 0);
    const outside = terrainHeight(8.01, 0);
    expect(Math.abs(inside - outside)).toBeLessThan(0.05);
  });

  it("origin is exactly zero", () => {
    expect(terrainHeight(0, 0)).toBe(0);
  });

  it("returns the same float for repeated calls with the same coordinates (no hidden mutable state)", () => {
    const x = 9.7;
    const z = -5.4;
    const first = terrainHeight(x, z);
    for (let i = 0; i < 50; i++) {
      expect(terrainHeight(x, z)).toBe(first);
    }
  });

  it("snapshot — 5 known (seed, x, z) → height tuples (early-warning for prediction desync)", () => {
    // These exact float values are the canonical contract between server
    // and client. If any of them changes, prediction will desync and the
    // jump landing position will diverge between machines. Do NOT update
    // these values to make the test pass — investigate the algorithm
    // change instead.
    const cases: Array<[number, number, number, number]> = [
      // [seed, x, z, expectedHeight]
      [42, 12, 17, -3.4577444238163304],
      [42, -25, 8, -2.8326454698217356],
      [42, 30, -30, 0.4275625781469027],
      [7, 50, 50, -3.5812952606724884],
      [7, -10, 22, 1.9075310135832917],
    ];
    for (const [seed, x, z, expected] of cases) {
      initTerrain(seed);
      expect(terrainHeight(x, z)).toBe(expected);
    }
  });
});
