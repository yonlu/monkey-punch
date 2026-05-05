import { describe, it, expect } from "vitest";
import { createOrbitHitCooldownStore } from "../src/orbitHitCooldown.js";

describe("OrbitHitCooldownStore", () => {
  it("tryHit returns true the first time and updates last-hit", () => {
    const s = createOrbitHitCooldownStore();
    expect(s.tryHit("p1", 0, 42, 1000, 500)).toBe(true);
  });

  it("tryHit returns false within the cooldown window", () => {
    const s = createOrbitHitCooldownStore();
    s.tryHit("p1", 0, 42, 1000, 500);
    expect(s.tryHit("p1", 0, 42, 1100, 500)).toBe(false);
    expect(s.tryHit("p1", 0, 42, 1499, 500)).toBe(false);
  });

  it("tryHit returns true after the cooldown window elapses", () => {
    const s = createOrbitHitCooldownStore();
    s.tryHit("p1", 0, 42, 1000, 500);
    expect(s.tryHit("p1", 0, 42, 1500, 500)).toBe(true);
  });

  it("entries are independent across (player, weaponIndex, enemy) tuples", () => {
    const s = createOrbitHitCooldownStore();
    s.tryHit("p1", 0, 42, 1000, 500);
    expect(s.tryHit("p2", 0, 42, 1100, 500)).toBe(true);
    expect(s.tryHit("p1", 1, 42, 1100, 500)).toBe(true);
    expect(s.tryHit("p1", 0, 99, 1100, 500)).toBe(true);
  });

  it("evictPlayer removes all entries for that player", () => {
    const s = createOrbitHitCooldownStore();
    s.tryHit("p1", 0, 42, 1000, 500);
    s.tryHit("p1", 1, 99, 1000, 500);
    s.tryHit("p2", 0, 42, 1000, 500);
    s.evictPlayer("p1");
    expect(s.tryHit("p1", 0, 42, 1100, 500)).toBe(true);
    expect(s.tryHit("p1", 1, 99, 1100, 500)).toBe(true);
    expect(s.tryHit("p2", 0, 42, 1100, 500)).toBe(false); // p2 untouched
  });

  it("evictEnemy removes entries for that enemy across all players", () => {
    const s = createOrbitHitCooldownStore();
    s.tryHit("p1", 0, 42, 1000, 500);
    s.tryHit("p2", 0, 42, 1000, 500);
    s.tryHit("p1", 0, 99, 1000, 500);
    s.evictEnemy(42);
    expect(s.tryHit("p1", 0, 42, 1100, 500)).toBe(true);
    expect(s.tryHit("p2", 0, 42, 1100, 500)).toBe(true);
    expect(s.tryHit("p1", 0, 99, 1100, 500)).toBe(false); // enemy 99 untouched
  });

  it("sweep drops entries older than the configured max cooldown", () => {
    const s = createOrbitHitCooldownStore();
    s.tryHit("p1", 0, 42, 1000, 500);
    // Sweep at a time well past max cooldown — entry is gone, next tryHit
    // is a "first hit" and returns true even if its own cooldown is 500ms.
    s.sweep(/* nowMs */ 5000, /* maxCooldownMs */ 700);
    expect(s.tryHit("p1", 0, 42, 5001, 500)).toBe(true);
  });

  it("sweep keeps entries still within the cooldown window", () => {
    const s = createOrbitHitCooldownStore();
    s.tryHit("p1", 0, 42, 1000, 500);
    s.sweep(/* nowMs */ 1100, /* maxCooldownMs */ 700);
    expect(s.tryHit("p1", 0, 42, 1200, 500)).toBe(false); // still gated
  });
});
