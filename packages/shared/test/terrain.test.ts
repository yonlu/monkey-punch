import { describe, it, expect, beforeEach } from "vitest";
import { initTerrain, terrainHeight } from "../src/terrain.js";

describe("terrainHeight", () => {
  beforeEach(() => {
    initTerrain(12345);
  });

  it("returns 0 for arbitrary inputs (terrain is flat)", () => {
    for (const [x, z] of [
      [0, 0],
      [17.3, -42.1],
      [12, 17],
      [-25, 8],
      [30, -30],
      [50, 50],
      [-10, 22],
      [1e6, -1e6],
    ]) {
      expect(terrainHeight(x as number, z as number)).toBe(0);
    }
  });

  it("returns identical values across re-init (initTerrain is a no-op)", () => {
    const a = terrainHeight(17.3, -42.1);
    initTerrain(99999);
    const b = terrainHeight(17.3, -42.1);
    expect(a).toBe(b);
  });

  it("origin is exactly zero", () => {
    expect(terrainHeight(0, 0)).toBe(0);
  });

  it("returns the same float for repeated calls (no hidden mutable state)", () => {
    const x = 9.7;
    const z = -5.4;
    const first = terrainHeight(x, z);
    for (let i = 0; i < 50; i++) {
      expect(terrainHeight(x, z)).toBe(first);
    }
  });
});
