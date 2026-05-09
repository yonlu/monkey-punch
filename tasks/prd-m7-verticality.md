# PRD: Milestone 7 — True 3D (Camera, Jump, Terrain)

## 1. Introduction / Overview

Milestone 6 made the game playable but exposed that the third-person camera was implemented too conservatively (fixed world rotation, no jump, flat void map). This milestone closes the perceptual gap to Megabonk: a mouse-rotated orbit camera with camera-relative WASD, real jump physics with air time and forgiveness windows, a heightmapped terrain with hills and valleys, environmental props (trees, rocks, bushes), and a proper sky.

This is a structural milestone disguised as a polish milestone. Verticality touches schema (Y now matters), prediction/reconciliation (third axis), interpolation, the spawner (enemies on ground), enemy AI (follow terrain), and weapons (fire/aim from real Y). All gameplay logic stays in `shared/rules.ts` per CLAUDE.md rule 4; all synced state stays in `shared/schema.ts` per rule 2; the seeded PRNG and a new shared `terrainHeight(x, z)` are the single source of truth for both server simulation and client prediction.

## 2. Goals

- Camera: Megabonk-style mouse-rotated orbit camera with camera-relative movement; player faces movement direction.
- Verticality: working jump with gravity, coyote time, jump buffering; client prediction reconciles Y identically to server.
- World: heightmapped terrain with flat spawn area, deterministic across server and client, with environmental props and a sky.
- Determinism: `terrainHeight(x, z)` returns bit-identical values on server and client for the same seed (Vitest-asserted).
- Performance: 200 enemies + props + terrain mesh holds 60fps client and 20Hz server.
- Architectural compliance: no rule in CLAUDE.md is violated; tick order in rule 11 is preserved.

## 3. User Stories

The 13 implementation steps from the brief become 13 stories, plus 2 explicit human-checkpoint stories that block forward progress.

### US-001: Shared deterministic terrain function

**Description:** As the simulation, I need a single `terrainHeight(x, z)` function imported by both server and client so prediction and authoritative simulation produce identical Y positions.

**Acceptance Criteria:**
- [ ] `packages/shared/src/terrain.ts` exports `initTerrain(seed: number)` and `terrainHeight(x, z): number`
- [ ] Multi-octave noise: scale1=0.02 (amp 4), scale2=0.08 (amp 1.2), scale3=0.20 (amp 0.3)
- [ ] Spawn-area flattening: smoothly damp height to ~0 within 8 units of origin (`h * t * t` ramp)
- [ ] Same `(seed, x, z)` → identical float on every call (no hidden mutable state across calls)
- [ ] Vitest: `terrainHeight` returns identical values for the same `(seed, x, z)` after re-init
- [ ] Vitest: heights within 8 units of origin are within ±0.05 of zero
- [ ] Vitest: a snapshot of 5 known `(seed, x, z) → height` tuples — protects against accidental algorithm change
- [ ] `simplex-noise` and `alea` added to `packages/shared/package.json` as runtime deps (per the CLAUDE.md exception for cross-runtime determinism — see updated rule wording in CLAUDE.md "Stack" and "Things NOT to do" sections)
- [ ] `pnpm typecheck` passes; `pnpm test` passes in shared

### US-002: Server reads terrain height for players

**Description:** As the server, I need to keep each player's Y attached to the terrain so the world has shape before any rendering work begins.

**Acceptance Criteria:**
- [ ] `Player` schema has `y: number`, `vy: number`, `grounded: boolean` (rule 2 — synced state lives only in `shared/schema.ts`)
- [ ] `RoomState` has a `seed: number` (likely already present from rule 6) and `initTerrain(state.seed)` is called on room boot
- [ ] `tickPlayers` in `shared/rules.ts` snaps `player.y = terrainHeight(player.x, player.z) + PLAYER_GROUND_OFFSET` each tick (no jump yet — vy ignored)
- [ ] Tick order in CLAUDE.md rule 11 is unchanged
- [ ] Visible in Colyseus monitor: `player.y` updates as a function of `(x, z)`
- [ ] Vitest: integration test — drive an input that walks a player across known terrain, assert Y matches `terrainHeight` at each tick
- [ ] `pnpm typecheck` passes; `pnpm test` passes in shared and server

### US-003: Client renders terrain mesh with slope shading

**Description:** As a player, I want to see a real 3D world with hills and valleys so the game has a sense of place.

**Acceptance Criteria:**
- [ ] On room join, client calls `initTerrain(state.seed)` (same seed as server)
- [ ] `PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, 200, 200)` rotated to horizontal, vertices displaced by `terrainHeight`
- [ ] `geo.computeVertexNormals()` after displacement
- [ ] Custom slope-based shader: grass color on flat areas, rock color on steep, mixed via `smoothstep(0.2, 0.5, 1 - vNormal.y)`
- [ ] Map boundary marker updated to a tall cylinder (per brief — simplest approach)
- [ ] Visual sanity check: top-down debug screenshot matches what the server's `terrainHeight` says (this can be a manual eyeball check during the design-review checkpoint in §6)
- [ ] 60fps holds with terrain mesh in scene (no other regressions)
- [ ] `pnpm typecheck` passes

### US-004: Client renders player at correct Y

**Description:** As a player, I want my character (and other players) to sit on the terrain instead of floating at y=0.

**Acceptance Criteria:**
- [ ] Local-player mesh reads `player.y` from predicted state
- [ ] Remote-player meshes read interpolated Y (extend the existing two-snapshot interpolation buffer to include Y — same lerp, no new buffer)
- [ ] Visually: standing still on a hill, the cube sits flush with the terrain mesh
- [ ] Walking up/down hills, the cube's Y tracks smoothly without jitter
- [ ] `pnpm typecheck` passes

### US-005: Mouse-orbit camera with pointer lock and camera-relative WASD

**Description:** As a player, I want to drag the camera around with the mouse and have WASD move me relative to where the camera is looking, so the game feels like Megabonk.

**Acceptance Criteria:**
- [ ] `client/camera.ts` constants block per brief: `CAMERA_DISTANCE=9`, `CAMERA_LOOK_HEIGHT=1.2`, `CAMERA_PITCH_MIN=-10°`, `CAMERA_PITCH_MAX=60°`, `CAMERA_PITCH_DEFAULT=35°`, `MOUSE_SENSITIVITY_X=0.0025`, `MOUSE_SENSITIVITY_Y=0.0020`, `CAMERA_FOLLOW_LERP=18`
- [ ] Pointer-lock flow: clicking the canvas requests pointer lock; ESC / tab-out releases; `pointerlockchange` listener updates state
- [ ] "Click to play" overlay shown whenever pointer is not locked (covers the canvas, blocks gameplay until clicked)
- [ ] Mouse movement (only while locked): `yaw -= movementX * sensX`, `pitch -= movementY * sensY`, pitch clamped, yaw unbounded
- [ ] Camera position computed from yaw/pitch orbit math (per brief), then lerped frame-rate-independently with `1 - exp(-CAMERA_FOLLOW_LERP * dt)`
- [ ] Yaw direction convention is documented in a comment in `camera.ts`
- [ ] WASD transformed via camera yaw only (NOT pitch) before being sent as the `dir` field on the existing `input` message
- [ ] Player visual rotation lerps smoothly toward movement direction (NOT toward camera). When stopped, last facing holds.
- [ ] Old crosshair from M6 removed
- [ ] `facing` is no longer in the `input` message (rule 3 — `messages.ts` is updated; no parallel field)
- [ ] Server derives player facing from movement direction (in `tickPlayers`, kept in `shared/rules.ts` per rule 4)
- [ ] `pnpm typecheck` passes

### US-006: 🛑 BLOCKING — Camera review checkpoint

**Description:** As the project owner (Luke), I need to play the camera before the next 8 implementation steps commit to a foundation that may need to change. Camera feel is the highest tactical risk in the milestone.

**Acceptance Criteria:**
- [ ] Build deployed/runnable locally with steps US-001 through US-005 complete
- [ ] Luke has played for at least one session (~10 min) with the new camera
- [ ] Luke has explicitly approved the feel OR provided concrete tuning changes that have been applied and re-tested
- [ ] If approved: write the approved values back to the `camera.ts` constants block (so they survive)
- [ ] If not approved: iterate on `MOUSE_SENSITIVITY_X/Y`, `CAMERA_PITCH_DEFAULT`, `CAMERA_FOLLOW_LERP`, `CAMERA_DISTANCE` BEFORE proceeding
- [ ] No work on US-007+ begins until this story is closed

### US-007: Camera terrain occlusion (raycast pull-in)

**Description:** As a player, when I walk near a hill, the camera should not clip into the terrain.

**Acceptance Criteria:**
- [ ] Per-frame raycast from `(player.x, player.y + CAMERA_LOOK_HEIGHT, player.z)` toward desired camera position
- [ ] Raycast targets ONLY the terrain mesh (not props, not players, not enemies)
- [ ] On hit: place camera at `hitDistance - 0.3`, clamped to a minimum of 0.5 from player
- [ ] On no-hit: camera goes to desired position
- [ ] No visible jitter as the camera transitions between occluded and non-occluded states (verify by walking in/out of hill shadow)
- [ ] `pnpm typecheck` passes

### US-008: Jump physics server-side (gravity, coyote, buffer)

**Description:** As a player, I want to jump with the spacebar, and the jump should be forgiving (coyote time when running off ledges, jump buffering when pressing slightly before landing).

**Acceptance Criteria:**
- [ ] Constants in `shared/constants.ts`: `GRAVITY=25`, `JUMP_VELOCITY=9`, `TERMINAL_FALL_SPEED=30`, `PLAYER_GROUND_OFFSET=0` (tunable later), `COYOTE_TIME=0.1`, `JUMP_BUFFER=0.1`
- [ ] `Player` schema gains `lastGroundedAt: number` (tick) and `jumpBufferedAt: number` (tick, -1 = none) — rule 2 compliance
- [ ] `input` message extended in `shared/messages.ts` to include `jump: boolean` (rule 3 — single discriminated union edited in one file)
- [ ] `tickPlayers` in `shared/rules.ts`: applies gravity to vy, integrates Y, snaps to ground when below terrain, sets `grounded` and `lastGroundedAt`
- [ ] `canJump(player, tick)` returns true if grounded OR within `COYOTE_TIME` of last grounded tick
- [ ] Buffered jump: if `jump=true` arrives airborne, `jumpBufferedAt = state.tick`; on landing within `JUMP_BUFFER` seconds, jump executes
- [ ] No `Math.random` introduced (rule 6); jump is fully deterministic from inputs
- [ ] Vitest: peak height of jump ≈ `JUMP_VELOCITY² / (2 * GRAVITY)` within 1%
- [ ] Vitest: ground snap — Y below terrain → snapped to terrain, vy=0, grounded=true
- [ ] Vitest: coyote time — walk off ledge, jump @ 0.05s succeeds, jump @ 0.15s fails
- [ ] Vitest: jump buffer — press jump 0.05s before landing, jump executes on landing tick
- [ ] Server integration: 1 player joins, sends jump input, full Y trajectory matches expected within tick-by-tick assertions
- [ ] `pnpm typecheck` passes; `pnpm test` passes

### US-009: Client prediction handles Y / vy / grounded / jump

**Description:** As a player, when I jump, my local character should peak and land smoothly without a rubber-band correction from the server.

**Acceptance Criteria:**
- [ ] Client-side prediction (rule 9) extended: predicted state includes `y, vy, grounded`
- [ ] Reconciliation: on each server snapshot, re-apply unacknowledged inputs (`seq > Player.lastProcessedInput`) to the server's authoritative `(x, y, z, vy, grounded)` to produce the predicted current frame
- [ ] Replay uses the SAME `terrainHeight` function and the SAME constants as the server — both come from `packages/shared`
- [ ] Visual: jump on flat ground, then on a hill, then while running — no rubber-band, no jitter
- [ ] Two-client determinism: open two clients, both jump at the same tick (e.g. via timed input), Y traces match
- [ ] `pnpm typecheck` passes

### US-010: Enemies snap to terrain

**Description:** As an enemy, I should walk on the ground, not float.

**Acceptance Criteria:**
- [ ] `Enemy` schema gains `y: number` (rule 2)
- [ ] `tickEnemies` (in `shared/rules.ts`): after movement integration, `enemy.y = terrainHeight(enemy.x, enemy.z) + ENEMY_GROUND_OFFSET`
- [ ] Enemies do NOT have vy and do NOT jump
- [ ] Tick order from CLAUDE.md rule 11 unchanged
- [ ] Client-side `InstancedMesh` for enemies: per-instance Y comes from interpolated `SnapshotBuffer` keyed by `Enemy.id` (rule 10 — never iteration order)
- [ ] Visual: enemies walk smoothly up and down hills toward the player
- [ ] If steep cliffs cause enemies to "warp" up faces, the fix is reducing terrain noise amplitude — not pathfinding (per brief)
- [ ] `pnpm typecheck` passes; `pnpm test` passes

### US-011: Projectiles in 3D

**Description:** As a player, I should be able to jump over enemy projectiles, and my projectiles should fire from my actual position toward an enemy's actual position.

**Acceptance Criteria:**
- [ ] Bolt projectiles: origin uses player Y, target uses enemy Y, motion is straight-line in 3D (no arc, no projectile-gravity)
- [ ] Orbit projectiles: orbit at `player.y` (not at y=0)
- [ ] Hit detection uses 3D distance (`Math.hypot(dx, dy, dz)` against weapon radius)
- [ ] Enemy projectiles (if Shooters from M6 exist): fire from `enemy.y` toward player position in 3D
- [ ] Projectile-behavior weapons remain a closed-form function of the `fire` event payload on clients (rule 12 — fire payload now includes Y for both endpoints)
- [ ] Orbit-behavior weapons remain a closed-form function of `(state.tick, player position incl. Y, weapon level)` (rule 12)
- [ ] `damage_dealt` / `hit` events include Y in their position payload so floating damage numbers spawn at the right altitude
- [ ] Manual verification: jump over an enemy projectile → it misses
- [ ] No name-based branching added to `tickWeapons`, `tickProjectiles`, or render code (rule 12)
- [ ] `pnpm typecheck` passes; `pnpm test` passes

### US-012: Environmental props (trees, rocks, bushes)

**Description:** As a player, I want to see things in the world other than enemies — trees, rocks, bushes — so it feels alive.

**Acceptance Criteria:**
- [ ] `packages/shared/src/props.ts` exports `generateProps(seed: number): Prop[]` per the brief's grid+jitter algorithm
- [ ] Spacing 6, skip-radius 12 (keep spawn area clean), 60% prop probability per cell, jitter ≤ 80% of spacing
- [ ] Each prop has `kind, x, z, y (= terrainHeight), rotation, scale`
- [ ] Same seed → identical prop list (Vitest asserts this with a snapshot of N props from a fixed seed)
- [ ] Props are NOT in the schema and are NOT synced (rule 2 derivation: clients regenerate from `state.seed`)
- [ ] Quaternius CC0 GLTF assets used for tree / rock / bush meshes (loaded via `GLTFLoader`)
- [ ] Each kind rendered as one `InstancedMesh` (rule 10 spirit — no Mesh per prop)
- [ ] Two-client determinism: both clients render props in identical positions
- [ ] Players can walk through props — no collision (deferred per brief)
- [ ] `pnpm typecheck` passes; `pnpm test` passes in shared

### US-013: Sky and atmospheric lighting

**Description:** As a player, I want the world to look like an outdoor place, not a void.

**Acceptance Criteria:**
- [ ] `scene.background` set to sky blue (`0x87ceeb` as starting point)
- [ ] `scene.fog = new Fog(skyColor, 30, MAP_RADIUS * 1.5)` so distant terrain fades to sky
- [ ] `DirectionalLight` (intensity ~0.9) positioned high as the sun
- [ ] `HemisphereLight(skyColor, groundColor, 0.5)` for fill
- [ ] Shadows DEFERRED (per brief — too easy to misconfigure, defer to a polish pass)
- [ ] Visual: standing in any spot, the horizon fades cleanly into sky rather than ending at a hard edge
- [ ] `pnpm typecheck` passes

### US-014: Polish-pass tuning

**Description:** As a player, the camera/jump/terrain should feel right — defaults are starting points, not end states.

**Acceptance Criteria:**
- [ ] Mouse sensitivity tuned (not nauseating, not dead)
- [ ] Camera pitch default tuned for what looks right with new terrain (hills can change ideal pitch)
- [ ] Jump velocity vs gravity tuned for desired air time and peak (jot down current values vs new values in commit message)
- [ ] Camera follow lerp tuned (not glued, not disconnected)
- [ ] Terrain amplitude tuned — if enemies warp on cliffs, reduce noise amplitude here (NOT add pathfinding)
- [ ] All final tuning values committed to constants files (camera.ts, constants.ts, terrain.ts) — no magic numbers in component code
- [ ] `pnpm typecheck` passes; `pnpm test` passes

### US-015: 🛑 BLOCKING — Final playtest with friends

**Description:** As the project owner (Luke), I need to playtest this milestone with the same friends from M5/M6 before declaring it complete. Tuning is best done with feedback.

**Acceptance Criteria:**
- [ ] Build deployed somewhere the same friend group can join
- [ ] At least one playtest session held (Discord + 5 players target)
- [ ] Three feedback questions asked explicitly: "Does the camera feel good? Is the jump satisfying? Does the world feel like a place?"
- [ ] If any answer is "no" or "I guess so": at least one tuning iteration happens before the milestone is closed (do not accept "it's fine I guess" — per brief)
- [ ] Memory updated: post-playtest impressions saved as a new feedback memory if anything surprising emerged
- [ ] Milestone declared complete only after this story passes

## 4. Functional Requirements

- **FR-1:** A pure function `terrainHeight(x, z): number` lives in `packages/shared/src/terrain.ts` and is initialized with the room seed; both server and client import it. Same `(seed, x, z)` always returns the same float.
- **FR-2:** `Player` schema gains `y, vy, grounded, lastGroundedAt, jumpBufferedAt`; `Enemy` schema gains `y`. All Y values are server-authoritative.
- **FR-3:** The `input` message in `shared/messages.ts` gains a `jump: boolean` field and loses the `facing` field. Server derives facing from movement direction.
- **FR-4:** `tickPlayers` integrates gravity, applies input movement in X/Z, snaps Y to terrain when below ground, and resolves jump intent honoring coyote time and jump buffer.
- **FR-5:** `tickEnemies` snaps each enemy's Y to terrain after movement integration. Tick order from CLAUDE.md rule 11 is preserved unchanged.
- **FR-6:** Client renders an orbit camera around the player. Yaw and pitch are driven by mouse movement only while pointer lock is engaged. Pitch is clamped; yaw is unbounded.
- **FR-7:** Pointer lock is requested on canvas click. A "Click to play" overlay is shown whenever pointer lock is not engaged (including after ESC and after tab-out).
- **FR-8:** WASD input is interpreted in camera space and transformed to world space using camera yaw only (NOT pitch) before being sent in the `dir` field of the `input` message.
- **FR-9:** Player character mesh rotates to face its movement direction (visual rotation lerps smoothly). It does not rotate to face the camera.
- **FR-10:** Camera occlusion: per-frame raycast from `(player x, player y + look-height, player z)` toward desired camera position against the terrain mesh; on hit, camera is pulled in to `hitDistance - 0.3` (min 0.5).
- **FR-11:** Client-side prediction extends to `(y, vy, grounded)`. Reconciliation re-applies unacknowledged inputs (`seq > Player.lastProcessedInput`) on top of authoritative state, using the same `terrainHeight` and same physics constants as the server.
- **FR-12:** Remote players interpolate Y between the two most recent snapshots, using the existing snapshot buffer extended to include Y. No extrapolation (CLAUDE.md "Things NOT to do").
- **FR-13:** Bolt projectiles fire from the firing player's full 3D position toward target's full 3D position, with 3D hit-distance checks. Orbit projectiles orbit at `player.y`. The `fire` event payload includes Y for both endpoints; `hit` and `damage_dealt` events include Y.
- **FR-14:** Terrain mesh is a `PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, 200, 200)` with vertices displaced by `terrainHeight` and a slope-based shader. Map boundary is rendered as a tall cylinder.
- **FR-15:** Environmental props are deterministically generated by `generateProps(seed)` in `packages/shared/src/props.ts`, NOT placed in the schema, and rendered as one `InstancedMesh` per kind on the client. Quaternius CC0 GLTF assets used for meshes.
- **FR-16:** Sky uses solid background color, `THREE.Fog` to fade distant terrain to sky, one `DirectionalLight` (sun), one `HemisphereLight` (fill). No shadows this milestone.
- **FR-17:** No new gameplay code uses `Math.random` (CLAUDE.md rule 6). All randomness in terrain/props is seeded from `state.seed` via the same scheme.
- **FR-18:** Two-client determinism: with the same `state.seed`, both clients render terrain, props, and player Y trajectories identically.

## 5. Non-Goals (Out of Scope)

- Double jump, dash, or any movement ability beyond a single grounded jump.
- Bunny-hopping mechanics (may emerge organically; do not engineer for it).
- Prop collision — players walk through trees/rocks/bushes.
- Procedural terrain features beyond noise: no rivers, caves, plateaus, biomes, water, lava, hazards.
- Animated character meshes — characters remain cubes/cones (next milestone).
- Sound — still queued for its own milestone.
- Real-time shadows — defer to polish pass.
- Camera shake, hit-stop, or game-feel polish beyond what verticality requires (e.g., a static shadow blob under the player is OK, broader game-feel pass is not).
- New enemies or new weapons — verticality applied to existing content only.
- Camera-relative aim direction or aim-direction-based weapons — auto-targeting still does the work.
- Pathfinding for enemies around steep terrain — fix steep terrain instead.
- Slope-based movement speed — constant horizontal speed regardless of incline.
- Camera that auto-rotates the player or auto-aligns to movement — camera and player facing are independent.

## 6. Design Considerations

- **Camera is the highest-risk feel piece.** US-006 is an explicit blocking checkpoint specifically because every other constant downstream is built on top of camera assumptions. Do not attempt to "save" the checkpoint by skipping ahead.
- **Constants live in dedicated files** (`client/camera.ts`, `shared/constants.ts`, `shared/terrain.ts`) so the polish pass (US-014) and post-playtest tuning (US-015) can move numbers without touching component code.
- **The "Click to play" overlay is part of the core UX**, not a stretch feature. Pointer lock is released on tab-out, ESC, modal dialogs, and various edge cases — every release path must lead back to a discoverable re-lock.
- **Slope shader is intentionally simple** — a `mix(grass, rock, smoothstep(0.2, 0.5, 1 - vNormal.y))` in a fragment shader. Texturing is polish-pass material.
- **Quaternius CC0 assets** are the right choice for props: free, attribution-friendly, low-poly, fits the cube-character aesthetic. Confirm GLTF availability for tree/rock/bush families before US-012.
- **No crosshair** — the M6 crosshair is removed. Reticle for aim-direction weapons is a future milestone concern.

## 7. Technical Considerations

- **CLAUDE.md compliance is non-negotiable:** rule 2 (synced state in `shared/schema.ts`), rule 3 (messages in `shared/messages.ts`), rule 4 (logic in `shared/rules.ts`, handlers thin), rule 5 (no methods on schemas), rule 6 (no `Math.random`), rule 9 (20Hz tick, fixed dt 0.05, prediction + snapshot interpolation), rule 10 (enemies via `InstancedMesh` keyed by `Enemy.id`), rule 11 (tick order — adding terrain queries inside existing tick functions does NOT change the order), rule 12 (combat events stay events).
- **The `shared/` runtime-deps rule is in tension with the brief.** CLAUDE.md says "Do not add npm packages to `shared/` beyond `@colyseus/schema`." The brief asks for `simplex-noise` and `alea` in `shared/`. See Open Question Q1 — must be resolved before US-001 begins.
- **Terrain determinism is load-bearing.** Any divergence between client and server `terrainHeight` produces visible jump desync. The Vitest snapshot test for `terrainHeight` is the early warning — do NOT remove or weaken it.
- **The two-axis sensitivity asymmetry** (`SENS_X=0.0025`, `SENS_Y=0.0020`) is intentional from the brief — slightly less vertical reduces nausea. Keep both available as separate constants even if the polish pass converges them.
- **Schema bandwidth:** adding `y, vy, grounded, lastGroundedAt, jumpBufferedAt` to Player and `y` to Enemy roughly doubles position payload per entity. With 200 enemies that's ~400 extra bytes/snapshot — negligible at 20Hz.
- **Frame-rate-independent lerps** for camera follow (`1 - exp(-rate * dt)`). Do not use raw lerp factors that bake in 60fps assumptions.
- **Pointer lock state machine:** `lockRequested → lockGranted → lockReleased (ESC | tab-out | modal) → overlay shown → click → lockRequested`. Listen for `pointerlockchange` and `pointerlockerror`.

## 8. Success Metrics

- Camera response to mouse input is sub-frame; no perceptible input lag.
- Two clients show the same player Y to within snapshot interpolation tolerance during a coordinated jump.
- 60fps client / 20Hz server held with full enemy load (200) on hilly terrain with all props.
- Terrain Vitest determinism test stays green across CI and local runs forever.
- Post-playtest (US-015): all three feel questions ("camera good?", "jump satisfying?", "world a place?") get an enthusiastic "yes" from at least 3 of the 5 friends. Otherwise — iterate before claiming done.
- A friend who played M6 and plays this milestone immediately notices the camera change without prompting.

## 9. Open Questions

**Q1 — `shared/` runtime deps:** ✅ **RESOLVED → Option (a):** `simplex-noise` and `alea` added to `packages/shared/package.json`. CLAUDE.md updated to articulate the principled exception: a dep belongs in `shared/` only when its output must be bit-identical between server and client. Future deps must clear the same load-bearing-determinism bar.

**Q2 — `PLAYER_GROUND_OFFSET` and mesh origins:**
The brief uses 0 as a starting value but notes it should be ">0 if your mesh origin is at feet." Verify the current cube/cone mesh origin convention in M6 code before US-002 — if the mesh origin is centered, offset must be `meshHeight / 2`.

**Q3 — Crosshair removal vs reticle:**
Brief says "REMOVE the crosshair entirely." US-005 follows that. If during US-005 the absence of a center reticle feels disorienting, a fixed dot-reticle is a one-line addition. Decide during US-006 playtest, not in advance.

**Q4 — Damage number altitude:**
`damage_dealt`/`hit` event payloads need to include Y per FR-13. Check whether existing M6 client code positions floating numbers from event payload or from a re-lookup of entity state — if the latter, the events may not need Y, but a Y is still cheap to ship.

**Q5 — Map boundary visual:**
US-003 uses a tall cylinder. Open question: does a single tall cylinder at the boundary radius look cohesive with hills, or does it feel disconnected? May want to revisit in polish pass — but only if it actually grates in playtest.

---

## Appendix: Implementation Order

The story numbering matches the brief's implementation order exactly. Execute in order — out-of-order execution will produce broken intermediate states (e.g., US-007 camera occlusion needs the terrain mesh from US-003).

The two BLOCKING stories (US-006 after camera, US-015 at the end) are gates, not stories that can be deferred or run in parallel.

## Appendix: Verification Checklist (from brief, mapped to acceptance criteria)

| Brief item | Covered by |
|---|---|
| Camera follows player smoothly, no jitter, no clipping | US-005, US-007 |
| WASD camera-relative; W is "into screen" | US-005 |
| Player faces movement direction | US-005 |
| Spacebar jump with full trajectory | US-008 |
| Coyote time | US-008 |
| Jump buffer | US-008 |
| Two-client Y determinism mid-jump | US-009 |
| Enemies follow terrain | US-010 |
| Jump-over-projectile causes miss | US-011 |
| Terrain visible hills + slope shading + flat spawn | US-001, US-003 |
| Props determinism across clients | US-012 |
| Sky color + fog horizon | US-013 |
| 60fps + 20Hz with full load | US-013, US-014 |
| Pointer lock UX (overlay, ESC, click) | US-005 |
| Typecheck + tests pass | every story |
