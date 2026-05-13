# M9 — Player body (Female Blademaster) — design

**Status:** approved (brainstorming)
**Client:** Unity (`Monkey Punch/`). TS web client is deprecated and out of
scope per project memory.
**Source asset:** `Female Blademaster 1/` (Neko Ninja Labs, royalty-free per
bundled LICENSE.txt — credit appreciated, not required).

## Goal

Replace the per-player `PrimitiveType.Cube` (green for local, blue for
remote) with the bundled Female Blademaster rigged character, driven by
locomotion animation, with the sword permanently attached to the right
hand. Apply uniformly to local + remote players.

This is a **client-side-only** milestone: zero server changes, zero schema
changes, zero new wire messages.

## What the asset ships

Verified by parsing the GLB JSON header of `female_blademaster_1.glb`:

- **Skeleton:** 49 joints (humanoid-compatible).
- **Sub-meshes:** 16. Names are uninformative (`Cube`, `Plane.012`, …) —
  visual identification required during prefab authoring to pick the
  outfit/hair combo and disable unused parts. One of these sub-meshes
  may already be the sword; if so, disable it and use the standalone
  sword instead (see Risk #2).
- **Animation clips (24 total = 12 unique × 2 with `_PHY` suffix):**
  - Plain locomotion (no weapon out): `act_idle`, `act_walk_1`,
    `act_walk_2`, `act_run`, `act_sprint`.
  - Weapon-ready locomotion: `idle_weapon_idle`, `idle_weapon_ready`,
    `act_walk_weapon_ready`, `act_run_weapon_ready`,
    `act_sprint_weapon_ready`.
  - Transition: `act_unsheath`.
  - Rig references: `pose_A`, `pose_T`.
- **`_PHY` variants** have wiggle-bone physics (chest, skirt, sleeves,
  cape) baked into the skeleton motion. Using PHY variants means Unity
  gets free cloth/jiggle secondary motion **without** Magica Cloth,
  Dynamic Bone, or a Unity Cloth component.
- **Textures:** 22 in `Textures Female Blademaster 1/` (4 hair variants,
  outfits 1/2 in A/B/C color × 2 layers, plus ALT outfits). M9 picks one
  combo and ignores the rest.
- **Sword:** separate `Fantasy Sword 1/fantasy_sword_1.fbx`, static mesh.

## What is NOT in the asset

No attack swing, no hit-react, no downed/death, no jump, no dodge. These
would need a separate animation source (Mixamo retarget is the obvious
candidate). All are **explicitly deferred** beyond M9.

## Architectural decisions

| Decision | Choice |
|---|---|
| Animation source | Bundled FBX clips only (PHY variants). No external retargets. |
| Scope | Locomotion + weapon-ready idle. No combat animations. |
| Coverage | Local + all remote players (single code path). |
| Outfit | Single fixed default (hair A + outfit 1 color A). Customization deferred. |
| Sword | Permanent right-hand attachment via prefab parenting. |
| Animator FSM | Single layer, one `Locomotion` state containing a 1D BlendTree on `Speed`. |
| Avatar import type | Humanoid (future-proofs for Mixamo retargets later). |
| Unsheath flow | Skipped on spawn. Player starts at `idle_weapon_ready`. |
| Facing direction | Derived client-side from velocity. No schema change. |
| Root motion | Disabled (`Animator.applyRootMotion = false`). Server is authoritative for position. |
| Server / schema / wire | No changes. |

## Architecture

### Asset layout under `Assets/`

```
Art/Characters/FemaleBlademaster/
  female_blademaster_1.fbx           Humanoid avatar; PHY clips extracted as sub-assets
  fantasy_sword_1.fbx                Static mesh, no rig
  Textures/                          One hair_A + one outfit_1_A color set; others ignored for M9
  PlayerCharacter.controller         Animator controller (single BlendTree)
Prefabs/Characters/
  PlayerCharacter.prefab             Rig + sword child of RightHand bone + PlayerAvatar component
```

### New component: `MonkeyPunch.Render.PlayerAvatar`

One instance per spawned player GameObject. Self-contained — no
handoff from `NetworkClient`. Responsibilities:

- Cache `Animator` and the previous-frame `transform.position` on
  `Awake`.
- Each `LateUpdate()`:
  1. Read `transform.position` (which `NetworkClient.Update` has just
     written this frame — see "Ordering" below).
  2. Diff vs. its own stored previous-frame position, divide by
     `Time.deltaTime` → world-space velocity vector.
  3. Compute `speed = horizontalMagnitude(velocity)`.
  4. `animator.SetFloat("Speed", speed, dampTime: 0.1f, Time.deltaTime)` —
     `SetFloat` with damp time smooths state transitions.
  5. Compute target yaw via `atan2(velocity.x, velocity.z)` when
     `speed > epsilon (~0.05 m/s)`. When below epsilon, hold the last
     computed yaw (don't snap to north).
  6. Slerp `transform.rotation` toward target yaw at ~12 rad/s so turns
     are smooth rather than instant.

The same code path handles local and remote players because both read
the post-write `transform.position`. The local-player render path
(predictor + render offset + live-input extrapolation in
`NetworkClient.Update`) and the remote-player snapshot interpolation
both write to `transform.position` before `LateUpdate` fires.

### `NetworkClient` changes (minimal)

- Add `[SerializeField] GameObject playerPrefab;` pointing at
  `PlayerCharacter.prefab`.
- In `HandlePlayerAdd`, replace
  `GameObject.CreatePrimitive(PrimitiveType.Cube)` with
  `Instantiate(playerPrefab)`. The `PlayerAvatar` component on the
  prefab is self-contained — it reads its own `transform.position`
  each `LateUpdate` and needs no Init handoff. The only state it
  needs (whether it's local) can be derived by comparing its
  GameObject reference to `NetworkClient.LocalPlayerTransform`, but
  since the velocity-derivation path is identical for local and
  remote (Section 4 / "Facing & rotation"), `isLocal` is unused at
  runtime and need not be wired.
- Remove the runtime color tint (`rend.material.color = …`).
  Local vs. remote is no longer distinguished by tint — the camera
  follows the local player, so it's identifiable. (Nametags are a
  future milestone.)
- Drop the `PLAYER_VISUAL_HALF_HEIGHT = 0.5f` constant and the
  `+ PLAYER_VISUAL_HALF_HEIGHT` arithmetic in the per-frame position
  writes. The rigged character is feet-pivoted by FBX convention; its
  origin aligns with `player.y` directly. (See Risk #4: smoke-test this.)

### Ordering: `LateUpdate` over execution-order asset

`PlayerAvatar.Update` must run **after** `NetworkClient.Update` so it
sees the post-write position. We achieve this by putting all of
`PlayerAvatar`'s logic in `LateUpdate`, which Unity guarantees to fire
after every `Update`. This is the same pattern `CameraFollow` already
uses (`CameraFollow.LateUpdate` reads `LocalPlayerTransform.position`
written by `NetworkClient.Update`). No `Script Execution Order` asset
needed.

## Animation

### Clips used (3, all PHY variants)

- `idle_weapon_ready_PHY`
- `act_walk_weapon_ready_PHY`
- `act_run_weapon_ready_PHY`

### Animator Controller (`PlayerCharacter.controller`)

- One layer ("Base"), one state ("Locomotion") containing a 1D BlendTree.
- Parameter: `Speed` (float, m/s).
- BlendTree thresholds (placeholder, tuned in the plan):
  - `0.0` → `idle_weapon_ready_PHY`
  - `~2.0` → `act_walk_weapon_ready_PHY`
  - `~5.5` → `act_run_weapon_ready_PHY`
- `Animator.applyRootMotion = false` on the prefab.

### Tuning notes for the implementation plan

- Walk and run thresholds must be tuned against `PredictorConstants.PLAYER_SPEED`
  (game's actual walk speed) and the clip cycle speeds, or feet will
  visibly slide. See Risk #5.
- `damp time = 0.1s` on `SetFloat` is conventional. Increase if the
  blend feels too snappy; decrease if it feels laggy.

## Facing & rotation

| Source | Path |
|---|---|
| Velocity | `transform.position` delta vs. previous frame ÷ `Time.deltaTime`. Single code path for local + remote. |
| Target yaw | `atan2(velocity.x, velocity.z)` when `speed > 0.05 m/s`. |
| Stationary | Hold the last computed yaw. Do not snap. |
| Rotation rate | Slerp toward target at ~12 rad/s. Tunable. |

Rationale: respects CLAUDE.md rule #2 (synced state only if it must
reach clients — heading is derivable from already-synced position).
Matches the Megabonk feel reference (character faces last-movement
direction, locks when stopped, auto-aim weapons fire toward enemies
regardless of facing).

## Networking, schema, and server impact

**Nothing.**

- `packages/server/` — no changes.
- `packages/shared/schema.ts` — no changes.
- `packages/shared/messages.ts` — no changes.
- `packages/shared/rules.ts` — no changes.
- Wire bandwidth per snapshot — unchanged.
- Vitest suites in `server/` and `shared/` — unaffected.
- `Assets/Tests/Editor/PredictorGoldenTest.cs` (bit-identical
  determinism gate from the Unity migration plan) — unaffected.

M9 is a pure client-side rendering swap.

## Risks and mitigations

1. **Humanoid auto-map failure.** If the rig's bone names are
   non-standard, Unity's automatic humanoid configurator may not map
   every required slot. *Mitigation:* plan's first verification step
   is "import FBX, open avatar configurator, confirm humanoid auto-map
   ✓." Fallback: hand-map in the configurator (~5 min) or fall back to
   Generic (closes the door on Mixamo retargets but ships M9).

2. **Double sword.** One of the FBX's 16 unnamed sub-meshes may
   already be the sword (the concept art shows the character holding
   it). *Mitigation:* during prefab authoring, visually identify the
   sword sub-mesh and disable its `SkinnedMeshRenderer`. Use the
   standalone `fantasy_sword_1.fbx` as the right-hand-bone child.

3. **Outfit sub-mesh visibility.** With 16 sub-meshes covering
   multiple hair/outfit variants, the unused ones must be hidden in
   the prefab. *Mitigation:* visual identification during prefab
   authoring; set `enabled = false` on unused `SkinnedMeshRenderer`s.
   This is per-prefab, runtime cost is zero.

4. **Pivot mismatch.** The current code adds `PLAYER_VISUAL_HALF_HEIGHT
   = 0.5f` because Unity primitives are center-pivoted. The rigged
   character is **expected** to be feet-pivoted, so the offset becomes
   zero. *Mitigation:* plan includes a smoke-test step. If the FBX
   exports with a non-zero pivot, restore an appropriate offset (the
   prefab can ship the offset baked into its child transform, so
   `NetworkClient.cs` doesn't need to know about it).

5. **PHY clip footstep slide.** If `act_walk_weapon_ready_PHY` plays
   at a speed that doesn't match `PredictorConstants.PLAYER_SPEED`,
   feet will visibly slide on the ground. *Mitigation:* tune the
   BlendTree thresholds in the plan. If slide is severe at the
   correct threshold, multiply the clip's playback speed by a fixed
   factor in the Animator state's `Speed` field.

## Out of scope (deferrals)

- Attack-swing animation tied to `melee_swipe` / `fire` events.
- Hit-reaction animation tied to `player_damaged` events.
- Downed pose / death animation tied to `player_downed` /
  `run_ended` events. (`CombatVfx` continues to handle these with its
  current overlay treatment.)
- Per-weapon visual swap (axe vs. sword vs. aura device vs. orbs).
  Sword is shown unconditionally in M9.
- Outfit / hair customization UI.
- Random per-session outfit roll.
- `act_unsheath` flow on first weapon pickup.
- Sprint state (asset ships sprint clips, but no game-side sprint
  mechanic exists yet).
- Footstep audio.
- Nametag rendering above each player.
- Animation events correlated with server tick events
  (`fire`/`hit`/`melee_swipe`).
- Refactor to instanced/skinned-mesh-merge optimization for player
  rendering. Per-frame `SkinnedMeshRenderer` cost is acceptable at
  the 10-player ceiling.

## Test plan (M9 verification)

- **Visual smoke test (local play):**
  - Player spawns. Visible as Female Blademaster, sword in right
    hand. Feet on terrain (no sinking / floating).
  - WASD → character moves and rotates to face direction of travel.
  - Release WASD → character stops; rotation holds last facing.
  - No feet slide at full walk/run speeds.
  - PHY cloth motion visible (skirt sways, cape moves) without
    cloth components.

- **Visual smoke test (two-client local):**
  - Open a second client window, join same room.
  - Remote player visible as Female Blademaster (not cube), moves
    smoothly via snapshot interpolation, rotates toward travel
    direction.
  - No visible jitter or facing pops when remote player stops.

- **Regression checks:**
  - Camera follow / mouselook unchanged (CameraFollow keys off
    `NetworkClient.LocalPlayerTransform`, which is still the
    instantiated GameObject's transform).
  - Predictor reconcile error stays within the same envelope as
    pre-M9 (the predictor doesn't change).
  - `Assets/Tests/Editor/PredictorGoldenTest.cs` still passes.
  - CombatVfx flashes (`player_damaged`, `hit`, etc.) still appear
    on the character — they look up the player GameObject by
    sessionId, which doesn't change.
  - GameUI HP/XP/level-up bar unaffected.

- **Performance sanity:**
  - With 10 connected players + ~30 enemies + active combat, frame
    time stays under 16ms on the dev machine. If not, profile;
    `SkinnedMeshRenderer` merge is the most likely lever.

## References

- `Monkey Punch/Assets/Scripts/Net/NetworkClient.cs` — current cube
  spawn site (`HandlePlayerAdd`); the one-line prefab swap lives here.
- `Monkey Punch/Assets/Scripts/Net/LocalPredictor.cs` — owns local
  X/Z; unchanged by M9.
- `Monkey Punch/Assets/Scripts/Render/CameraFollow.cs` — uses the
  same `LateUpdate`-after-`Update` ordering pattern we adopt for
  `PlayerAvatar`.
- `CLAUDE.md` rules #1 (server-authoritative), #2 (synced state in
  schema only), #11 (tick order — untouched).
- Project memory: `project-unity-only-client`,
  `project-megabonk-reference`.
- License: `Female Blademaster 1/LICENSE.txt` — commercial use
  allowed; redistribution as asset prohibited.
