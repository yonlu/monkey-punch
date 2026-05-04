import { describe, it, expect } from "vitest";
import { RoomState, Player, Enemy } from "../src/schema.js";
import { tickPlayers, tickEnemies, tickSpawner, spawnDebugBurst, type SpawnerState } from "../src/rules.js";
import { PLAYER_SPEED, ENEMY_SPEED, ENEMY_SPAWN_INTERVAL_S, ENEMY_SPAWN_RADIUS, MAX_ENEMIES } from "../src/constants.js";
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
    expect(enemy!.hp).toBe(1);
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
      expect(e.hp).toBe(1);
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
