import { describe, it, expect, vi } from "vitest";
import { RoomState, Player, Enemy, WeaponState, Gem } from "../src/schema.js";
import {
  tickPlayers,
  tickEnemies,
  tickSpawner,
  spawnDebugBurst,
  tickWeapons,
  tickProjectiles,
  tickGems,
  tickXp,
  tickLevelUpDeadlines,
  resolveLevelUp,
  tickContactDamage,
  tickRunEndCheck,
  type SpawnerState,
  type Projectile,
  type WeaponContext,
  type ProjectileContext,
  type Emit,
  type CombatEvent,
  type ContactCooldownLike,
} from "../src/rules.js";
import {
  PLAYER_SPEED,
  ENEMY_SPEED,
  ENEMY_SPAWN_INTERVAL_S,
  ENEMY_SPAWN_RADIUS,
  MAX_ENEMIES,
  ENEMY_HP,
  ENEMY_RADIUS,
  GEM_VALUE,
  GEM_PICKUP_RADIUS,
  TARGETING_MAX_RANGE,
  LEVEL_UP_DEADLINE_TICKS,
  xpForLevel,
  MAP_RADIUS,
  ENEMY_DESPAWN_RADIUS,
} from "../src/constants.js";
import { WEAPON_KINDS, statsAt, isProjectileWeapon } from "../src/weapons.js";
import { mulberry32 } from "../src/rng.js";

function addPlayer(state: RoomState, id: string, dirX: number, dirZ: number): Player {
  const p = new Player();
  p.sessionId = id;
  p.inputDir.x = dirX;
  p.inputDir.z = dirZ;
  state.players.set(id, p);
  return p;
}

describe("tickPlayers", () => {
  it("moves a player by inputDir * PLAYER_SPEED * dt on each axis", () => {
    const state = new RoomState();
    const p = addPlayer(state, "a", 1, 0);

    tickPlayers(state, 0.5);

    expect(p.x).toBeCloseTo(PLAYER_SPEED * 0.5);
    expect(p.z).toBe(0);
  });

  it("zero inputDir produces no movement", () => {
    const state = new RoomState();
    const p = addPlayer(state, "a", 0, 0);

    tickPlayers(state, 1.0);

    expect(p.x).toBe(0);
    expect(p.z).toBe(0);
  });

  it("moves multiple players independently", () => {
    const state = new RoomState();
    const a = addPlayer(state, "a", 1, 0);
    const b = addPlayer(state, "b", 0, -1);

    tickPlayers(state, 0.1);

    expect(a.x).toBeCloseTo(PLAYER_SPEED * 0.1);
    expect(a.z).toBe(0);
    expect(b.x).toBe(0);
    expect(b.z).toBeCloseTo(-PLAYER_SPEED * 0.1);
  });

  it("integration over multiple ticks accumulates", () => {
    const state = new RoomState();
    const p = addPlayer(state, "a", 1, 0);

    for (let i = 0; i < 10; i++) {
      tickPlayers(state, 0.05);
    }

    expect(p.x).toBeCloseTo(PLAYER_SPEED * 0.5);
  });
});

function addEnemy(state: RoomState, id: number, x: number, z: number): Enemy {
  const e = new Enemy();
  e.id = id;
  e.kind = 0;
  e.x = x;
  e.z = z;
  e.hp = 1;
  state.enemies.set(String(id), e);
  return e;
}

describe("tickEnemies", () => {
  it("moves a single enemy toward a single player by ENEMY_SPEED * dt", () => {
    const state = new RoomState();
    addPlayer(state, "p1", 0, 0);
    state.players.get("p1")!.x = 10;
    state.players.get("p1")!.z = 0;
    const e = addEnemy(state, 1, 0, 0);

    tickEnemies(state, 1.0);

    expect(e.x).toBeCloseTo(ENEMY_SPEED);
    expect(e.z).toBeCloseTo(0);
  });

  it("picks the nearest player when multiple players exist", () => {
    const state = new RoomState();
    const a = addPlayer(state, "near", 0, 0);
    a.x = 5; a.z = 0;
    const b = addPlayer(state, "far", 0, 0);
    b.x = -100; b.z = 0;
    const e = addEnemy(state, 1, 0, 0);

    tickEnemies(state, 1.0);

    // Moved toward "near" (positive x), not "far" (negative x).
    expect(e.x).toBeGreaterThan(0);
  });

  it("two enemies pick their respective nearest players independently", () => {
    const state = new RoomState();
    const a = addPlayer(state, "left", 0, 0);
    a.x = -10; a.z = 0;
    const b = addPlayer(state, "right", 0, 0);
    b.x = 10; b.z = 0;
    const e1 = addEnemy(state, 1, -3, 0);   // closer to "left"
    const e2 = addEnemy(state, 2, 3, 0);    // closer to "right"
    const e3 = addEnemy(state, 3, 0, 7);    // equidistant — implementation may pick either; assert it moved

    tickEnemies(state, 1.0);

    expect(e1.x).toBeLessThan(-3);          // moved further left toward "left"
    expect(e2.x).toBeGreaterThan(3);        // moved further right toward "right"
    expect(Math.hypot(e3.x - 0, e3.z - 7)).toBeCloseTo(ENEMY_SPEED * 1.0, 5); // moved by exactly ENEMY_SPEED
  });

  it("no-op when no players exist", () => {
    const state = new RoomState();
    const e = addEnemy(state, 1, 4, 5);

    tickEnemies(state, 1.0);

    expect(e.x).toBe(4);
    expect(e.z).toBe(5);
  });

  it("does not produce NaN when enemy is coincident with target player", () => {
    const state = new RoomState();
    addPlayer(state, "p1", 0, 0);
    const e = addEnemy(state, 1, 0, 0);

    tickEnemies(state, 1.0);

    expect(Number.isFinite(e.x)).toBe(true);
    expect(Number.isFinite(e.z)).toBe(true);
    expect(e.x).toBe(0);
    expect(e.z).toBe(0);
  });
});

function freshSpawner(): SpawnerState {
  return { accumulator: 0, nextEnemyId: 1 };
}

describe("tickSpawner", () => {
  it("does not spawn before the interval elapses", () => {
    const state = new RoomState();
    addPlayer(state, "p1", 0, 0);
    const spawner = freshSpawner();
    const rng = mulberry32(1);

    tickSpawner(state, spawner, ENEMY_SPAWN_INTERVAL_S - 0.001, rng);

    expect(state.enemies.size).toBe(0);
    expect(spawner.accumulator).toBeCloseTo(ENEMY_SPAWN_INTERVAL_S - 0.001);
    expect(spawner.nextEnemyId).toBe(1);
  });

  it("spawns exactly one enemy at the spawn interval", () => {
    const state = new RoomState();
    const p = addPlayer(state, "p1", 0, 0);
    p.x = 0; p.z = 0;
    const spawner = freshSpawner();
    const rng = mulberry32(7);

    tickSpawner(state, spawner, ENEMY_SPAWN_INTERVAL_S, rng);

    expect(state.enemies.size).toBe(1);
    expect(spawner.accumulator).toBeCloseTo(0);
    expect(spawner.nextEnemyId).toBe(2);

    const enemy = state.enemies.get("1");
    expect(enemy).toBeDefined();
    expect(enemy!.id).toBe(1);
    expect(enemy!.kind).toBe(0);
    expect(enemy!.hp).toBe(ENEMY_HP);
    const r = Math.hypot(enemy!.x - p.x, enemy!.z - p.z);
    expect(r).toBeCloseTo(ENEMY_SPAWN_RADIUS, 5);
  });

  it("produces reproducible spawn positions from a fixed seed", () => {
    // Determinism load-bearing test. If this drifts, two clients will see
    // enemies at different positions.
    const stateA = new RoomState();
    addPlayer(stateA, "p1", 0, 0);
    const spawnerA = freshSpawner();
    const rngA = mulberry32(42);

    for (let i = 0; i < 5; i++) {
      tickSpawner(stateA, spawnerA, ENEMY_SPAWN_INTERVAL_S, rngA);
    }
    expect(stateA.enemies.size).toBe(5);

    const stateB = new RoomState();
    addPlayer(stateB, "p1", 0, 0);
    const spawnerB = freshSpawner();
    const rngB = mulberry32(42);

    for (let i = 0; i < 5; i++) {
      tickSpawner(stateB, spawnerB, ENEMY_SPAWN_INTERVAL_S, rngB);
    }

    for (let id = 1; id <= 5; id++) {
      const a = stateA.enemies.get(String(id))!;
      const b = stateB.enemies.get(String(id))!;
      expect(b.x).toBeCloseTo(a.x, 10);
      expect(b.z).toBeCloseTo(a.z, 10);
    }
  });

  it("catches up when dt is several intervals", () => {
    const state = new RoomState();
    addPlayer(state, "p1", 0, 0);
    const spawner = freshSpawner();
    const rng = mulberry32(3);

    tickSpawner(state, spawner, 2.5 * ENEMY_SPAWN_INTERVAL_S, rng);

    expect(state.enemies.size).toBe(2);
    expect(spawner.accumulator).toBeCloseTo(0.5 * ENEMY_SPAWN_INTERVAL_S);
    expect(spawner.nextEnemyId).toBe(3);
  });

  it("stops spawning at MAX_ENEMIES and drains the accumulator", () => {
    const state = new RoomState();
    addPlayer(state, "p1", 0, 0);
    for (let i = 1; i <= MAX_ENEMIES; i++) {
      const e = new Enemy();
      e.id = i; e.kind = 0; e.x = 0; e.z = 0; e.hp = 1;
      state.enemies.set(String(i), e);
    }
    const spawner: SpawnerState = { accumulator: 0, nextEnemyId: MAX_ENEMIES + 1 };
    const rng = mulberry32(5);

    tickSpawner(state, spawner, 5 * ENEMY_SPAWN_INTERVAL_S, rng);

    expect(state.enemies.size).toBe(MAX_ENEMIES);
    expect(spawner.accumulator).toBe(0);
    expect(spawner.nextEnemyId).toBe(MAX_ENEMIES + 1);
  });

  it("does not advance the accumulator when the room is empty", () => {
    const state = new RoomState();
    const spawner = freshSpawner();
    const rng = mulberry32(9);

    tickSpawner(state, spawner, 100 * ENEMY_SPAWN_INTERVAL_S, rng);

    expect(state.enemies.size).toBe(0);
    expect(spawner.accumulator).toBe(0);

    addPlayer(state, "p1", 0, 0);
    tickSpawner(state, spawner, ENEMY_SPAWN_INTERVAL_S, rng);

    expect(state.enemies.size).toBe(1);
    expect(spawner.accumulator).toBeCloseTo(0);
  });
});

describe("spawnDebugBurst", () => {
  it("spawns N enemies around the given player at ENEMY_SPAWN_RADIUS", () => {
    const state = new RoomState();
    const p = addPlayer(state, "p1", 0, 0);
    p.x = 5; p.z = -3;
    const spawner = freshSpawner();
    const rng = mulberry32(11);

    spawnDebugBurst(state, spawner, rng, p, 10, 0);

    expect(state.enemies.size).toBe(10);
    state.enemies.forEach((e) => {
      const r = Math.hypot(e.x - p.x, e.z - p.z);
      expect(r).toBeCloseTo(ENEMY_SPAWN_RADIUS, 5);
      expect(e.kind).toBe(0);
      expect(e.hp).toBe(ENEMY_HP);
    });
  });

  it("clamps the burst at remaining capacity (MAX_ENEMIES - current)", () => {
    const state = new RoomState();
    const p = addPlayer(state, "p1", 0, 0);
    // Pre-fill to MAX_ENEMIES - 5.
    for (let i = 1; i <= MAX_ENEMIES - 5; i++) {
      const e = new Enemy();
      e.id = i; e.kind = 0; e.x = 0; e.z = 0; e.hp = 1;
      state.enemies.set(String(i), e);
    }
    const spawner: SpawnerState = { accumulator: 0, nextEnemyId: MAX_ENEMIES - 4 };
    const rng = mulberry32(13);

    spawnDebugBurst(state, spawner, rng, p, 50, 0);

    expect(state.enemies.size).toBe(MAX_ENEMIES);     // exactly 5 added
    expect(spawner.nextEnemyId).toBe(MAX_ENEMIES + 1); // 5 ids consumed
  });

  it("shares the nextEnemyId sequence with the auto-spawner", () => {
    const state = new RoomState();
    const p = addPlayer(state, "p1", 0, 0);
    p.x = 0; p.z = 0;
    const spawner = freshSpawner();
    const rng = mulberry32(17);

    // 1 auto-spawn → id=1
    tickSpawner(state, spawner, ENEMY_SPAWN_INTERVAL_S, rng);
    // burst of 3 → ids 2,3,4
    spawnDebugBurst(state, spawner, rng, p, 3, 0);
    // 1 auto-spawn → id=5
    tickSpawner(state, spawner, ENEMY_SPAWN_INTERVAL_S, rng);

    expect(state.enemies.size).toBe(5);
    for (let id = 1; id <= 5; id++) {
      expect(state.enemies.get(String(id))).toBeDefined();
    }
    expect(spawner.nextEnemyId).toBe(6);
  });
});

// --------------------- M4 combat ---------------------

function attachBolt(p: Player): WeaponState {
  const w = new WeaponState();
  w.kind = 0;
  w.level = 1;
  w.cooldownRemaining = 0;
  p.weapons.push(w);
  return w;
}

type CapturedFire = {
  fires: CombatEvent[];
  projectiles: Projectile[];
  ctx: WeaponContext;
};

function makeCapture(initialFireId = 1, fixedNowMs = 1_000_000): CapturedFire {
  const fires: CombatEvent[] = [];
  const projectiles: Projectile[] = [];
  let next = initialFireId;
  let nextGem = 1;
  const ctx: WeaponContext = {
    nextFireId: () => next++,
    serverNowMs: () => fixedNowMs,
    pushProjectile: (p) => projectiles.push(p),
    nextGemId: () => nextGem++,
    orbitHitCooldown: { tryHit: () => true, evictEnemy: () => {} },
  };
  return { fires, projectiles, ctx };
}

describe("tickWeapons", () => {
  it("decrements cooldown by dt each tick when no enemies are present and does not fire", () => {
    const state = new RoomState();
    const p = addPlayer(state, "p1", 0, 0);
    const w = attachBolt(p);
    w.cooldownRemaining = 0.5;

    const { fires, projectiles, ctx } = makeCapture();
    const emit: Emit = (e) => fires.push(e);

    tickWeapons(state, 0.05, ctx, emit);

    expect(w.cooldownRemaining).toBeCloseTo(0.45);
    expect(fires).toEqual([]);
    expect(projectiles).toEqual([]);
  });

  it("fires once when ready and a target is in range, resets cooldown, pushes one projectile", () => {
    const state = new RoomState();
    const p = addPlayer(state, "p1", 0, 0);
    p.x = 0; p.z = 0;
    const w = attachBolt(p);
    w.cooldownRemaining = 0;

    addEnemy(state, 1, 5, 0); // distance 5, in range

    const { fires, projectiles, ctx } = makeCapture(42, 999_888);
    const emit: Emit = (e) => fires.push(e);

    tickWeapons(state, 0.05, ctx, emit);

    expect(projectiles.length).toBe(1);
    const proj = projectiles[0]!;
    expect(proj.fireId).toBe(42);
    expect(proj.ownerId).toBe("p1");
    expect(proj.weaponKind).toBe(0);
    {
      const def = WEAPON_KINDS[0]!;
      if (!isProjectileWeapon(def)) throw new Error("expected projectile");
      const stats = statsAt(def, 1);
      expect(proj.damage).toBe(stats.damage);
      expect(proj.speed).toBe(stats.projectileSpeed);
      expect(proj.radius).toBe(stats.hitRadius);
      expect(proj.lifetime).toBe(stats.projectileLifetime);
    }
    expect(proj.age).toBe(0);
    expect(proj.dirX).toBeCloseTo(1);
    expect(proj.dirZ).toBeCloseTo(0);
    expect(proj.x).toBe(0);
    expect(proj.z).toBe(0);
    expect(proj.prevX).toBe(0);
    expect(proj.prevZ).toBe(0);

    expect(fires.length).toBe(1);
    const fire = fires[0]!;
    expect(fire.type).toBe("fire");
    if (fire.type !== "fire") throw new Error("type guard");
    expect(fire.fireId).toBe(42);
    expect(fire.weaponKind).toBe(0);
    expect(fire.ownerId).toBe("p1");
    expect(fire.originX).toBe(0);
    expect(fire.originZ).toBe(0);
    expect(fire.dirX).toBeCloseTo(1);
    expect(fire.dirZ).toBeCloseTo(0);
    expect(fire.serverFireTimeMs).toBe(999_888);

    {
      const def = WEAPON_KINDS[0]!;
      if (!isProjectileWeapon(def)) throw new Error("expected projectile");
      expect(w.cooldownRemaining).toBeCloseTo(statsAt(def, 1).cooldown);
    }
  });

  it("clamps cooldown at 0 with no targets and stays clamped across multiple ticks (AD10)", () => {
    const state = new RoomState();
    const p = addPlayer(state, "p1", 0, 0);
    const w = attachBolt(p);
    w.cooldownRemaining = 0;

    const { fires, projectiles, ctx } = makeCapture();
    const emit: Emit = (e) => fires.push(e);

    tickWeapons(state, 0.05, ctx, emit);
    tickWeapons(state, 0.05, ctx, emit);
    tickWeapons(state, 0.05, ctx, emit);

    expect(w.cooldownRemaining).toBe(0);
    expect(fires).toEqual([]);
    expect(projectiles).toEqual([]);
  });

  it("targets the nearest of multiple in-range enemies", () => {
    const state = new RoomState();
    const p = addPlayer(state, "p1", 0, 0);
    p.x = 0; p.z = 0;
    const w = attachBolt(p);
    w.cooldownRemaining = 0;

    addEnemy(state, 1, 10, 0);  // farther
    addEnemy(state, 2, 3, 0);   // nearer
    addEnemy(state, 3, 0, 8);   // farther on z

    const { fires, projectiles, ctx } = makeCapture();
    const emit: Emit = (e) => fires.push(e);

    tickWeapons(state, 0.05, ctx, emit);

    expect(projectiles.length).toBe(1);
    const proj = projectiles[0]!;
    // Targeted enemy id=2 at (3, 0): dir = (1, 0).
    expect(proj.dirX).toBeCloseTo(1);
    expect(proj.dirZ).toBeCloseTo(0);
  });

  it("ignores enemies outside TARGETING_MAX_RANGE", () => {
    const state = new RoomState();
    const p = addPlayer(state, "p1", 0, 0);
    p.x = 0; p.z = 0;
    const w = attachBolt(p);
    w.cooldownRemaining = 0;

    // Just outside range: distance = TARGETING_MAX_RANGE + 0.5.
    addEnemy(state, 1, TARGETING_MAX_RANGE + 0.5, 0);

    const { fires, projectiles, ctx } = makeCapture();
    const emit: Emit = (e) => fires.push(e);

    tickWeapons(state, 0.05, ctx, emit);

    expect(fires).toEqual([]);
    expect(projectiles).toEqual([]);
    expect(w.cooldownRemaining).toBe(0); // clamped, not negative
  });
});

function makeProjectile(overrides: Partial<Projectile>): Projectile {
  return {
    fireId: 1,
    ownerId: "p1",
    weaponKind: 0,
    damage: 10,
    speed: 18,
    radius: 0.4,
    lifetime: 0.8,
    age: 0,
    dirX: 1,
    dirZ: 0,
    prevX: 0,
    prevZ: 0,
    x: 0,
    z: 0,
    ...overrides,
  };
}

function makeProjCtx(initialGemId = 1): { ctx: ProjectileContext; nextGem: () => number } {
  let next = initialGemId;
  return {
    ctx: {
      nextGemId: () => next++,
      orbitHitCooldown: { tryHit: () => true, evictEnemy: () => {} },
    },
    nextGem: () => next,
  };
}

describe("tickProjectiles", () => {
  it("removes a projectile that has aged past its lifetime; emits no hit", () => {
    const state = new RoomState();
    const proj = makeProjectile({ age: 0.79, x: 0.5, z: 0 });
    const active: Projectile[] = [proj];
    const fires: CombatEvent[] = [];
    const emit: Emit = (e) => fires.push(e);
    const { ctx } = makeProjCtx();

    // dt large enough to push age >= lifetime: 0.79 + 0.05 = 0.84 >= 0.8.
    tickProjectiles(state, active, 0.05, ctx, emit);

    expect(active.length).toBe(0);
    expect(fires).toEqual([]);
  });

  it("hits a stationary enemy head-on, emits a hit event, removes the projectile", () => {
    const state = new RoomState();
    const enemy = addEnemy(state, 1, 1.0, 0);
    enemy.hp = ENEMY_HP;

    const proj = makeProjectile({ x: 0, z: 0, prevX: 0, prevZ: 0 });
    const active: Projectile[] = [proj];
    const fires: CombatEvent[] = [];
    const emit: Emit = (e) => fires.push(e);
    const { ctx } = makeProjCtx();

    // dt = 0.05 → next position x = 0 + 18*0.05 = 0.9. Segment endpoints
    // (0,0)→(0.9,0). Enemy center (1.0, 0) is within radius_sum
    // (0.4 + 0.5 = 0.9) of the segment endpoint at u=1 — distance 0.1.
    tickProjectiles(state, active, 0.05, ctx, emit);

    expect(active.length).toBe(0);
    expect(fires.length).toBe(1);
    const hit = fires[0]!;
    expect(hit.type).toBe("hit");
    if (hit.type !== "hit") throw new Error("type guard");
    expect(hit.fireId).toBe(proj.fireId);
    expect(hit.enemyId).toBe(1);
    expect(hit.damage).toBe(10);
    expect(enemy.hp).toBe(ENEMY_HP - 10);
  });

  it("catches the AD3 swept-circle tangent case where both endpoints lie outside radius_sum", () => {
    // Setup a projectile whose segment passes within radius_sum of an enemy
    // center, but with both endpoints OUTSIDE the radius_sum sphere. A
    // simple end-of-step point test misses this; swept-circle catches it.
    //
    // tickProjectiles overwrites proj.prev{X,Z} = proj.{x,z} at the start
    // of each tick, so we control the segment by setting the initial
    // (x, z) (becomes prev) and tuning speed*dt to the desired step.
    //
    // Enemy at (0, 0), radius 0.5; projectile radius 0.4 → radiusSum 0.9.
    // Segment from (-1, 0.5) to (1, 0.5):
    //   both endpoints are at distance sqrt(1 + 0.25) ≈ 1.118 > 0.9.
    //   closest point on segment to (0,0) is (0, 0.5), distance 0.5 < 0.9.
    const state = new RoomState();
    const enemy = addEnemy(state, 1, 0, 0);
    enemy.hp = ENEMY_HP;

    const proj = makeProjectile({
      x: -1, z: 0.5,        // becomes prev{X,Z} after integration
      prevX: 0, prevZ: 0,   // overwritten — value irrelevant
      dirX: 1, dirZ: 0,
      speed: 20,            // step = 20 * 0.1 = 2.0
      age: 0,
    });
    const active: Projectile[] = [proj];
    const fires: CombatEvent[] = [];
    const emit: Emit = (e) => fires.push(e);
    const { ctx } = makeProjCtx();

    tickProjectiles(state, active, 0.1, ctx, emit);

    expect(active.length).toBe(0);
    expect(fires.length).toBe(1);
    expect(fires[0]!.type).toBe("hit");
  });

  it("kills an enemy at hp <= damage: removes from state.enemies, drops a Gem, emits hit then enemy_died", () => {
    const state = new RoomState();
    const enemy = addEnemy(state, 7, 1.0, 0);
    enemy.hp = 10; // exactly damage

    const proj = makeProjectile({ damage: 10 });
    const active: Projectile[] = [proj];
    const fires: CombatEvent[] = [];
    const emit: Emit = (e) => fires.push(e);
    const { ctx } = makeProjCtx(99);

    tickProjectiles(state, active, 0.05, ctx, emit);

    // Enemy gone.
    expect(state.enemies.has("7")).toBe(false);
    // Gem inserted at the enemy's position with the next gem id.
    expect(state.gems.has("99")).toBe(true);
    const g = state.gems.get("99")!;
    expect(g.id).toBe(99);
    expect(g.x).toBeCloseTo(1.0);
    expect(g.z).toBeCloseTo(0);
    expect(g.value).toBe(GEM_VALUE);

    // Event order: hit then enemy_died.
    expect(fires.length).toBe(2);
    expect(fires[0]!.type).toBe("hit");
    expect(fires[1]!.type).toBe("enemy_died");
    if (fires[1]!.type !== "enemy_died") throw new Error("type guard");
    expect(fires[1]!.enemyId).toBe(7);
    expect(fires[1]!.x).toBeCloseTo(1.0);
    expect(fires[1]!.z).toBeCloseTo(0);
  });

  it("two projectiles in the same tick on the same hp=damage enemy: first kills, second misses (enemy already gone)", () => {
    const state = new RoomState();
    const enemy = addEnemy(state, 1, 1.0, 0);
    enemy.hp = 10;

    const a = makeProjectile({ fireId: 1, damage: 10 });
    const b = makeProjectile({ fireId: 2, damage: 10 });
    const active: Projectile[] = [a, b];
    const fires: CombatEvent[] = [];
    const emit: Emit = (e) => fires.push(e);
    const { ctx } = makeProjCtx();

    tickProjectiles(state, active, 0.05, ctx, emit);

    // First kills (hit + enemy_died). Second has no enemy to hit and survives.
    expect(state.enemies.size).toBe(0);
    expect(state.gems.size).toBe(1);
    expect(active.length).toBe(1);
    expect(active[0]!.fireId).toBe(2);

    expect(fires.filter((e) => e.type === "hit").length).toBe(1);
    expect(fires.filter((e) => e.type === "enemy_died").length).toBe(1);
  });

  it("with two intersected enemies in insertion order, hits the first one and removes the projectile", () => {
    const state = new RoomState();
    const a = addEnemy(state, 1, 0.6, 0); // first inserted
    a.hp = ENEMY_HP;
    const b = addEnemy(state, 2, 0.7, 0); // second inserted, slightly farther
    b.hp = ENEMY_HP;

    const proj = makeProjectile({ x: 0, z: 0, prevX: 0, prevZ: 0 });
    const active: Projectile[] = [proj];
    const fires: CombatEvent[] = [];
    const emit: Emit = (e) => fires.push(e);
    const { ctx } = makeProjCtx();

    tickProjectiles(state, active, 0.05, ctx, emit);

    expect(active.length).toBe(0);
    expect(fires.length).toBe(1);
    const hit = fires[0]!;
    if (hit.type !== "hit") throw new Error("type guard");
    expect(hit.enemyId).toBe(1); // first inserted wins
    // a took damage; b is untouched.
    expect(a.hp).toBe(ENEMY_HP - 10);
    expect(b.hp).toBe(ENEMY_HP);
  });
});

function addGem(state: RoomState, id: number, x: number, z: number, value = GEM_VALUE): Gem {
  const g = new Gem();
  g.id = id;
  g.x = x;
  g.z = z;
  g.value = value;
  state.gems.set(String(id), g);
  return g;
}

describe("tickGems", () => {
  it("collects a gem when a player is within GEM_PICKUP_RADIUS", () => {
    const state = new RoomState();
    const p = addPlayer(state, "p1", 0, 0);
    p.x = 0; p.z = 0;
    addGem(state, 1, 0, 0, 5);

    const events: CombatEvent[] = [];
    const emit: Emit = (e) => events.push(e);

    tickGems(state, emit);

    expect(state.gems.size).toBe(0);
    expect(p.xp).toBe(5);
    expect(events.length).toBe(1);
    const ev = events[0]!;
    if (ev.type !== "gem_collected") throw new Error("type guard");
    expect(ev.gemId).toBe(1);
    expect(ev.playerId).toBe("p1");
    expect(ev.value).toBe(5);
  });

  it("does not collect a gem outside the pickup radius", () => {
    const state = new RoomState();
    const p = addPlayer(state, "p1", 0, 0);
    p.x = 0; p.z = 0;
    addGem(state, 1, GEM_PICKUP_RADIUS + 0.1, 0);

    const events: CombatEvent[] = [];
    const emit: Emit = (e) => events.push(e);

    tickGems(state, emit);

    expect(state.gems.size).toBe(1);
    expect(p.xp).toBe(0);
    expect(events).toEqual([]);
  });

  it("with two players in range, the first inserted wins (AD8)", () => {
    const state = new RoomState();
    const first = addPlayer(state, "first", 0, 0);
    first.x = 0; first.z = 0;
    const second = addPlayer(state, "second", 0, 0);
    second.x = 0.1; second.z = 0;
    addGem(state, 1, 0, 0);

    const events: CombatEvent[] = [];
    const emit: Emit = (e) => events.push(e);

    tickGems(state, emit);

    expect(state.gems.size).toBe(0);
    expect(first.xp).toBe(GEM_VALUE);
    expect(second.xp).toBe(0);
    expect(events.length).toBe(1);
    const ev = events[0]!;
    if (ev.type !== "gem_collected") throw new Error("type guard");
    expect(ev.playerId).toBe("first");
  });
});

// --------------------- M5 orbit arm ---------------------

function makeOrbitCooldownStub() {
  const hits: Array<[string, number, number]> = [];
  return {
    tryHit: (pid: string, wi: number, eid: number, _now: number, _cd: number) => {
      hits.push([pid, wi, eid]);
      return true;
    },
    evictEnemy: (_id: number) => {},
    hits,
  };
}

function makeWeaponCtx(opts?: {
  nextFireId?: () => number;
  nowMs?: number;
  pushProjectile?: (p: Projectile) => void;
  nextGemId?: () => number;
  orbitHitCooldown?: { tryHit: (...args: any[]) => boolean; evictEnemy: (id: number) => void };
}): WeaponContext {
  return {
    nextFireId: opts?.nextFireId ?? (() => 1),
    serverNowMs: () => opts?.nowMs ?? 0,
    pushProjectile: opts?.pushProjectile ?? (() => {}),
    nextGemId: opts?.nextGemId ?? (() => 1),
    orbitHitCooldown: opts?.orbitHitCooldown ?? { tryHit: () => true, evictEnemy: () => {} },
  };
}

describe("tickWeapons orbit arm", () => {
  it("hits an enemy at orb radius on the first tick", () => {
    const state = new RoomState();
    const p = addPlayer(state, "p1", 0, 0);
    p.x = 0; p.z = 0;

    const orbit = new WeaponState();
    orbit.kind = 1; // index of Orbit in WEAPON_KINDS
    orbit.level = 1;
    orbit.cooldownRemaining = 0;
    p.weapons.push(orbit);

    // Place an enemy at the L1 orb radius on the +X axis.
    // L1 orbCount=2, orbRadius=2.0, orbAngularSpeed=2.4 rad/s.
    // At state.tick=0 the angles are 0 and π; orb 0 sits at (2.0, 0).
    const e = addEnemy(state, 1, 2.0, 0);
    e.hp = 100;

    const cd = makeOrbitCooldownStub();
    const events: CombatEvent[] = [];
    const ctx = makeWeaponCtx({ orbitHitCooldown: cd });

    state.tick = 0;
    tickWeapons(state, 0.05, ctx, (ev) => events.push(ev));

    // Enemy took 6 damage (Orbit L1 damage). One hit event was emitted.
    expect(e.hp).toBe(94);
    const hitEvents = events.filter((e) => e.type === "hit");
    expect(hitEvents.length).toBe(1);
    expect(cd.hits.length).toBe(1);
  });

  it("does not double-hit within the per-enemy cooldown window", () => {
    const state = new RoomState();
    const p = addPlayer(state, "p1", 0, 0);
    const orbit = new WeaponState();
    orbit.kind = 1;
    orbit.level = 1;
    p.weapons.push(orbit);

    const e = addEnemy(state, 1, 2.0, 0);
    e.hp = 100;

    // Stub returns false the second time (simulating a still-cooling-down hit).
    let n = 0;
    const cd = {
      tryHit: () => {
        n += 1;
        return n === 1;
      },
      evictEnemy: () => {},
    };
    const events: CombatEvent[] = [];
    const ctx = makeWeaponCtx({ orbitHitCooldown: cd });

    state.tick = 0;
    tickWeapons(state, 0.05, ctx, (ev) => events.push(ev));
    state.tick = 1;
    tickWeapons(state, 0.05, ctx, (ev) => events.push(ev));

    // Two ticks but only one hit landed (the second tryHit returned false).
    expect(e.hp).toBe(94);
    expect(events.filter((e) => e.type === "hit").length).toBe(1);
  });

  it("on lethal hit: emits enemy_died, drops a gem, removes the enemy, evicts cooldown entry", () => {
    const state = new RoomState();
    addPlayer(state, "p1", 0, 0);
    const p = state.players.get("p1")!;
    const orbit = new WeaponState();
    orbit.kind = 1;
    orbit.level = 1;
    p.weapons.push(orbit);

    const e = addEnemy(state, 7, 2.0, 0);
    e.hp = 1; // lethal in one hit

    let evictedId = -1;
    const cd = {
      tryHit: () => true,
      evictEnemy: (id: number) => { evictedId = id; },
    };
    const events: CombatEvent[] = [];
    const ctx = makeWeaponCtx({ orbitHitCooldown: cd });

    state.tick = 0;
    tickWeapons(state, 0.05, ctx, (ev) => events.push(ev));

    expect(state.enemies.has("7")).toBe(false);
    expect(state.gems.size).toBe(1);
    expect(events.some((e) => e.type === "enemy_died" && e.enemyId === 7)).toBe(true);
    expect(evictedId).toBe(7);
  });
});

describe("resolveLevelUp", () => {
  it("upgrades existing weapon: increments level, no new WeaponState pushed, emits resolved", () => {
    const p = new Player();
    p.sessionId = "p1";
    p.pendingLevelUp = true;
    p.levelUpChoices.push(0, 1, 0);
    p.levelUpDeadlineTick = 200;
    const w = new WeaponState();
    w.kind = 0; w.level = 1; w.cooldownRemaining = 0;
    p.weapons.push(w);

    const events: CombatEvent[] = [];
    resolveLevelUp(p, /* weaponKind */ 0, (e) => events.push(e), /* autoPicked */ false);

    expect(p.weapons.length).toBe(1);
    expect(p.weapons[0]!.level).toBe(2);
    expect(p.pendingLevelUp).toBe(false);
    expect(p.levelUpChoices.length).toBe(0);
    expect(p.levelUpDeadlineTick).toBe(0);

    const resolved = events.find((e) => e.type === "level_up_resolved")!;
    expect(resolved).toBeDefined();
    if (resolved.type === "level_up_resolved") {
      expect(resolved.playerId).toBe("p1");
      expect(resolved.weaponKind).toBe(0);
      expect(resolved.newWeaponLevel).toBe(2);
      expect(resolved.autoPicked).toBe(false);
    }
  });

  it("adds new weapon at level 1 if not present", () => {
    const p = new Player();
    p.sessionId = "p1";
    p.pendingLevelUp = true;
    p.levelUpChoices.push(1, 0, 1);

    const events: CombatEvent[] = [];
    resolveLevelUp(p, /* Orbit */ 1, (e) => events.push(e), /* autoPicked */ true);

    expect(p.weapons.length).toBe(1);
    expect(p.weapons[0]!.kind).toBe(1);
    expect(p.weapons[0]!.level).toBe(1);
    expect(p.weapons[0]!.cooldownRemaining).toBe(0);

    const resolved = events.find((e) => e.type === "level_up_resolved")!;
    if (resolved.type === "level_up_resolved") {
      expect(resolved.newWeaponLevel).toBe(1);
      expect(resolved.autoPicked).toBe(true);
    }
  });

  it("caps level at WEAPON_KINDS[kind].levels.length", () => {
    const p = new Player();
    p.sessionId = "p1";
    const def = WEAPON_KINDS[0]!; // Bolt: 5 levels
    const w = new WeaponState();
    w.kind = 0; w.level = def.levels.length; w.cooldownRemaining = 0;
    p.weapons.push(w);

    const events: CombatEvent[] = [];
    resolveLevelUp(p, 0, (e) => events.push(e), false);

    expect(p.weapons[0]!.level).toBe(def.levels.length); // capped, not 6
  });
});

describe("tickXp", () => {
  it("does nothing for a player below threshold", () => {
    const state = new RoomState();
    const p = addPlayer(state, "p1", 0, 0);
    p.level = 1;
    p.xp = xpForLevel(1) - 1; // one short

    const events: CombatEvent[] = [];
    tickXp(state, mulberry32(123), (e) => events.push(e));

    expect(p.pendingLevelUp).toBe(false);
    expect(p.level).toBe(1);
    expect(events.length).toBe(0);
  });

  it("triggers level-up exactly once when XP crosses threshold", () => {
    const state = new RoomState();
    state.tick = 50;
    const p = addPlayer(state, "p1", 0, 0);
    p.level = 1;
    p.xp = xpForLevel(1); // exact

    const events: CombatEvent[] = [];
    tickXp(state, mulberry32(123), (e) => events.push(e));

    expect(p.pendingLevelUp).toBe(true);
    expect(p.level).toBe(2);
    expect(p.xp).toBe(0);
    expect(p.levelUpChoices.length).toBe(3);
    expect(p.levelUpDeadlineTick).toBe(50 + LEVEL_UP_DEADLINE_TICKS);

    const offered = events.find((e) => e.type === "level_up_offered")!;
    expect(offered).toBeDefined();
    if (offered.type === "level_up_offered") {
      expect(offered.playerId).toBe("p1");
      expect(offered.newLevel).toBe(2);
      expect(offered.choices.length).toBe(3);
      expect(offered.deadlineTick).toBe(50 + LEVEL_UP_DEADLINE_TICKS);
    }
  });

  it("does not retrigger while pendingLevelUp is true", () => {
    const state = new RoomState();
    const p = addPlayer(state, "p1", 0, 0);
    p.level = 2;
    p.xp = xpForLevel(2) * 3; // way over threshold
    p.pendingLevelUp = true;

    const events: CombatEvent[] = [];
    tickXp(state, mulberry32(123), (e) => events.push(e));
    tickXp(state, mulberry32(123), (e) => events.push(e));

    expect(events.length).toBe(0);
    expect(p.level).toBe(2);
  });

  it("retriggers on next tick after pending clears, if XP still over", () => {
    const state = new RoomState();
    const p = addPlayer(state, "p1", 0, 0);
    p.level = 1;
    p.xp = xpForLevel(1) + xpForLevel(2); // enough for two levels

    const events1: CombatEvent[] = [];
    tickXp(state, mulberry32(123), (e) => events1.push(e));
    expect(p.pendingLevelUp).toBe(true);
    expect(p.level).toBe(2);

    // Simulate resolution.
    p.pendingLevelUp = false;
    p.levelUpChoices.length = 0;
    p.levelUpDeadlineTick = 0;

    const events2: CombatEvent[] = [];
    tickXp(state, mulberry32(123), (e) => events2.push(e));
    expect(p.pendingLevelUp).toBe(true);
    expect(p.level).toBe(3);
    expect(events2.filter((e) => e.type === "level_up_offered").length).toBe(1);
  });

  it("rolls 3 choices in [0, WEAPON_KINDS.length) using the supplied rng", () => {
    const state = new RoomState();
    const p = addPlayer(state, "p1", 0, 0);
    p.level = 1;
    p.xp = xpForLevel(1);

    const events: CombatEvent[] = [];
    tickXp(state, mulberry32(7), (e) => events.push(e));

    expect(p.levelUpChoices.length).toBe(3);
    p.levelUpChoices.forEach((c) => {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThan(WEAPON_KINDS.length);
    });
  });
});

describe("tickLevelUpDeadlines", () => {
  it("does not fire before the deadline tick", () => {
    const state = new RoomState();
    state.tick = 100;
    const p = addPlayer(state, "p1", 0, 0);
    p.pendingLevelUp = true;
    p.levelUpChoices.push(0, 0, 0);
    p.levelUpDeadlineTick = 200;

    const events: CombatEvent[] = [];
    tickLevelUpDeadlines(state, (e) => events.push(e));

    expect(p.pendingLevelUp).toBe(true);
    expect(events.length).toBe(0);
  });

  it("fires exactly when state.tick === deadline (auto-picks choice 0)", () => {
    const state = new RoomState();
    state.tick = 200;
    const p = addPlayer(state, "p1", 0, 0);
    p.pendingLevelUp = true;
    p.levelUpChoices.push(1, 0, 0);
    p.levelUpDeadlineTick = 200;

    const events: CombatEvent[] = [];
    tickLevelUpDeadlines(state, (e) => events.push(e));

    expect(p.pendingLevelUp).toBe(false);
    expect(p.weapons.length).toBe(1);
    expect(p.weapons[0]!.kind).toBe(1); // chose Orbit (choice 0)
    const resolved = events.find((e) => e.type === "level_up_resolved")!;
    if (resolved.type === "level_up_resolved") {
      expect(resolved.autoPicked).toBe(true);
    }
  });

  it("ignores players without pendingLevelUp", () => {
    const state = new RoomState();
    state.tick = 200;
    const p = addPlayer(state, "p1", 0, 0);
    p.pendingLevelUp = false;
    p.levelUpDeadlineTick = 100; // would be past, but pending is false

    const events: CombatEvent[] = [];
    tickLevelUpDeadlines(state, (e) => events.push(e));
    expect(events.length).toBe(0);
  });
});

describe("tickPlayers — M6", () => {
  it("clamps player position to MAP_RADIUS when integration would exceed it", () => {
    const state = new RoomState();
    const p = addPlayer(state, "a", 1, 0);
    p.x = 59;
    p.z = 0;
    // Step would push past MAP_RADIUS=60.
    for (let i = 0; i < 100; i++) tickPlayers(state, 0.05);
    expect(Math.hypot(p.x, p.z)).toBeLessThanOrEqual(60 + 1e-9);
    expect(p.x).toBeCloseTo(60);
  });

  it("does not move downed players", () => {
    const state = new RoomState();
    const p = addPlayer(state, "a", 1, 0);
    p.downed = true;
    tickPlayers(state, 0.5);
    expect(p.x).toBe(0);
  });
});

describe("tickEnemies — M6", () => {
  it("treats downed players as non-targets (steps toward living players only)", () => {
    const state = new RoomState();
    const dead = addPlayer(state, "dead", 0, 0); dead.x = 0; dead.z = 0; dead.downed = true;
    const live = addPlayer(state, "live", 0, 0); live.x = 10; live.z = 0;
    const e = addEnemy(state, 1, 1, 0);   // closer to dead
    tickEnemies(state, 0.05);
    // Should step toward live (positive x), not toward dead.
    expect(e.x).toBeGreaterThan(1);
  });

  it("despawns enemies beyond ENEMY_DESPAWN_RADIUS from any non-downed player", () => {
    const state = new RoomState();
    const live = addPlayer(state, "live", 0, 0); live.x = 0; live.z = 0;
    addEnemy(state, 1, 100, 0);   // 100 units away
    tickEnemies(state, 0.05);
    expect(state.enemies.has("1")).toBe(false);
  });

  it("does NOT despawn enemies within ENEMY_DESPAWN_RADIUS", () => {
    const state = new RoomState();
    const live = addPlayer(state, "live", 0, 0); live.x = 0; live.z = 0;
    addEnemy(state, 1, 30, 0);
    tickEnemies(state, 0.05);
    expect(state.enemies.has("1")).toBe(true);
  });
});

describe("runEnded universal early-out", () => {
  function makeFrozenState(): RoomState {
    const state = new RoomState();
    state.runEnded = true;
    const p = addPlayer(state, "a", 1, 0);
    p.x = 0; p.z = 0;
    addEnemy(state, 1, 5, 0);
    return state;
  }

  function noopEmit() {}

  it("tickPlayers does not move players when runEnded", () => {
    const state = makeFrozenState();
    const p = state.players.get("a")!;
    tickPlayers(state, 0.05);
    expect(p.x).toBe(0);
    expect(p.z).toBe(0);
  });

  it("tickEnemies does not move enemies when runEnded", () => {
    const state = makeFrozenState();
    const e = state.enemies.get("1")!;
    tickEnemies(state, 0.05);
    expect(e.x).toBe(5);
    expect(e.z).toBe(0);
  });

  it("tickGems does not collect gems when runEnded", () => {
    const state = makeFrozenState();
    const p = state.players.get("a")!;
    const g = new Gem();
    g.id = 1; g.x = 0; g.z = 0; g.value = 5;
    state.gems.set("1", g);
    tickGems(state, noopEmit);
    expect(state.gems.size).toBe(1);
    expect(p.xp).toBe(0);
  });

  it("tickXp does not advance xp threshold when runEnded", () => {
    const state = makeFrozenState();
    const p = state.players.get("a")!;
    p.xp = 10_000;
    p.level = 1;
    tickXp(state, mulberry32(1), noopEmit);
    expect(p.level).toBe(1);
    expect(p.pendingLevelUp).toBe(false);
  });
});

function makeFakeContactCooldown() {
  const tryHit = vi.fn().mockReturnValue(true);
  return {
    store: { tryHit, evictEnemy: vi.fn(), evictPlayer: vi.fn(), sweep: vi.fn() },
    tryHit,
  };
}

describe("tickContactDamage", () => {
  it("applies damage when player and enemy overlap and cooldown allows", () => {
    const state = new RoomState();
    const p = addPlayer(state, "a", 0, 0);
    p.hp = 100; p.maxHp = 100;
    p.x = 0; p.z = 0;
    addEnemy(state, 1, 0.5, 0);   // touching: dist = 0.5 < (PLAYER_RADIUS + ENEMY_RADIUS = 1)
    const fc = makeFakeContactCooldown();
    const events: CombatEvent[] = [];
    const emit: Emit = (e) => { events.push(e); };

    tickContactDamage(state, fc.store, 0.05, 0, emit);

    expect(p.hp).toBe(95);
    expect(events.find((e) => e.type === "player_damaged")).toBeDefined();
  });

  it("does not apply damage when cooldown rejects", () => {
    const state = new RoomState();
    const p = addPlayer(state, "a", 0, 0);
    p.hp = 100; p.x = 0; p.z = 0;
    addEnemy(state, 1, 0.5, 0);
    const fc = makeFakeContactCooldown();
    fc.tryHit.mockReturnValue(false);
    const events: CombatEvent[] = [];
    tickContactDamage(state, fc.store, 0.05, 0, (e) => events.push(e));

    expect(p.hp).toBe(100);
    expect(events.length).toBe(0);
  });

  it("flips downed and emits player_downed when hp crosses 0", () => {
    const state = new RoomState();
    const p = addPlayer(state, "a", 1, 0);
    p.hp = 5; p.maxHp = 100; p.x = 0; p.z = 0;
    p.inputDir.x = 1;   // moving when hit
    addEnemy(state, 1, 0.5, 0);
    const fc = makeFakeContactCooldown();
    const events: CombatEvent[] = [];

    tickContactDamage(state, fc.store, 0.05, 0, (e) => events.push(e));

    expect(p.hp).toBe(0);
    expect(p.downed).toBe(true);
    expect(p.inputDir.x).toBe(0);
    expect(p.inputDir.z).toBe(0);
    expect(events.filter((e) => e.type === "player_damaged").length).toBe(1);
    expect(events.filter((e) => e.type === "player_downed").length).toBe(1);
  });

  it("does not damage already-downed players", () => {
    const state = new RoomState();
    const p = addPlayer(state, "a", 0, 0);
    p.hp = 0; p.downed = true; p.x = 0; p.z = 0;
    addEnemy(state, 1, 0.5, 0);
    const fc = makeFakeContactCooldown();
    const events: CombatEvent[] = [];
    tickContactDamage(state, fc.store, 0.05, 0, (e) => events.push(e));
    expect(events.length).toBe(0);
  });

  it("early-outs on runEnded", () => {
    const state = new RoomState();
    state.runEnded = true;
    const p = addPlayer(state, "a", 0, 0);
    p.hp = 100; p.x = 0; p.z = 0;
    addEnemy(state, 1, 0.5, 0);
    const fc = makeFakeContactCooldown();
    const events: CombatEvent[] = [];
    tickContactDamage(state, fc.store, 0.05, 0, (e) => events.push(e));
    expect(p.hp).toBe(100);
    expect(events.length).toBe(0);
  });
});

describe("tickRunEndCheck", () => {
  it("flips runEnded only when all players are downed", () => {
    const state = new RoomState();
    const a = addPlayer(state, "a", 0, 0); a.downed = true;
    const b = addPlayer(state, "b", 0, 0); b.downed = false;
    const events: CombatEvent[] = [];
    tickRunEndCheck(state, (e) => events.push(e));
    expect(state.runEnded).toBe(false);
    expect(events.length).toBe(0);

    b.downed = true;
    tickRunEndCheck(state, (e) => events.push(e));
    expect(state.runEnded).toBe(true);
    expect(state.runEndedTick).toBe(state.tick);
    expect(events.filter((e) => e.type === "run_ended").length).toBe(1);
  });

  it("does not fire on empty room", () => {
    const state = new RoomState();
    const events: CombatEvent[] = [];
    tickRunEndCheck(state, (e) => events.push(e));
    expect(state.runEnded).toBe(false);
    expect(events.length).toBe(0);
  });

  it("fires only once across multiple ticks", () => {
    const state = new RoomState();
    const a = addPlayer(state, "a", 0, 0); a.downed = true;
    const events: CombatEvent[] = [];
    tickRunEndCheck(state, (e) => events.push(e));
    tickRunEndCheck(state, (e) => events.push(e));
    expect(events.filter((e) => e.type === "run_ended").length).toBe(1);
  });
});

describe("tickProjectiles — M6 kills", () => {
  it("credits owner.kills when a projectile kills an enemy", () => {
    const state = new RoomState();
    const owner = addPlayer(state, "owner", 0, 0); owner.x = 0; owner.z = 0;
    const e = addEnemy(state, 1, 1, 0); e.hp = 1;
    const projectiles: Projectile[] = [{
      fireId: 1, ownerId: "owner", weaponKind: 0,
      damage: 10, speed: 20, radius: 0.4, lifetime: 1,
      age: 0, dirX: 1, dirZ: 0,
      prevX: 0, prevZ: 0, x: 0, z: 0,
    }];
    const ctx: ProjectileContext = {
      nextGemId: () => 1,
      orbitHitCooldown: { tryHit: () => true, evictEnemy: () => {} },
    };
    tickProjectiles(state, projectiles, 0.05, ctx, () => {});
    expect(owner.kills).toBe(1);
  });

  it("does not crash when projectile owner has left", () => {
    const state = new RoomState();
    addEnemy(state, 1, 1, 0).hp = 1;
    const projectiles: Projectile[] = [{
      fireId: 1, ownerId: "ghost", weaponKind: 0,
      damage: 10, speed: 20, radius: 0.4, lifetime: 1,
      age: 0, dirX: 1, dirZ: 0,
      prevX: 0, prevZ: 0, x: 0, z: 0,
    }];
    const ctx: ProjectileContext = {
      nextGemId: () => 1,
      orbitHitCooldown: { tryHit: () => true, evictEnemy: () => {} },
    };
    expect(() => tickProjectiles(state, projectiles, 0.05, ctx, () => {})).not.toThrow();
  });
});

describe("tickWeapons — M6", () => {
  it("skips downed players entirely (no fire emitted, no cooldown decrement)", () => {
    const state = new RoomState();
    const p = addPlayer(state, "a", 0, 0); p.downed = true;
    const w = new WeaponState();
    w.kind = 0; w.level = 1; w.cooldownRemaining = 0;
    p.weapons.push(w);
    addEnemy(state, 1, 5, 0);
    const events: CombatEvent[] = [];
    const ctx: WeaponContext = {
      nextFireId: () => 1,
      serverNowMs: () => 0,
      pushProjectile: () => {},
      nextGemId: () => 1,
      orbitHitCooldown: { tryHit: () => true, evictEnemy: () => {} },
    };
    tickWeapons(state, 0.05, ctx, (e) => events.push(e));
    expect(events.find((e) => e.type === "fire")).toBeUndefined();
    expect(w.cooldownRemaining).toBe(0);
  });

  it("increments owner.kills on orbit-killing-blow", () => {
    const state = new RoomState();
    const p = addPlayer(state, "a", 0, 0);
    p.x = 0; p.z = 0;
    const w = new WeaponState();
    w.kind = 1; w.level = 1; w.cooldownRemaining = 0;   // orbit
    p.weapons.push(w);
    // At state.tick=0 and orbRadius=2.0, orb 0 sits at (2.0, 0).
    const e = addEnemy(state, 1, 2.0, 0);
    e.hp = 1;   // dies in one orbit hit
    const ctx: WeaponContext = {
      nextFireId: () => 1,
      serverNowMs: () => 0,
      pushProjectile: () => {},
      nextGemId: () => 1,
      orbitHitCooldown: { tryHit: () => true, evictEnemy: () => {} },
    };
    tickWeapons(state, 0.05, ctx, () => {});
    expect(p.kills).toBe(1);
  });
});

describe("tickGems — M6", () => {
  it("increments xpGained alongside xp on collect", () => {
    const state = new RoomState();
    const p = addPlayer(state, "a", 0, 0); p.x = 0; p.z = 0; p.xp = 0; p.xpGained = 0;
    const g = new Gem(); g.id = 1; g.x = 0; g.z = 0; g.value = 5;
    state.gems.set("1", g);
    tickGems(state, () => {});
    expect(p.xp).toBe(5);
    expect(p.xpGained).toBe(5);
  });

  it("xpGained is monotone (never drained when xp is)", () => {
    const state = new RoomState();
    const p = addPlayer(state, "a", 0, 0); p.x = 0; p.z = 0; p.xp = 0; p.xpGained = 0;
    const g1 = new Gem(); g1.id = 1; g1.x = 0; g1.z = 0; g1.value = 10;
    state.gems.set("1", g1);
    tickGems(state, () => {});
    p.xp = 0;   // simulate level-up drain
    const g2 = new Gem(); g2.id = 2; g2.x = 0; g2.z = 0; g2.value = 4;
    state.gems.set("2", g2);
    tickGems(state, () => {});
    expect(p.xp).toBe(4);
    expect(p.xpGained).toBe(14);
  });
});
