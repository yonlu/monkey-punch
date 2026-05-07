import { describe, it, expect } from "vitest";
import { createContactCooldownStore } from "../src/contactCooldown.js";

describe("contactCooldown", () => {
  it("first hit succeeds for a new pair", () => {
    const s = createContactCooldownStore();
    expect(s.tryHit("a", 1, 0, 500)).toBe(true);
  });

  it("second hit within cooldown fails", () => {
    const s = createContactCooldownStore();
    s.tryHit("a", 1, 0, 500);
    expect(s.tryHit("a", 1, 100, 500)).toBe(false);
  });

  it("hit after cooldown elapses succeeds", () => {
    const s = createContactCooldownStore();
    s.tryHit("a", 1, 0, 500);
    expect(s.tryHit("a", 1, 600, 500)).toBe(true);
  });

  it("evictPlayer drops all entries for that player", () => {
    const s = createContactCooldownStore();
    s.tryHit("a", 1, 0, 500);
    s.tryHit("a", 2, 0, 500);
    s.tryHit("b", 1, 0, 500);
    s.evictPlayer("a");
    expect(s.tryHit("a", 1, 100, 500)).toBe(true);
    expect(s.tryHit("a", 2, 100, 500)).toBe(true);
    expect(s.tryHit("b", 1, 100, 500)).toBe(false);
  });

  it("evictEnemy drops all entries for that enemy", () => {
    const s = createContactCooldownStore();
    s.tryHit("a", 1, 0, 500);
    s.tryHit("b", 1, 0, 500);
    s.tryHit("a", 2, 0, 500);
    s.evictEnemy(1);
    expect(s.tryHit("a", 1, 100, 500)).toBe(true);
    expect(s.tryHit("b", 1, 100, 500)).toBe(true);
    expect(s.tryHit("a", 2, 100, 500)).toBe(false);
  });

  it("sweep drops entries older than maxCooldownMs", () => {
    const s = createContactCooldownStore();
    s.tryHit("a", 1, 0, 500);
    s.sweep(1000, 500);
    expect(s.tryHit("a", 1, 1100, 500)).toBe(true);
  });
});
