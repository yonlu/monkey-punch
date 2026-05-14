import { describe, it, expect } from "vitest";
import { ENEMY_KINDS, enemyDefAt, BOSS_KIND_INDEX } from "../src/enemies.js";

describe("enemyDefAt", () => {
  it("returns the row at an in-range integer kind", () => {
    expect(enemyDefAt(0).name).toBe("Slime");
    expect(enemyDefAt(1).name).toBe("Bunny");
    expect(enemyDefAt(2).name).toBe("Ghost");
    expect(enemyDefAt(3).name).toBe("Skeleton");
    expect(enemyDefAt(4).name).toBe("Boss");
  });

  it("clamps an out-of-range kind to the last row", () => {
    expect(enemyDefAt(99)).toBe(ENEMY_KINDS[ENEMY_KINDS.length - 1]);
  });

  it("clamps a negative kind to the first row", () => {
    expect(enemyDefAt(-5)).toBe(ENEMY_KINDS[0]);
  });

  it("floors a fractional kind", () => {
    expect(enemyDefAt(2.7)).toBe(ENEMY_KINDS[2]);
  });

  it("coerces NaN to the first row", () => {
    expect(enemyDefAt(NaN)).toBe(ENEMY_KINDS[0]);
  });

  it("coerces Infinity to the last row", () => {
    expect(enemyDefAt(Infinity)).toBe(ENEMY_KINDS[ENEMY_KINDS.length - 1]);
  });
});

describe("BOSS_KIND_INDEX", () => {
  it("points to the only isBoss row in ENEMY_KINDS", () => {
    expect(ENEMY_KINDS[BOSS_KIND_INDEX]!.isBoss).toBe(true);
    expect(ENEMY_KINDS[BOSS_KIND_INDEX]!.name).toBe("Boss");
  });
});
