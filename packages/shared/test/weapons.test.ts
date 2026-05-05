import { describe, it, expect } from "vitest";
import { WEAPON_KINDS, statsAt } from "../src/weapons.js";

describe("WEAPON_KINDS", () => {
  it("every kind has at least one level", () => {
    for (const def of WEAPON_KINDS) {
      expect(def.levels.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("Bolt is at index 0 and is a projectile", () => {
    expect(WEAPON_KINDS[0]!.name).toBe("Bolt");
    expect(WEAPON_KINDS[0]!.behavior.kind).toBe("projectile");
  });
});

describe("statsAt", () => {
  it("returns level 1 stats for level=1", () => {
    const def = WEAPON_KINDS[0]!;
    expect(statsAt(def, 1)).toBe(def.levels[0]);
  });

  it("clamps to level 1 for level<=0", () => {
    const def = WEAPON_KINDS[0]!;
    expect(statsAt(def, 0)).toBe(def.levels[0]);
    expect(statsAt(def, -3)).toBe(def.levels[0]);
  });

  it("clamps to max level for level beyond defined", () => {
    const def = WEAPON_KINDS[0]!;
    const max = def.levels.length;
    expect(statsAt(def, max + 5)).toBe(def.levels[max - 1]);
  });
});
