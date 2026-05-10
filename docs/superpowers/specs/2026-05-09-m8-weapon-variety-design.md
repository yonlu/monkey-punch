# M8 Weapon Variety — Architecture Review (US-001)

**Status:** review-pending. No implementation begins until this is approved
(per `tasks/prd-m8-weapon-variety.md` US-001).

**Source PRD:** `tasks/prd-m8-weapon-variety.md`
**Source Ralph queue:** `prd.json` (`ralph/m8-weapon-variety`)

---

## 1. Scope and intent

Add six new weapons across four behavior kinds:

| Kind         | Weapons                   | New?              |
|--------------|---------------------------|-------------------|
| `projectile` | Bolt, Gakkung Bow, Ahlspiess | extended          |
| `orbit`      | Orbit                     | unchanged         |
| `melee_arc`  | Damascus, Claymore        | new behavior kind |
| `aura`       | Kronos                    | new behavior kind |
| `boomerang`  | Bloody Axe                | new behavior kind |

Plus a **minimal** enemy status-effect system (slow only) and a
`BloodPool` schema for Bloody Axe's L3+ DoT trail.

The hypothesis being validated: the M5 weapon-table abstraction can
absorb six new weapons across four behaviors **without name-based
branching anywhere in tick or render code** (CLAUDE.md rule 12). If
that fails at any point in the implementation, stop and revisit.

---

## 2. Type changes — `packages/shared/src/weapons.ts`

### 2.1 Targeting modes (extended)

```ts
export type TargetingMode = "nearest" | "furthest" | "facing";
```

### 2.2 Per-behavior level types

`ProjectileLevel` is **extended** (two new fields). The other three
are **new**:

```ts
export type ProjectileLevel = {
  damage: number;
  cooldown: number;
  hitRadius: number;
  projectileSpeed: number;
  projectileLifetime: number;
  // NEW: -1 = infinite pierce; 1 = current Bolt behavior (single-hit despawn).
  // Server tracks pierceRemaining per-projectile and despawns at 0; -1 never decrements.
  pierceCount: number;
  // NEW: same enemy can only be hit again after this many ms of in-flight time.
  // 0 = no per-enemy cooldown (Bolt). Reuses the orbit-style mechanism — server-only Map, NOT in schema.
  hitCooldownPerEnemyMs: number;
};

export type OrbitLevel = {
  // unchanged from M5
  damage: number;
  hitRadius: number;
  hitCooldownPerEnemyMs: number;
  orbCount: number;
  orbRadius: number;
  orbAngularSpeed: number;
};

export type MeleeArcLevel = {
  damage: number;
  cooldown: number;          // seconds between swings
  arcAngle: number;          // total arc width in radians (e.g. Math.PI/3 = 60°)
  range: number;             // melee reach in world units
  critChance: number;        // 0..1; rolled per-hit using room PRNG (rule 6)
  critMultiplier: number;    // 2.0 means crit deals 2× damage
  knockback: number;         // 0 = none; otherwise pushes hit enemy this many units along player→enemy
};

export type AuraLevel = {
  damage: number;            // per tick
  radius: number;            // 3D distance (see §10 open-question A4)
  tickIntervalMs: number;    // ms between damage ticks
  slowMultiplier: number;    // <1 slows; 1 = no slow
  slowDurationMs: number;    // applied each tick to enemies inside; re-applied while they remain
};

export type BoomerangLevel = {
  damage: number;
  cooldown: number;
  hitRadius: number;
  outboundDistance: number;  // world units
  outboundSpeed: number;     // units/sec
  returnSpeed: number;       // units/sec
  hitCooldownPerEnemyMs: number;
  // L1/L2 = false (no pool spawning). L3+ = true.
  leavesBloodPool: boolean;
  // Pool params; inert when leavesBloodPool === false.
  bloodPoolDamagePerTick: number;
  bloodPoolTickIntervalMs: number;
  bloodPoolLifetimeMs: number;
  bloodPoolSpawnIntervalUnits: number;  // place one pool every N units along outbound path
};
```

### 2.3 `WeaponDef` discriminated union (refactored)

```ts
export type WeaponDef =
  | { name: string; behavior: { kind: "projectile";
                                 targeting: TargetingMode;
                                 homingTurnRate: number /* rad/sec; 0 = straight */ };
      levels: ProjectileLevel[] }
  | { name: string; behavior: { kind: "orbit" };
      levels: OrbitLevel[] }
  | { name: string; behavior: { kind: "melee_arc" };
      levels: MeleeArcLevel[] }
  | { name: string; behavior: { kind: "aura" };
      levels: AuraLevel[] }
  | { name: string; behavior: { kind: "boomerang" };
      levels: BoomerangLevel[] };
```

**Discriminator rules (preserved from M5):**

- Behavior `kind` is the load-bearing discriminator. All tick / render
  dispatch goes through `behavior.kind`. Never weapon `name`.
- `targeting` and `homingTurnRate` live on `behavior` because they are
  *modes* (constant per weapon), not stats. Pierce/cooldown/range/etc.
  vary per level and live on the `*Level` type.

### 2.4 New type guards (mirror existing `isProjectileWeapon` etc.)

```ts
export type ProjectileWeaponDef = Extract<WeaponDef, { behavior: { kind: "projectile" } }>;
export type OrbitWeaponDef      = Extract<WeaponDef, { behavior: { kind: "orbit" } }>;
export type MeleeArcWeaponDef   = Extract<WeaponDef, { behavior: { kind: "melee_arc" } }>;
export type AuraWeaponDef       = Extract<WeaponDef, { behavior: { kind: "aura" } }>;
export type BoomerangWeaponDef  = Extract<WeaponDef, { behavior: { kind: "boomerang" } }>;

export function isProjectileWeapon(d: WeaponDef): d is ProjectileWeaponDef { return d.behavior.kind === "projectile"; }
export function isOrbitWeapon     (d: WeaponDef): d is OrbitWeaponDef      { return d.behavior.kind === "orbit"; }
export function isMeleeArcWeapon  (d: WeaponDef): d is MeleeArcWeaponDef   { return d.behavior.kind === "melee_arc"; }
export function isAuraWeapon      (d: WeaponDef): d is AuraWeaponDef       { return d.behavior.kind === "aura"; }
export function isBoomerangWeapon (d: WeaponDef): d is BoomerangWeaponDef  { return d.behavior.kind === "boomerang"; }
```

`statsAt` is generic over `W extends WeaponDef`, so it works for the
new behaviors with no signature change.

---

## 3. Full weapon table (`WEAPON_KINDS`)

These are **starting values** — balance is a follow-up tuning pass
(per PRD §non-goals). Numbers chosen to give the PRD's mechanical
intent (Damascus = high tempo, Claymore = slow heavy, Kronos =
defensive control, etc.) rather than to be tuned.

```ts
export const WEAPON_KINDS: readonly WeaponDef[] = [
  // 0: Bolt — UNCHANGED OBSERVABLE BEHAVIOR. Two new fields default to current behavior:
  //   pierceCount: 1            (single-hit despawn — same as M5)
  //   hitCooldownPerEnemyMs: 0  (no per-enemy cooldown — same as M5)
  {
    name: "Bolt",
    behavior: { kind: "projectile", targeting: "nearest", homingTurnRate: 0 },
    levels: [
      { damage: 10, cooldown: 0.60, hitRadius: 0.4, projectileSpeed: 18, projectileLifetime: 0.8, pierceCount: 1, hitCooldownPerEnemyMs: 0 },
      { damage: 14, cooldown: 0.55, hitRadius: 0.4, projectileSpeed: 18, projectileLifetime: 0.8, pierceCount: 1, hitCooldownPerEnemyMs: 0 },
      { damage: 18, cooldown: 0.50, hitRadius: 0.4, projectileSpeed: 18, projectileLifetime: 0.8, pierceCount: 1, hitCooldownPerEnemyMs: 0 },
      { damage: 22, cooldown: 0.45, hitRadius: 0.4, projectileSpeed: 18, projectileLifetime: 0.8, pierceCount: 1, hitCooldownPerEnemyMs: 0 },
      { damage: 28, cooldown: 0.40, hitRadius: 0.4, projectileSpeed: 18, projectileLifetime: 0.8, pierceCount: 1, hitCooldownPerEnemyMs: 0 },
    ],
  },

  // 1: Orbit — UNCHANGED.
  {
    name: "Orbit",
    behavior: { kind: "orbit" },
    levels: [
      { damage:  6, hitRadius: 0.5, hitCooldownPerEnemyMs: 700, orbCount: 2, orbRadius: 2.0, orbAngularSpeed: 2.4 },
      { damage:  8, hitRadius: 0.5, hitCooldownPerEnemyMs: 650, orbCount: 2, orbRadius: 2.2, orbAngularSpeed: 2.6 },
      { damage: 10, hitRadius: 0.6, hitCooldownPerEnemyMs: 600, orbCount: 3, orbRadius: 2.2, orbAngularSpeed: 2.6 },
      { damage: 13, hitRadius: 0.6, hitCooldownPerEnemyMs: 550, orbCount: 3, orbRadius: 2.4, orbAngularSpeed: 2.8 },
      { damage: 16, hitRadius: 0.6, hitCooldownPerEnemyMs: 500, orbCount: 4, orbRadius: 2.4, orbAngularSpeed: 3.0 },
    ],
  },

  // 2: Gakkung Bow — long-range homing, locks furthest enemy in range, mild pierce growth.
  {
    name: "Gakkung Bow",
    behavior: { kind: "projectile", targeting: "furthest", homingTurnRate: Math.PI * 0.8 /* ~144°/s */ },
    levels: [
      { damage: 18, cooldown: 0.85, hitRadius: 0.4, projectileSpeed: 28, projectileLifetime: 1.2, pierceCount: 1, hitCooldownPerEnemyMs: 0 },
      { damage: 22, cooldown: 0.80, hitRadius: 0.4, projectileSpeed: 28, projectileLifetime: 1.2, pierceCount: 1, hitCooldownPerEnemyMs: 0 },
      { damage: 26, cooldown: 0.75, hitRadius: 0.4, projectileSpeed: 28, projectileLifetime: 1.2, pierceCount: 2, hitCooldownPerEnemyMs: 0 },
      { damage: 30, cooldown: 0.70, hitRadius: 0.4, projectileSpeed: 28, projectileLifetime: 1.2, pierceCount: 2, hitCooldownPerEnemyMs: 0 },
      { damage: 36, cooldown: 0.65, hitRadius: 0.4, projectileSpeed: 28, projectileLifetime: 1.2, pierceCount: 3, hitCooldownPerEnemyMs: 0 },
    ],
  },

  // 3: Damascus — fast melee swipe, crits scale per level.
  {
    name: "Damascus",
    behavior: { kind: "melee_arc" },
    levels: [
      { damage: 12, cooldown: 0.35, arcAngle: Math.PI / 3,  range: 2.2, critChance: 0.25, critMultiplier: 2.0, knockback: 0 },
      { damage: 14, cooldown: 0.33, arcAngle: Math.PI / 3,  range: 2.2, critChance: 0.30, critMultiplier: 2.0, knockback: 0 },
      { damage: 17, cooldown: 0.30, arcAngle: Math.PI / 3,  range: 2.3, critChance: 0.35, critMultiplier: 2.0, knockback: 0 },
      { damage: 20, cooldown: 0.28, arcAngle: Math.PI * 0.36, range: 2.4, critChance: 0.40, critMultiplier: 2.0, knockback: 0 },
      { damage: 24, cooldown: 0.25, arcAngle: Math.PI * 0.38, range: 2.5, critChance: 0.45, critMultiplier: 2.0, knockback: 0 },
    ],
  },

  // 4: Claymore — slow heavy arc, knockback grows.
  {
    name: "Claymore",
    behavior: { kind: "melee_arc" },
    levels: [
      { damage:  45, cooldown: 1.40, arcAngle: Math.PI * 0.90, range: 3.5, critChance: 0, critMultiplier: 1, knockback: 1.2 },
      { damage:  55, cooldown: 1.40, arcAngle: Math.PI * 0.91, range: 3.6, critChance: 0, critMultiplier: 1, knockback: 1.3 },
      { damage:  70, cooldown: 1.30, arcAngle: Math.PI * 0.93, range: 3.7, critChance: 0, critMultiplier: 1, knockback: 1.4 },
      { damage:  85, cooldown: 1.30, arcAngle: Math.PI * 0.95, range: 3.8, critChance: 0, critMultiplier: 1, knockback: 1.5 },
      { damage: 100, cooldown: 1.20, arcAngle: Math.PI * 0.97, range: 4.0, critChance: 0, critMultiplier: 1, knockback: 1.6 },
    ],
  },

  // 5: Ahlspiess — facing-direction piercing line, hitRadius widens at higher levels.
  {
    name: "Ahlspiess",
    behavior: { kind: "projectile", targeting: "facing", homingTurnRate: 0 },
    levels: [
      { damage: 25, cooldown: 1.00, hitRadius: 0.50, projectileSpeed: 22, projectileLifetime: 1.5, pierceCount: -1, hitCooldownPerEnemyMs: 200 },
      { damage: 30, cooldown: 0.95, hitRadius: 0.55, projectileSpeed: 22, projectileLifetime: 1.5, pierceCount: -1, hitCooldownPerEnemyMs: 200 },
      { damage: 36, cooldown: 0.90, hitRadius: 0.60, projectileSpeed: 22, projectileLifetime: 1.5, pierceCount: -1, hitCooldownPerEnemyMs: 200 },
      { damage: 44, cooldown: 0.85, hitRadius: 0.70, projectileSpeed: 22, projectileLifetime: 1.5, pierceCount: -1, hitCooldownPerEnemyMs: 200 },
      { damage: 54, cooldown: 0.80, hitRadius: 0.80, projectileSpeed: 22, projectileLifetime: 1.5, pierceCount: -1, hitCooldownPerEnemyMs: 200 },
    ],
  },

  // 6: Bloody Axe — boomerang. Blood pools at L3+; pool damage grows.
  {
    name: "Bloody Axe",
    behavior: { kind: "boomerang" },
    levels: [
      { damage: 30, cooldown: 1.60, hitRadius: 0.7, outboundDistance: 7, outboundSpeed: 14, returnSpeed: 18, hitCooldownPerEnemyMs: 300, leavesBloodPool: false, bloodPoolDamagePerTick: 0, bloodPoolTickIntervalMs: 300, bloodPoolLifetimeMs: 1500, bloodPoolSpawnIntervalUnits: 1.5 },
      { damage: 38, cooldown: 1.55, hitRadius: 0.7, outboundDistance: 7, outboundSpeed: 14, returnSpeed: 18, hitCooldownPerEnemyMs: 300, leavesBloodPool: false, bloodPoolDamagePerTick: 0, bloodPoolTickIntervalMs: 300, bloodPoolLifetimeMs: 1500, bloodPoolSpawnIntervalUnits: 1.5 },
      { damage: 46, cooldown: 1.50, hitRadius: 0.7, outboundDistance: 7, outboundSpeed: 14, returnSpeed: 18, hitCooldownPerEnemyMs: 300, leavesBloodPool: true,  bloodPoolDamagePerTick: 4, bloodPoolTickIntervalMs: 300, bloodPoolLifetimeMs: 1500, bloodPoolSpawnIntervalUnits: 1.5 },
      { damage: 56, cooldown: 1.45, hitRadius: 0.7, outboundDistance: 7, outboundSpeed: 14, returnSpeed: 18, hitCooldownPerEnemyMs: 300, leavesBloodPool: true,  bloodPoolDamagePerTick: 6, bloodPoolTickIntervalMs: 300, bloodPoolLifetimeMs: 1500, bloodPoolSpawnIntervalUnits: 1.5 },
      { damage: 68, cooldown: 1.40, hitRadius: 0.7, outboundDistance: 7, outboundSpeed: 14, returnSpeed: 18, hitCooldownPerEnemyMs: 300, leavesBloodPool: true,  bloodPoolDamagePerTick: 8, bloodPoolTickIntervalMs: 300, bloodPoolLifetimeMs: 1500, bloodPoolSpawnIntervalUnits: 1.5 },
    ],
  },

  // 7: Kronos — persistent slow aura; cooldown UNUSED (the aura runs continuously,
  // tick scheduled by tickIntervalMs). Stronger slow at L4+.
  {
    name: "Kronos",
    behavior: { kind: "aura" },
    levels: [
      { damage:  8, radius: 3.5, tickIntervalMs: 500, slowMultiplier: 0.6, slowDurationMs: 300 },
      { damage: 10, radius: 3.7, tickIntervalMs: 500, slowMultiplier: 0.6, slowDurationMs: 300 },
      { damage: 12, radius: 4.0, tickIntervalMs: 500, slowMultiplier: 0.6, slowDurationMs: 300 },
      { damage: 15, radius: 4.3, tickIntervalMs: 500, slowMultiplier: 0.5, slowDurationMs: 300 },
      { damage: 18, radius: 4.6, tickIntervalMs: 500, slowMultiplier: 0.4, slowDurationMs: 300 },
    ],
  },
];
```

**Weapon kind indices (assigned, for reference):** Bolt=0, Orbit=1,
Gakkung Bow=2, Damascus=3, Claymore=4, Ahlspiess=5, Bloody Axe=6,
Kronos=7. Order matches insertion in `WEAPON_KINDS` (the level-up
choice pool reads by index).

---

## 4. Schema additions — `packages/shared/src/schema.ts`

**Landmine reminder (skill landmine #1):** every new field declared
with `declare`, assigned in the constructor, and registered in
`defineTypes`. NO class field initializers.

### 4.1 `Enemy` — two new fields

```ts
export class Enemy extends Schema {
  declare id: number;
  declare kind: number;
  declare x: number;
  declare y: number;
  declare z: number;
  declare hp: number;
  // NEW (M8 US-009): slow-effect fields. Single-effect shape — see
  // CLAUDE.md note: adding a 3rd status effect kind requires
  // refactoring to ArraySchema<StatusEffect>.
  declare slowMultiplier: number;   // 1.0 = full speed; <1 = slowed
  declare slowExpiresAt: number;    // -1 = no slow; otherwise tick at which slow expires (mirrors Player.jumpBufferedAt int32 sentinel pattern)
  constructor() {
    super();
    this.id = 0;
    this.kind = 0;
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.hp = 0;
    this.slowMultiplier = 1;
    this.slowExpiresAt = -1;
  }
}
defineTypes(Enemy, {
  id: "uint32",
  kind: "uint8",
  x: "number",
  y: "number",
  z: "number",
  hp: "uint16",
  slowMultiplier: "number",
  slowExpiresAt: "int32",   // int32 because of -1 sentinel — same convention as Player.jumpBufferedAt
});
```

### 4.2 New `BloodPool` schema

```ts
export class BloodPool extends Schema {
  declare id: number;
  declare x: number;
  declare z: number;
  // No `y` — pools are flat ground decals; client renderer queries
  // terrainHeight(x, z) to place the decal on the terrain mesh, the
  // same pattern environmental props (M7 US-014) use.
  declare expiresAt: number;
  declare ownerId: string;
  declare weaponKind: number;   // for future per-weapon pool VFX (e.g. a future ice-axe could leave blue pools)
  declare damagePerTick: number;       // baked at spawn from the spawning weapon's level (so per-pool damage is stable across weapon level-ups mid-run)
  declare tickIntervalMs: number;       // baked at spawn — per-pool DoT cadence
  constructor() {
    super();
    this.id = 0;
    this.x = 0;
    this.z = 0;
    this.expiresAt = 0;
    this.ownerId = "";
    this.weaponKind = 0;
    this.damagePerTick = 0;
    this.tickIntervalMs = 300;
  }
}
defineTypes(BloodPool, {
  id: "uint32",
  x: "number",
  z: "number",
  expiresAt: "uint32",
  ownerId: "string",
  weaponKind: "uint8",
  damagePerTick: "uint16",
  tickIntervalMs: "uint16",
});
```

**Why `damagePerTick` and `tickIntervalMs` are on the pool, not
re-derived from the weapon level at tick time:** the pool persists
beyond the throw. If the player levels up Bloody Axe between throw
and pool expiry, mid-air pools would suddenly do more damage —
fragile and confusing. Baking the per-pool params at spawn is the
single-writer-at-spawn pattern that already governs `Projectile`.

### 4.3 `RoomState` — one new field

```ts
export class RoomState extends Schema {
  // ... existing fields ...
  declare bloodPools: MapSchema<BloodPool>;   // NEW (M8 US-011)
  constructor() {
    super();
    // ... existing assignments ...
    this.bloodPools = new MapSchema<BloodPool>();
  }
}
defineTypes(RoomState, {
  // ... existing entries ...
  bloodPools: { map: BloodPool },             // NEW
});
```

### 4.4 What stays OFF the schema (rule 10 spirit)

- `nextBloodPoolId: number` — counter, lives on `GameRoom` instance
  (matches `nextEnemyId`).
- Per-projectile `pierceRemaining` — server-side projectile state
  only (already off-schema, follows existing `Projectile` pattern).
- Per-projectile `enemyHitCooldowns: Map<enemyId, lastHitMs>` — server
  side per-projectile; matches existing orbit hit-cooldown structural
  shape.
- Per-pool-per-enemy DoT cooldowns — `BloodPoolHitCooldownLike`
  structural interface (parallel to `OrbitHitCooldownLike`).
  Concrete impl in `server/src/bloodPoolHitCooldown.ts`.
- Aura `nextTickAtMs` per-(player, weapon-index) — server-side Map on
  `GameRoom`. Aura state has no projectile/pool entity; the only
  per-instance state is the next-tick scheduler.

---

## 5. Message changes — `packages/shared/src/messages.ts`

### 5.1 `FireEvent` — add `weaponLevel`

```ts
export type FireEvent = {
  type: "fire";
  fireId: number;
  weaponKind: number;
  weaponLevel: number;        // NEW: enables per-level visual scale on client (Ahlspiess hitRadius growth, etc.). Documented as deferred in M5 (weapons.ts:34); now lifted.
  ownerId: string;
  originX: number; originY: number; originZ: number;
  dirX: number; dirY: number; dirZ: number;
  serverTick: number;
  serverFireTimeMs: number;
};
```

### 5.2 `HitEvent` — add `weaponKind`, `tag`. Repurpose for ALL behaviors

```ts
export type HitTag = "default" | "crit" | "status" | "pierce";

export type HitEvent = {
  type: "hit";
  // -1 means "no associated projectile" — emitted by melee_arc swings,
  // aura ticks, and blood-pool DoT. Existing projectile/orbit hits keep
  // the real fireId for projectile-despawn correlation.
  fireId: number;
  enemyId: number;
  damage: number;
  x: number; y: number; z: number;
  weaponKind: number;        // NEW: for VFX selection (particle theme, etc.) — NOT for damage-number color (use `tag`).
  tag: HitTag;               // NEW: drives damage-number color/size on the client. See US-013.
  serverTick: number;
};
```

**Rule-12 boundary:** the client damage-number renderer dispatches
color/size from `tag` only. `weaponKind` is for *non-damage-number*
VFX (a hypothetical particle effect tied to the weapon's color
theme). A grep for `weaponKind === ` in client damage-number code
should return nothing.

### 5.3 New `MeleeSwipeEvent`

```ts
export type MeleeSwipeEvent = {
  type: "melee_swipe";
  ownerId: string;
  weaponKind: number;
  weaponLevel: number;      // visual scale per level
  originX: number; originY: number; originZ: number;
  facingX: number; facingZ: number;
  arcAngle: number;
  range: number;
  isCrit: boolean;          // true if ANY hit in this swing crit'd → drives a brighter slash flash on the client
  serverTick: number;
  serverSwingTimeMs: number;
};
```

One event per swing (not per hit). Damage events for the swing's
hits go through `HitEvent` with `fireId: -1` and `tag: "crit"` or
`"default"` per-hit.

### 5.4 New `BoomerangThrownEvent`

```ts
export type BoomerangThrownEvent = {
  type: "boomerang_thrown";
  fireId: number;
  ownerId: string;
  weaponKind: number;
  weaponLevel: number;
  originX: number; originY: number; originZ: number;
  // 2D direction in XZ. Y component is implicitly 0 — boomerangs
  // travel horizontally; the renderer reads owner.y to track height
  // along the path. (Documented to avoid a Y desync on hilly terrain.)
  dirX: number; dirZ: number;
  outboundDistance: number;
  outboundSpeed: number;
  returnSpeed: number;
  leavesBloodPool: boolean;  // L1/L2 false; L3+ true
  serverTick: number;
  serverFireTimeMs: number;
};
```

### 5.5 `CombatEvent` union — extended

```ts
export type CombatEvent =
  | FireEvent
  | HitEvent
  | EnemyDiedEvent
  | GemCollectedEvent
  | LevelUpOfferedEvent
  | LevelUpResolvedEvent
  | PlayerDamagedEvent
  | PlayerDownedEvent
  | RunEndedEvent
  | MeleeSwipeEvent          // NEW
  | BoomerangThrownEvent;    // NEW
```

### 5.6 `MessageType` registry — extended

```ts
export const MessageType = {
  // ... existing entries ...
  MeleeSwipe: "melee_swipe",            // NEW
  BoomerangThrown: "boomerang_thrown",  // NEW
} as const;
```

---

## 6. `WeaponContext` extension — `packages/shared/src/rules.ts`

```ts
export interface BloodPoolHitCooldownLike {
  tryHit(poolId: number, enemyId: number, nowMs: number, cooldownMs: number): boolean;
  evictEnemy(enemyId: number): void;
  evictPool(poolId: number): void;
}

export type WeaponContext = {
  nextFireId: () => number;
  serverNowMs: () => number;
  pushProjectile: (p: Projectile) => void;
  nextGemId: () => number;
  orbitHitCooldown: OrbitHitCooldownLike;
  // NEW (M8 US-011):
  nextBloodPoolId: () => number;
  bloodPoolHitCooldown: BloodPoolHitCooldownLike;
};
```

The `BloodPoolHitCooldownLike` concrete impl lives in
`server/src/bloodPoolHitCooldown.ts`, parallel to the existing
`server/src/orbitHitCooldown.ts` and `server/src/contactCooldown.ts`.

---

## 7. Tick order — CLAUDE.md rule 11 amendment

**Current canonical order (CLAUDE.md):**

```
tickPlayers → tickEnemies → tickContactDamage → tickRunEndCheck
→ tickWeapons → tickProjectiles → tickGems → tickXp
→ tickLevelUpDeadlines → tickSpawner
```

**Amended order (M8):**

```
tickPlayers → tickStatusEffects → tickEnemies → tickContactDamage → tickRunEndCheck
→ tickWeapons → tickProjectiles → tickBloodPools → tickGems → tickXp
→ tickLevelUpDeadlines → tickSpawner
```

**Insertions and rationale:**

- `tickStatusEffects` BEFORE `tickEnemies` — `tickEnemies` reads
  `enemy.slowMultiplier` to scale movement; if status expiration ran
  *after* movement, an enemy whose slow expired this tick would still
  be slowed for one extra tick. Putting it before makes "slow expires
  at tick T" mean "tick T uses full speed."
- `tickBloodPools` AFTER `tickProjectiles`, BEFORE `tickGems` —
  symmetric to "weapons before projectiles, gems after projectiles":
  pool DoT can kill an enemy this tick, and the kill must drop a gem
  before `tickGems` runs the pickup pass. Same fairness invariant
  the existing comment in CLAUDE.md cites for projectile→gem ordering.

**Universal early-out invariant respected:** both new tick functions
begin with `if (state.runEnded) return;` (CLAUDE.md rule 11).

**RNG-schedule preservation:** neither `tickStatusEffects` nor
`tickBloodPools` calls `state.rng()`. Only `tickXp` and `tickSpawner`
do (unchanged). The seeded schedule across clients does NOT fork.

**CLAUDE.md edit required:** rule 11's full prose paragraph (the
"Players first so weapons see fresh positions; …" sequence) needs
two new clauses added inline:

> *…tickStatusEffects before tickEnemies so movement uses fresh slow
> state; tickBloodPools after tickProjectiles and before tickGems so
> this-tick pool kills drop pickups before pickup checks run…*

---

## 8. CLAUDE.md edits required

Two distinct edits to CLAUDE.md (proposed in the implementation of US-009 and US-011):

### 8.1 Status-effect refactor note (US-009)

Add this paragraph to the **"Things NOT to do"** section (or as a
short subsection at the end of "Architectural rules"):

> **Status effects scale to two kinds, not three.** `Enemy` carries
> `slowMultiplier` and `slowExpiresAt` directly as fields — a
> single-effect shape, deliberate for one effect kind. If a future
> weapon needs a second effect kind (burn, freeze, stun, poison),
> add it the same way (a parallel pair of fields). If a third kind
> is needed, **refactor first**: replace the per-effect fields with
> `ArraySchema<StatusEffect>` per enemy (kind, magnitude,
> expiresAt), then add the third effect on top of the generic
> shape. The current per-effect fields are not infinitely
> extensible.

### 8.2 Tick order amendment (US-009 + US-011)

Update rule 11's order list and prose (see §7 above).

---

## 9. Things deliberately NOT changed

These were considered and explicitly rejected for this milestone:

- **No `damage_dealt` event introduced.** The PRD said `damage_dealt`
  but the project's event today is `HitEvent`. Extending it with
  `tag` and `weaponKind` is the lighter change. (Cross-check: the
  M7 PR comment in `messages.ts:97` "M7 US-013: hit events carry the
  impact position so floating damage numbers spawn at the right
  altitude" confirms HitEvent is already the canonical "damaged"
  event; we're just generalizing its source.)
- **No physics engine for boomerang return.** Closed-form piecewise
  trajectory (outbound straight line, then return-toward-current-
  owner-position straight line) is deterministic and matches CLAUDE.md
  rule 12 "client-simulated weapons are closed-form."
- **No `Player.maxStatusEffects` or generic effect array.** Single-
  effect shape now (per US-009 decision). The CLAUDE.md note bakes
  in the refactor trigger.
- **No new constants block.** All new tunables live in the
  `WEAPON_KINDS` table, not in `shared/constants.ts`. Constants file
  remains player/enemy/jump/terrain only.
- **No change to `WeaponState` schema.** For aura, the existing
  `cooldownRemaining` field is repurposed as "seconds until next aura
  tick." Aura keeps `cooldown: 0` in level data; tickWeapons just
  uses `cooldownRemaining` as the running countdown to next tick.
  That's a server-side semantics-of-an-existing-field shift; no
  schema migration.
- **No level-up choice weighting changes.** All 8 weapons equally
  weighted in choice pools. PRD §non-goals.

---

## 10. Open questions — resolutions

These were flagged in the PRD §9. Proposed resolutions for review:

### A1: Boomerang return target on owner death

**Resolution:** if the owner is `downed === true` mid-flight, the axe
freezes its return target at the owner's current XZ at the moment
of downing, and proceeds toward that frozen point. If the owner is
removed entirely (left the room) before the axe lands, the axe
despawns. Server still emits the same `boomerang_thrown` event at
throw time; no mid-flight notification needed (clients reconcile via
the deterministic trajectory).

### A2: Slow stacking (longer-but-weaker case)

**Resolution:** **stronger slow always wins, ignore duration.** The
`applySlow` helper is:

```
if (existing slow active && new multiplier >= existing multiplier) ignore
else overwrite (multiplier and expiresAt both)
```

Concretely: a long weak slow does NOT extend a short strong slow's
expiry. The strong slow expires on schedule and the weak slow
re-applies on the *next* enemy/aura interaction. For Kronos
specifically (single-source slow), this is a no-op. The clean
specification is captured in the CLAUDE.md status-effect note (§8.1).

### A3: Pierce + homing interaction (Gakkung re-acquire after pierce)

**Resolution:** **target lock-on at fire time, no re-acquire.** The
locked target id is captured at fire and rides on the projectile
state. The projectile homes toward the locked target's current
position each tick until lifetime expires. If the locked target
dies, the projectile continues on its current heading (no
re-target — keeps determinism trivial: client sim only needs the
fire-time target id, not a per-tick target stream).

The `enemyHitCooldownsMs` then reduces to a defensive belt for
pathological cases (homing curl-back).

**Implication for client sim:** `FireEvent` payload must include
`lockedTargetId: number | -1`. -1 = no target (e.g. fire-on-cooldown
with no enemies in range — the projectile travels straight in player
facing direction, like Ahlspiess).

```ts
// Addendum to FireEvent in §5.1:
lockedTargetId: number;   // -1 = no lock (straight-line flight)
```

### A4: Aura — 2D vs 3D radius

**Resolution:** **3D distance**, consistent with M7 US-013 projectile
hit detection (`Math.hypot(dx, dy, dz)`). On hilly terrain, a Kronos
player on a hilltop will NOT hit enemies in the valley below outside
their 3D distance. Same physics rules for everything.

---

## 11. Test surface map

Where the new tests will live (per the PRD; recap here for review).
Each US's acceptance-criteria block in `prd.json` lists its specific
Vitest cases.

| Coverage area                          | File                                            |
|----------------------------------------|-------------------------------------------------|
| Targeting modes (nearest/furthest/facing) | `packages/shared/test/rules.test.ts`         |
| Projectile homing turn rate            | `packages/shared/test/rules.test.ts`            |
| Pierce decrement & infinite-pierce     | `packages/shared/test/rules.test.ts`            |
| `melee_arc` arc selection (boundary)   | `packages/shared/test/rules.test.ts`            |
| Crit determinism under seeded RNG      | `packages/shared/test/rules.test.ts`            |
| Knockback vector + magnitude           | `packages/shared/test/rules.test.ts`            |
| `applySlow` strong-vs-weak rule        | `packages/shared/test/rules.test.ts`            |
| Aura damage-tick cadence + radius     | `packages/shared/test/rules.test.ts`            |
| Boomerang trajectory math              | `packages/shared/test/rules.test.ts`            |
| Boomerang owner-downed return target   | `packages/shared/test/rules.test.ts`            |
| Blood-pool DoT + per-enemy cooldown    | `packages/shared/test/rules.test.ts`            |
| Blood-pool determinism (same seed)     | `packages/shared/test/rules.test.ts`            |
| Tick-order regression (rule 11)        | `packages/shared/test/rules.test.ts`            |
| Encoder regression (new schema fields) | `packages/server/test/integration.test.ts`     |
| Two-player Kronos slow integration     | `packages/server/test/` (new file or rules)    |

The integration test in `packages/server/test/integration.test.ts`
is **mandatory** — landmine #1 (schema field encoder crash) only
fires under a real Colyseus run.

---

## 12. Implementation order recap

This is what `prd.json` US-002 → US-013 implements, gated by US-001
(this doc), US-008 (mid playtest), US-014 (final playtest):

1. US-002 — refactor `WeaponBehavior` (extended projectile fields);
   Bolt non-regression.
2. US-003 — Gakkung Bow.
3. US-004 — Ahlspiess.
4. US-005 — `melee_arc` behavior + `melee_swipe` event.
5. US-006 — Damascus.
6. US-007 — Claymore.
7. **US-008 — 🛑 mid-milestone playtest gate (4 new weapons live).**
8. US-009 — status effect infrastructure (slow) + CLAUDE.md note.
9. US-010 — `aura` behavior + Kronos.
10. US-011 — `boomerang` behavior + `BloodPool` schema/tick.
11. US-012 — Bloody Axe.
12. US-013 — damage-number color coding + per-level scaling pass.
13. **US-014 — 🛑 final playtest gate.**

---

## 13. Summary diff

**`packages/shared/src/`:**
- `weapons.ts` — extend `TargetingMode`; extend `ProjectileLevel`; add
  `MeleeArcLevel`, `AuraLevel`, `BoomerangLevel`; refactor `WeaponDef`
  to 5-arm union; add new type guards; add 6 new entries to
  `WEAPON_KINDS`.
- `schema.ts` — add `slowMultiplier`, `slowExpiresAt` to `Enemy`; add
  new `BloodPool` class; add `bloodPools: MapSchema<BloodPool>` to
  `RoomState`. All declare-style + `defineTypes`.
- `messages.ts` — extend `FireEvent` with `weaponLevel` +
  `lockedTargetId`; extend `HitEvent` with `weaponKind` + `tag`; add
  `HitTag` type, `MeleeSwipeEvent`, `BoomerangThrownEvent`; extend
  `CombatEvent` and `MessageType`.
- `rules.ts` — add `tickStatusEffects` (before `tickEnemies`); add
  `tickBloodPools` (after `tickProjectiles`); 3 new arms in
  `tickWeapons` (`melee_arc`, `aura`, `boomerang`); extend projectile
  arm with targeting modes / homing / pierce; extend `WeaponContext`
  with `nextBloodPoolId` + `bloodPoolHitCooldown`; add
  `BloodPoolHitCooldownLike` interface; add `applySlow` helper.

**`packages/server/src/`:**
- `bloodPoolHitCooldown.ts` — new file (parallels `orbitHitCooldown.ts`).
- `GameRoom.ts` — wire `nextBloodPoolId` counter; wire
  `bloodPoolHitCooldown` instance; insert two new tick calls into
  the per-tick sequence in the documented amended order.

**`packages/client/src/`:**
- `game/` — new renderers for `melee_arc`, `aura`, `boomerang`, plus
  `BloodPool` ground decals; per-weapon mesh/material distinction
  for the new projectile weapons. All dispatch on `behavior.kind`
  / `tag`, never name.
- `net/` — subscribe to `melee_swipe`, `boomerang_thrown`; consume
  extended `HitEvent`/`FireEvent` fields.

**`CLAUDE.md`:**
- Rule 11 prose extended (§7 above).
- New "Status effects scale to two kinds, not three" note (§8.1).

**`tasks/`** and **`docs/`** — unchanged after this review doc lands.

---

## 14. Approval

To unblock US-002, please confirm:

- [ ] Type shapes in §2 (especially the per-behavior `*Level` split,
  and `targeting`/`homingTurnRate` on `behavior`)
- [ ] Weapon table values in §3 (these are starting values; balance is
  US-014's deferred follow-up — bar is "shipping defaults aren't
  broken," not "balanced")
- [ ] Schema additions in §4 (declare-style + defineTypes;
  `damagePerTick`/`tickIntervalMs` baked on `BloodPool` at spawn)
- [ ] Message changes in §5 — especially the choice to **extend
  `HitEvent`** rather than introduce a new `damage_dealt` event,
  and the addition of `weaponLevel` + `lockedTargetId` to `FireEvent`
- [ ] Tick order amendment in §7
- [ ] Open-question resolutions in §10 — particularly **A3
  (target-lock-on-fire with `lockedTargetId` on `FireEvent`)** which
  is the most consequential
- [ ] CLAUDE.md edits in §8

Or push back on any of the above.
