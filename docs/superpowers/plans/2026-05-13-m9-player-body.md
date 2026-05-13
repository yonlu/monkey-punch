# M9 Player Body (Female Blademaster) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-player `PrimitiveType.Cube` in the Unity client with the rigged Female Blademaster character driven by bundled FBX locomotion clips, with the sword permanently attached to the right hand and uniform behavior for local + remote players.

**Architecture:** Pure client-side rendering swap. A self-contained `PlayerAvatar` MonoBehaviour reads its own post-write `transform.position` each `LateUpdate`, derives velocity → speed + facing, drives a 1D-BlendTree Animator and slerps rotation. Server, schema, and wire messages are untouched. PHY-baked wiggle-bone motion gives free cloth/jiggle without any Unity cloth component.

**Tech Stack:** Unity 6000.4.6f1, URP, Humanoid Avatar, Animator Controller with 1D BlendTree, NUnit (Edit Mode test framework), C# 9.

**Source spec:** `docs/superpowers/specs/2026-05-13-m9-player-body-design.md` (commit `b68a4bc`).

---

## File Map

**Create:**
- `Monkey Punch/Assets/Art/Characters/FemaleBlademaster/female_blademaster_1.fbx` (asset move + import)
- `Monkey Punch/Assets/Art/Characters/FemaleBlademaster/fantasy_sword_1.fbx` (asset move + import)
- `Monkey Punch/Assets/Art/Characters/FemaleBlademaster/Textures/` (3 PNG files: hair_A, outfit_1_A1, outfit_1_A2)
- `Monkey Punch/Assets/Animators/PlayerCharacter.controller`
- `Monkey Punch/Assets/Prefabs/Characters/PlayerCharacter.prefab`
- `Monkey Punch/Assets/Scripts/Render/LocomotionParams.cs` (pure static math helpers — unit-testable)
- `Monkey Punch/Assets/Scripts/Render/PlayerAvatar.cs` (MonoBehaviour)
- `Monkey Punch/Assets/Tests/Editor/LocomotionParamsTest.cs` (NUnit Edit Mode)

**Modify:**
- `Monkey Punch/Assets/Scripts/Net/NetworkClient.cs:565-619` (`HandlePlayerAdd` + `HandlePlayerRemove` + per-frame position write in `Update`); also drop the `PLAYER_VISUAL_HALF_HEIGHT` constant and the cube tinting.

**Delete (post-verification, optional):**
- `Female Blademaster 1.zip` and the leftover `Female Blademaster 1/` source tree in the repo root, once everything imports cleanly inside Unity. (Optional — see Task 11.)

---

## Important: this project is not TDD-friendly across the whole milestone

Most of M9 is **Unity Editor configuration** (FBX import settings, sub-mesh disabling, Animator controller layout, prefab authoring). None of that is TDD-able from C#. The only piece that **is** unit-testable is the pure math in `LocomotionParams` — that's covered by an Edit Mode test in Task 4. Everything else has explicit verification steps in the Editor and visual smoke tests at the end.

When a step says "verify in Editor," that means: open the Unity Editor, navigate to the asset/component the step refers to, and confirm the expected state with your eyes. No assertion harness exists for "the avatar is humanoid" or "the BlendTree has three motion fields."

---

### Task 1: Stage source assets into the Unity project

**Files:**
- Create: `Monkey Punch/Assets/Art/Characters/FemaleBlademaster/female_blademaster_1.fbx` (copy of repo-root file)
- Create: `Monkey Punch/Assets/Art/Characters/FemaleBlademaster/fantasy_sword_1.fbx` (copy of `Female Blademaster 1/Fantasy Sword 1/fantasy_sword_1.fbx`)
- Create: `Monkey Punch/Assets/Art/Characters/FemaleBlademaster/Textures/TEX_female_blademaster_1_hair_A.png`
- Create: `Monkey Punch/Assets/Art/Characters/FemaleBlademaster/Textures/TEX_female_blademaster_1_outfit_1_A1.png`
- Create: `Monkey Punch/Assets/Art/Characters/FemaleBlademaster/Textures/TEX_female_blademaster_1_outfit_1_A2.png`

- [ ] **Step 1: Create the target folders**

```bash
mkdir -p "Monkey Punch/Assets/Art/Characters/FemaleBlademaster/Textures"
```

- [ ] **Step 2: Copy the FBX, sword FBX, and the 3 textures we will actually use**

```bash
cp "Female Blademaster 1/female_blademaster_1.fbx" \
   "Monkey Punch/Assets/Art/Characters/FemaleBlademaster/female_blademaster_1.fbx"

cp "Female Blademaster 1/Fantasy Sword 1/fantasy_sword_1.fbx" \
   "Monkey Punch/Assets/Art/Characters/FemaleBlademaster/fantasy_sword_1.fbx"

cp "Female Blademaster 1/Textures Female Blademaster 1/TEX_female_blademaster_1_hair_A.png" \
   "Monkey Punch/Assets/Art/Characters/FemaleBlademaster/Textures/"

cp "Female Blademaster 1/Textures Female Blademaster 1/TEX_female_blademaster_1_outfit_1_A1.png" \
   "Monkey Punch/Assets/Art/Characters/FemaleBlademaster/Textures/"

cp "Female Blademaster 1/Textures Female Blademaster 1/TEX_female_blademaster_1_outfit_1_A2.png" \
   "Monkey Punch/Assets/Art/Characters/FemaleBlademaster/Textures/"
```

Note: we copy (not move) so the source tree is left intact in case the import needs to be redone. Cleanup is the final Task 11.

- [ ] **Step 3: Trigger Unity to import the new assets**

Switch focus to Unity. The Editor will auto-detect the new files on focus and start an Asset Import. Wait for the bottom-right "Hold on" / progress bar to disappear. If you have UnityMCP available you can instead run `mcp__UnityMCP__manage_asset(action="import", path="Art/Characters/FemaleBlademaster")` (paths are relative to Assets).

- [ ] **Step 4: Verify imports succeeded**

Open the Project window and navigate to `Art/Characters/FemaleBlademaster/`. You should see:
- `female_blademaster_1` (FBX with a small triangle disclosure showing nested mesh + clips + materials).
- `fantasy_sword_1` (FBX, no skeleton).
- `Textures/` containing the 3 PNGs.

If anything is missing or shows an import error, check Unity's Console window and resolve before continuing.

- [ ] **Step 5: Commit**

```bash
git add "Monkey Punch/Assets/Art/Characters/FemaleBlademaster"
git commit -m "feat(m9): stage Female Blademaster source assets

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Configure the FBX import as Humanoid

**Files:**
- Modify: `Monkey Punch/Assets/Art/Characters/FemaleBlademaster/female_blademaster_1.fbx` (import settings only — `.meta` file changes; the FBX itself is untouched)

- [ ] **Step 1: Open the FBX importer Inspector**

In the Project window, click `female_blademaster_1.fbx`. The Inspector shows tabs: `Model`, `Rig`, `Animation`, `Materials`.

- [ ] **Step 2: Set the rig to Humanoid**

Go to the **Rig** tab. Set:
- **Animation Type**: `Humanoid`
- **Avatar Definition**: `Create From This Model`
- **Skin Weights**: leave at default (Standard, 4 bones)

Click **Apply** at the bottom of the Inspector. Unity will run the humanoid auto-mapper.

- [ ] **Step 3: Verify the humanoid mapping succeeded**

After Apply finishes, the **Configure...** button next to Avatar Definition becomes clickable. Click it to enter the Avatar configurator.

Expected: all required bones (head, neck, spine, chest, upper arms, lower arms, hands, upper legs, lower legs, feet) appear with green dots. Optional bones (toes, fingers) may be unassigned — that's fine.

If any **required** bone is red or missing, the auto-mapper failed on this rig. **Fallback path:** hand-map the missing bone in the configurator (click the empty slot, drag the matching bone from the hierarchy on the left), then click **Done**. If hand-mapping is unworkable, fall back to **Generic** on the Rig tab — we lose Mixamo-retarget compatibility but ship M9. Document any fallback in the commit message.

Click **Done** at the bottom-right to exit the configurator (clicks **Apply** automatically if there were unsaved changes).

- [ ] **Step 4: Set the Animation tab options**

Go to the **Animation** tab on the same FBX importer Inspector. Set:
- **Import Animation**: ✓ checked
- **Bake Animations**: leave at default (off; only applies to constraint baking)

Scroll down to the **Clips** list. You should see 24 entries (12 unique × 2 with `_PHY` suffix), already extracted from the FBX.

For **each** of these three clips, click the row and tick `Loop Time` ✓ on the right pane:
- `idle_weapon_ready_PHY`
- `act_walk_weapon_ready_PHY`
- `act_run_weapon_ready_PHY`

Leave the others alone — they're unused but harmless.

Click **Apply**.

- [ ] **Step 5: Verify each clip plays cleanly in the Animation preview**

For each of the three clips listed above, click it in the Clips list and use the preview window at the bottom of the Inspector (you may need to drag a Female Blademaster instance into the preview). Scrub the timeline. Confirm: skirt and cape visibly sway (proves PHY motion is baked in). No T-pose snap at clip boundaries.

- [ ] **Step 6: Commit**

```bash
git add "Monkey Punch/Assets/Art/Characters/FemaleBlademaster/female_blademaster_1.fbx.meta"
git commit -m "feat(m9): configure Female Blademaster FBX as Humanoid + extract PHY clips

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Identify sword sub-mesh and unused outfit/hair sub-meshes

**Files:**
- This task identifies state; no file changes. The disabling happens during prefab authoring in Task 7.

- [ ] **Step 1: Drag the FBX into the active scene**

Drag `Assets/Art/Characters/FemaleBlademaster/female_blademaster_1` from the Project window into the `SampleScene` Hierarchy. A character GameObject appears at world origin.

- [ ] **Step 2: Inspect the SkinnedMeshRenderer children**

In the Hierarchy, expand the character's child structure. Find each child that has a `SkinnedMeshRenderer` component. There should be ~16 of them (one per sub-mesh: hair variants, outfit variants, body parts).

- [ ] **Step 3: Identify the sword sub-mesh (if present in the character FBX)**

For each SkinnedMeshRenderer child, click it in the Hierarchy and look at the Scene view. Cycle through them. If you see a sword-shaped mesh appear/disappear when one of them is toggled with the Inspector's `enabled` checkbox: **note its child name** — you'll disable this in Task 7. If no sub-mesh looks like a sword, the character FBX doesn't include sword geometry and we'll use only the standalone `fantasy_sword_1` model.

- [ ] **Step 4: Identify the keep-set sub-meshes**

Toggle each remaining SkinnedMeshRenderer off in turn. Identify visually:
- The single **hair_A** mesh (matches the `TEX_female_blademaster_1_hair_A` texture's silhouette).
- The body / head / face / hands meshes (always keep).
- The **outfit_1** mesh(es) — the base outfit (matches `TEX_female_blademaster_1_outfit_1_A*` texture's silhouette).

Write down the child name of every SkinnedMeshRenderer and label each as `KEEP` or `DISABLE` in a scratch note. Concrete output for this step: a 16-line list, e.g.:
```
GameObject_Body          KEEP
GameObject_Head          KEEP
GameObject_Hair_A        KEEP
GameObject_Hair_B        DISABLE
GameObject_Outfit_1      KEEP
GameObject_Outfit_2      DISABLE
...
GameObject_Sword         DISABLE   (if present)
```

- [ ] **Step 5: Delete the test instance from the scene**

In the Hierarchy, right-click the character GameObject you dragged in and select **Delete**. We were using it as a scratch instance — the real instance ships as a prefab built in Task 7.

- [ ] **Step 6: No commit needed**

This task produces no file changes — just notes you'll feed into Task 7.

---

### Task 4: TDD — `LocomotionParams` pure helpers + Edit Mode tests

**Files:**
- Create: `Monkey Punch/Assets/Scripts/Render/LocomotionParams.cs`
- Test: `Monkey Punch/Assets/Tests/Editor/LocomotionParamsTest.cs`

This is the only TDD-able piece of M9. The pure-math helpers compute speed and target yaw from a velocity vector; `PlayerAvatar` consumes them in Task 5.

- [ ] **Step 1: Write the failing tests**

Create `Monkey Punch/Assets/Tests/Editor/LocomotionParamsTest.cs` with this content:

```csharp
using NUnit.Framework;
using UnityEngine;
using MonkeyPunch.Render;

namespace MonkeyPunch.Tests.Editor {
  public class LocomotionParamsTest {
    [Test]
    public void ComputeSpeed_ZeroVelocity_ReturnsZero() {
      Assert.AreEqual(0f, LocomotionParams.ComputeSpeed(Vector3.zero), 1e-6f);
    }

    [Test]
    public void ComputeSpeed_HorizontalOnly_ReturnsMagnitude() {
      // (3, 0, 4) → 5 (classic 3-4-5 triangle on XZ).
      Assert.AreEqual(5f, LocomotionParams.ComputeSpeed(new Vector3(3f, 0f, 4f)), 1e-6f);
    }

    [Test]
    public void ComputeSpeed_IgnoresVerticalComponent() {
      // Vertical velocity (jump / gravity) must not affect locomotion speed.
      // (3, 100, 4) still returns 5.
      Assert.AreEqual(5f, LocomotionParams.ComputeSpeed(new Vector3(3f, 100f, 4f)), 1e-6f);
    }

    [Test]
    public void TryComputeTargetYaw_BelowEpsilon_ReturnsFalse() {
      // 0.01 m/s is below SPEED_EPSILON (0.05). Should return false so the
      // caller knows to hold the previous yaw rather than snap.
      bool ok = LocomotionParams.TryComputeTargetYaw(new Vector3(0.01f, 0f, 0f), out _);
      Assert.IsFalse(ok);
    }

    [Test]
    public void TryComputeTargetYaw_MovingPositiveZ_ReturnsZeroYaw() {
      // Heading toward world +Z is yaw 0 (atan2(0, +z) = 0). This is the
      // identity facing in Unity's left-handed Y-up convention.
      bool ok = LocomotionParams.TryComputeTargetYaw(new Vector3(0f, 0f, 5f), out float yaw);
      Assert.IsTrue(ok);
      Assert.AreEqual(0f, yaw, 1e-6f);
    }

    [Test]
    public void TryComputeTargetYaw_MovingPositiveX_ReturnsPiOverTwo() {
      // Heading toward world +X. atan2(+x, 0) = π/2.
      bool ok = LocomotionParams.TryComputeTargetYaw(new Vector3(5f, 0f, 0f), out float yaw);
      Assert.IsTrue(ok);
      Assert.AreEqual(Mathf.PI / 2f, yaw, 1e-6f);
    }

    [Test]
    public void TryComputeTargetYaw_MovingNegativeZ_ReturnsPi() {
      // Heading toward world -Z (a 180° turn).
      // atan2(0, -z) could return π or -π by the principal-value cut;
      // Unity's Mathf.Atan2(0, -5) returns π. We assert exact match.
      bool ok = LocomotionParams.TryComputeTargetYaw(new Vector3(0f, 0f, -5f), out float yaw);
      Assert.IsTrue(ok);
      Assert.AreEqual(Mathf.PI, yaw, 1e-6f);
    }

    [Test]
    public void TryComputeTargetYaw_IgnoresVerticalVelocity() {
      // (0, 100, 5) — vertical doesn't influence yaw.
      bool ok = LocomotionParams.TryComputeTargetYaw(new Vector3(0f, 100f, 5f), out float yaw);
      Assert.IsTrue(ok);
      Assert.AreEqual(0f, yaw, 1e-6f);
    }
  }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Open Unity's **Test Runner** window (`Window → General → Test Runner`). Select the **EditMode** tab. The test runner should list `LocomotionParamsTest` with 8 entries. Click **Run All**.

Expected: all 8 fail with `CS0103: The name 'LocomotionParams' does not exist` or similar (the class doesn't exist yet).

Alternatively from a shell, you can use Unity's command-line test runner — but the Editor's Test Runner window is simpler and the project doesn't have CLI test scripts wired up.

- [ ] **Step 3: Write the minimal implementation**

Create `Monkey Punch/Assets/Scripts/Render/LocomotionParams.cs`:

```csharp
using UnityEngine;

namespace MonkeyPunch.Render {
  // Pure math helpers used by PlayerAvatar to translate world-space
  // velocity into Animator parameters and facing rotation. Extracted
  // into a static class so the math is unit-testable without Unity's
  // runtime lifecycle.
  //
  // Tuning constants live here too — co-locating them with the math
  // keeps "what value, why" in one place.
  public static class LocomotionParams {
    // Below this horizontal speed (m/s) we treat the character as
    // stationary: TryComputeTargetYaw returns false so the caller holds
    // the previous yaw rather than snapping. 0.05 m/s is well below
    // PLAYER_SPEED (~5 m/s) and above per-frame jitter from snapshot
    // interpolation, so a player standing still does not visibly spin.
    public const float SPEED_EPSILON = 0.05f;

    // Per-second slerp rate for transform rotation toward target yaw.
    // Tuned for Megabonk-style "snaps toward direction of travel"
    // without feeling instant. Plan task 9 may revisit during smoke
    // testing.
    public const float YAW_SLERP_RATE = 12f;

    // Damp time passed to Animator.SetFloat. 0.1s is the conventional
    // Unity default and produces smooth blending between idle/walk/run
    // without visible lag.
    public const float SPEED_DAMP_TIME = 0.1f;

    /// <summary>
    /// Horizontal-plane magnitude of the velocity vector. Vertical
    /// component (jumping / gravity) is intentionally ignored —
    /// locomotion clips are XZ-plane animations.
    /// </summary>
    public static float ComputeSpeed(Vector3 velocity) {
      return new Vector2(velocity.x, velocity.z).magnitude;
    }

    /// <summary>
    /// Yaw angle (radians) the character should face when moving along
    /// `velocity`. Returns false if the horizontal speed is below
    /// SPEED_EPSILON, indicating the caller should hold its previous
    /// yaw rather than snap. Yaw convention: atan2(x, z), so 0 = +Z,
    /// +π/2 = +X (matches Unity's left-handed Y-up world).
    /// </summary>
    public static bool TryComputeTargetYaw(Vector3 velocity, out float yaw) {
      float speed = ComputeSpeed(velocity);
      if (speed < SPEED_EPSILON) {
        yaw = 0f;
        return false;
      }
      yaw = Mathf.Atan2(velocity.x, velocity.z);
      return true;
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

In the Test Runner window, click **Run All** again. Expected: all 8 tests green.

If anything fails, fix the implementation — the test is the spec.

- [ ] **Step 5: Commit**

```bash
git add "Monkey Punch/Assets/Scripts/Render/LocomotionParams.cs" \
        "Monkey Punch/Assets/Tests/Editor/LocomotionParamsTest.cs"
git commit -m "feat(m9): LocomotionParams pure helpers + Edit Mode tests

Speed = horizontal magnitude; TryComputeTargetYaw returns false below
SPEED_EPSILON (0.05 m/s) so the caller can hold the previous yaw.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Implement `PlayerAvatar` MonoBehaviour

**Files:**
- Create: `Monkey Punch/Assets/Scripts/Render/PlayerAvatar.cs`

- [ ] **Step 1: Write the component**

Create `Monkey Punch/Assets/Scripts/Render/PlayerAvatar.cs`:

```csharp
using UnityEngine;

namespace MonkeyPunch.Render {
  // M9: self-contained avatar driver. One per spawned Player GameObject.
  //
  // Each LateUpdate it reads its own transform.position (which
  // NetworkClient.Update has just written this frame — either via
  // predictor + extrapolation for the local player, or via
  // SnapshotBuffer interpolation for remotes) and diffs against the
  // previous frame to derive world-space velocity. Velocity feeds:
  //   - Animator "Speed" parameter (drives the 1D BlendTree).
  //   - Target yaw, slerped into transform.rotation.
  //
  // The two-path local-vs-remote velocity question is collapsed by
  // reading the post-write transform: it's the same code regardless of
  // whether the source upstream is predictor or snapshot buffer. See
  // M9 design doc §"Facing & velocity computation".
  //
  // Ordering: LateUpdate is guaranteed to run after every Update, so
  // NetworkClient.Update's position write is always visible here. Same
  // pattern CameraFollow already uses.
  [RequireComponent(typeof(Animator))]
  public class PlayerAvatar : MonoBehaviour {
    // Hash lookups are faster than string parameter names; cache once.
    private static readonly int SpeedParamHash = Animator.StringToHash("Speed");

    private Animator animator;
    private Vector3 previousPosition;
    private bool hasPreviousPosition;
    private float heldYaw; // Last computed yaw, held while stationary.

    void Awake() {
      animator = GetComponent<Animator>();
      // Server is authoritative for position; the animator must not
      // move the root transform.
      animator.applyRootMotion = false;
      heldYaw = transform.eulerAngles.y * Mathf.Deg2Rad;
    }

    void LateUpdate() {
      Vector3 current = transform.position;
      float dt = Time.deltaTime;

      // First frame after spawn: no previous sample to diff against.
      // Initialize and bail; next frame produces a valid velocity.
      if (!hasPreviousPosition || dt <= 0f) {
        previousPosition = current;
        hasPreviousPosition = true;
        return;
      }

      Vector3 velocity = (current - previousPosition) / dt;
      previousPosition = current;

      float speed = LocomotionParams.ComputeSpeed(velocity);
      animator.SetFloat(SpeedParamHash, speed, LocomotionParams.SPEED_DAMP_TIME, dt);

      if (LocomotionParams.TryComputeTargetYaw(velocity, out float targetYaw)) {
        heldYaw = targetYaw;
      }
      // Slerp the actual rotation toward heldYaw at YAW_SLERP_RATE per
      // second. Quaternion.Slerp with t in [0,1] — use 1 - exp(-rate*dt)
      // for frame-rate-independent easing (same pattern as CameraFollow's
      // followRate).
      float t = 1f - Mathf.Exp(-LocomotionParams.YAW_SLERP_RATE * dt);
      Quaternion targetRot = Quaternion.Euler(0f, heldYaw * Mathf.Rad2Deg, 0f);
      transform.rotation = Quaternion.Slerp(transform.rotation, targetRot, t);
    }
  }
}
```

- [ ] **Step 2: Verify the script compiles**

Save the file. Switch focus to Unity. Wait for the compile spinner to finish (bottom-right). Open the Console (`Window → General → Console`). Expected: no red errors mentioning `PlayerAvatar`.

If you have UnityMCP, you can also run `mcp__UnityMCP__read_console` after a focus-switch to confirm.

- [ ] **Step 3: Commit**

```bash
git add "Monkey Punch/Assets/Scripts/Render/PlayerAvatar.cs"
git commit -m "feat(m9): PlayerAvatar MonoBehaviour drives Animator + rotation from velocity

Reads post-write transform.position each LateUpdate so the same code
path handles local-predicted and remote-interpolated players. Holds
last yaw while stationary; slerps rotation at YAW_SLERP_RATE.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Author the Animator Controller (1D BlendTree)

**Files:**
- Create: `Monkey Punch/Assets/Animators/PlayerCharacter.controller`

- [ ] **Step 1: Create the Animators folder and the Controller asset**

In the Project window, right-click `Assets/`. **Create → Folder → "Animators"**. Then inside `Animators/`, right-click → **Create → Animator Controller** → name it `PlayerCharacter`.

- [ ] **Step 2: Open the Animator window for this controller**

Double-click `PlayerCharacter.controller`. The Animator window opens, showing the empty Base Layer with the default `Entry`, `AnyState`, and `Exit` nodes.

- [ ] **Step 3: Add the `Speed` parameter**

In the Animator window's left pane, click the **Parameters** tab. Click `+` → **Float** → name it `Speed` (capital S). Default value `0`.

- [ ] **Step 4: Add a single Locomotion state with a BlendTree**

Right-click in the Animator's empty graph area → **Create State → From New Blend Tree**. A new state named `Blend Tree` appears, set as the default state (orange arrow from Entry).

Rename the state to `Locomotion` (single-click → F2 or the Inspector).

- [ ] **Step 5: Configure the BlendTree**

Double-click the `Locomotion` state to drill into the BlendTree. In the Inspector:
- **Blend Type**: `1D`
- **Parameter**: `Speed`
- Click the `+` on the **Motion** list **three times** to add three motion fields.

Drag-and-drop from the Project window into each Motion slot, in order:
1. `idle_weapon_ready_PHY` (from inside the FBX's nested clips — expand `female_blademaster_1.fbx` in the Project window)
2. `act_walk_weapon_ready_PHY`
3. `act_run_weapon_ready_PHY`

Set the **Threshold** column for each:
- `idle_weapon_ready_PHY` → `0.0`
- `act_walk_weapon_ready_PHY` → `2.0`
- `act_run_weapon_ready_PHY` → `5.5`

These are placeholders; Task 9 retunes them against `PredictorConstants.PLAYER_SPEED`.

- [ ] **Step 6: Verify the BlendTree previews correctly**

In the Inspector, scrub the `Speed` parameter slider at the top of the BlendTree preview from 0 → 5.5. Expected: the preview character blends smoothly from idle to walk to run.

If the preview is empty / shows a flat stick figure, check that the three motion fields are populated and that they're the **PHY** variants from the right FBX.

- [ ] **Step 7: Commit**

```bash
git add "Monkey Punch/Assets/Animators"
git commit -m "feat(m9): PlayerCharacter Animator controller (1D BlendTree on Speed)

Three motion fields: idle/walk/run weapon_ready_PHY clips at speed
thresholds 0, 2.0, 5.5. Thresholds will be tuned in smoke testing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Author the `PlayerCharacter.prefab`

**Files:**
- Create: `Monkey Punch/Assets/Prefabs/Characters/PlayerCharacter.prefab`

This is the heaviest manual-Editor task. Work through it carefully and verify the result before committing.

- [ ] **Step 1: Create the Prefabs folder structure**

Right-click `Assets/` → **Create → Folder → "Prefabs"**. Inside `Prefabs/`, create another folder `Characters/`.

- [ ] **Step 2: Drag the FBX into the SampleScene**

Drag `Assets/Art/Characters/FemaleBlademaster/female_blademaster_1` from the Project window into the SampleScene Hierarchy. Position at (0, 0, 0). Rename the root GameObject to `PlayerCharacter`.

- [ ] **Step 3: Wire the Animator controller to the root**

Click `PlayerCharacter` in the Hierarchy. In the Inspector, find the `Animator` component (added automatically because the FBX is humanoid). Drag `Assets/Animators/PlayerCharacter.controller` into the **Controller** slot.

`Apply Root Motion` should be unchecked. (Our `PlayerAvatar.Awake()` also disables it programmatically, but setting it in the prefab too is correct.)

- [ ] **Step 4: Add the `PlayerAvatar` component**

With `PlayerCharacter` selected, click **Add Component** in the Inspector. Type `Player Avatar` and select it. The component appears below the Animator. No fields to configure.

- [ ] **Step 5: Disable unused outfit/hair sub-meshes per Task 3's list**

For each SkinnedMeshRenderer child you tagged `DISABLE` in Task 3, click it in the Hierarchy and **uncheck the component's checkbox** at the top-left of the SkinnedMeshRenderer Inspector. This hides the renderer without removing the GameObject (cheaper than deletion and easier to undo).

Verify in the Scene view: the character now shows only the body + head + hair_A + outfit_1 + face textures. No alternate hair / alternate outfit / stray prop should be visible.

If the FBX includes an in-rig sword sub-mesh and you tagged it `DISABLE`, leave it disabled — we use the standalone sword from the next step.

- [ ] **Step 6: Parent the sword to the right-hand bone**

Drag `Assets/Art/Characters/FemaleBlademaster/fantasy_sword_1` from the Project window into the Hierarchy as a child of `PlayerCharacter`. The sword appears, likely at the wrong position.

In the Hierarchy, expand `PlayerCharacter` until you find the right-hand bone. Typical humanoid hierarchy: `PlayerCharacter → Armature → Hips → Spine → Chest → UpperChest → RightShoulder → RightUpperArm → RightLowerArm → RightHand`. The exact names depend on the FBX; if your rig uses a different convention (e.g. `mixamorig:RightHand`), look for the right-hand-side hand bone.

Drag the sword GameObject in the Hierarchy to make it a **child of the right-hand bone** (not of `PlayerCharacter` directly).

- [ ] **Step 7: Position and rotate the sword in the hand**

The sword's local position relative to the right-hand bone determines how it sits in the grip. With the sword selected:
- Reset its local position: Inspector → Transform → right-click `Position` → **Reset**. The sword should now be at the hand bone's origin.
- Set local rotation to align the blade with the hand's forward direction. There's no single magic number here — eyeball it. Common starting values: `(0, 90, 0)` or `(0, 0, 90)` Euler angles. Tweak until the sword looks like the character is gripping it (compare against `Female Blademaster 1/Concept Art/1concept_f_blademaster1.png` for reference).

Enter Play mode briefly to confirm the sword tracks the hand during `idle_weapon_ready_PHY` motion. Exit Play mode. Refine the rotation/offset as needed.

- [ ] **Step 8: Save as a Prefab**

Drag `PlayerCharacter` from the Hierarchy into `Assets/Prefabs/Characters/`. Unity creates `PlayerCharacter.prefab`. The Hierarchy entry turns blue.

- [ ] **Step 9: Delete the scene instance**

In the Hierarchy, right-click `PlayerCharacter` and **Delete**. We've saved the prefab; we'll instantiate it from code in Task 8.

- [ ] **Step 10: Commit**

```bash
git add "Monkey Punch/Assets/Prefabs"
git commit -m "feat(m9): PlayerCharacter prefab with sword parented to right hand

Single hair_A + outfit_1_A combo; unused sub-meshes disabled.
PlayerAvatar component attached; Animator wired to
PlayerCharacter.controller; root motion off.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Wire the prefab into `NetworkClient`; drop primitive cube + visual half-height

**Files:**
- Modify: `Monkey Punch/Assets/Scripts/Net/NetworkClient.cs`

- [ ] **Step 1: Add the `playerPrefab` SerializeField**

In `NetworkClient.cs`, find the `[Header("Render")]` section near the top of the class (around line 36) and add the prefab field right under it:

Old:
```csharp
    [Header("Render")]
    [SerializeField] private float interpDelayMs = 100f;
```

New:
```csharp
    [Header("Render")]
    [SerializeField] private float interpDelayMs = 100f;
    [Tooltip("Prefab instantiated for each player (local + remote). Drag PlayerCharacter.prefab here.")]
    [SerializeField] private GameObject playerPrefab;
```

- [ ] **Step 2: Replace the primitive-cube spawn in `HandlePlayerAdd`**

Locate `HandlePlayerAdd` around line 565. Find this block:

```csharp
      bool isLocal = room != null && sessionId == room.SessionId;
      var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
      go.name = $"Player:{sessionId}:{p.name}{(isLocal ? " [LOCAL]" : "")}";
      go.transform.position = new Vector3(p.x, p.y + PLAYER_VISUAL_HALF_HEIGHT, p.z);
      var rend = go.GetComponent<Renderer>();
      if (rend != null) {
        rend.material.color = isLocal
          ? new Color(0.3f, 1.0f, 0.3f)   // green = local (you)
          : new Color(0.3f, 0.5f, 1.0f);  // blue = remote
      }
      playerObjects[sessionId] = go;
```

Replace it with:

```csharp
      bool isLocal = room != null && sessionId == room.SessionId;
      if (playerPrefab == null) {
        Debug.LogError("[NetworkClient] playerPrefab is not assigned in the Inspector. " +
                       "Assign Assets/Prefabs/Characters/PlayerCharacter.prefab.");
        return;
      }
      var go = Instantiate(playerPrefab);
      go.name = $"Player:{sessionId}:{p.name}{(isLocal ? " [LOCAL]" : "")}";
      go.transform.position = new Vector3(p.x, p.y, p.z);
      playerObjects[sessionId] = go;
```

Note three changes:
- `CreatePrimitive(Cube)` → `Instantiate(playerPrefab)`.
- `p.y + PLAYER_VISUAL_HALF_HEIGHT` → `p.y` (rigged character is feet-pivoted by FBX convention).
- Color tinting removed. The local player is identifiable because the camera follows them.

- [ ] **Step 3: Drop the `+ PLAYER_VISUAL_HALF_HEIGHT` arithmetic from the per-frame position writes**

Locate the per-frame player position update in `Update()` around line 800 inside the `foreach (var kv in playerObjects)` block. Find:

```csharp
          kv.Value.transform.position = new Vector3(
            (float)(predictor.X + predictor.RenderOffsetX + extrapX),
            renderY + PLAYER_VISUAL_HALF_HEIGHT,
            (float)(predictor.Z + predictor.RenderOffsetZ + extrapZ)
          );
```

Change to:

```csharp
          kv.Value.transform.position = new Vector3(
            (float)(predictor.X + predictor.RenderOffsetX + extrapX),
            renderY,
            (float)(predictor.Z + predictor.RenderOffsetZ + extrapZ)
          );
```

And a few lines below, find the remote-player branch:

```csharp
        if (playerBuffers.TryGetValue(kv.Key, out var buf) && buf.Sample(renderTime, out var pos)) {
          pos.y += PLAYER_VISUAL_HALF_HEIGHT;
          kv.Value.transform.position = pos;
        }
```

Change to:

```csharp
        if (playerBuffers.TryGetValue(kv.Key, out var buf) && buf.Sample(renderTime, out var pos)) {
          kv.Value.transform.position = pos;
        }
```

(Enemies still use `ENEMY_VISUAL_HALF_HEIGHT` because they're still primitive cubes — leave that block alone.)

- [ ] **Step 4: Remove the now-unused `PLAYER_VISUAL_HALF_HEIGHT` constant and its docstring**

Locate around line 233:

```csharp
    private const float PLAYER_VISUAL_HALF_HEIGHT = 0.5f;
    private const float ENEMY_VISUAL_HALF_HEIGHT = 0.45f;
```

…and the multi-line comment immediately above explaining both constants. Update the comment to only reference enemy half-height, and delete the player line. The result:

```csharp
    // Visual half-heights. The server reports enemy.y as the entity's
    // BASE position (feet on terrain) — ENEMY_GROUND_OFFSET is 0 in
    // shared/constants.ts. Unity's PrimitiveType.Cube has its origin at
    // the CENTER, so positioning an enemy GameObject at e.y directly
    // would sink half the cube below the terrain mesh. Add this to the
    // rendered Y to lift the cube's base onto the terrain. Update if
    // the enemy mesh scale changes.
    //   ENEMY cube: localScale uniform 0.9 (see HandleEnemyAdd) → 0.45
    //
    // (PlayerCharacter prefab is feet-pivoted by FBX convention; no
    // player-side offset is needed.)
    private const float ENEMY_VISUAL_HALF_HEIGHT = 0.45f;
```

- [ ] **Step 5: Verify compile**

Save the file. Switch focus to Unity, wait for compile, check Console. Expected: no errors.

- [ ] **Step 6: Assign the prefab in the Inspector**

In Unity, locate the GameObject that has the `NetworkClient` component (likely a top-level object in `SampleScene` — `NetworkClient` or `GameRoot` or similar). Select it. In the Inspector, find the new **Player Prefab** field. Drag `Assets/Prefabs/Characters/PlayerCharacter.prefab` into it.

Save the scene (`Ctrl+S`).

- [ ] **Step 7: Commit**

```bash
git add "Monkey Punch/Assets/Scripts/Net/NetworkClient.cs" \
        "Monkey Punch/Assets/Scenes/SampleScene.unity"
git commit -m "feat(m9): NetworkClient spawns PlayerCharacter prefab instead of cubes

Drops PLAYER_VISUAL_HALF_HEIGHT offset (rigged character is
feet-pivoted) and the green/blue tint (camera identifies the local
player).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Single-client smoke test + threshold tuning

**Files:** none (runtime verification + Animator BlendTree threshold tuning)

- [ ] **Step 1: Start the server**

In a terminal at the repo root:

```bash
pnpm dev
```

Wait until the Colyseus server logs `listening on ws://localhost:2567`. Leave running.

- [ ] **Step 2: Enter Play mode in Unity**

Press the Play button. The local player should spawn as the Female Blademaster, sword in right hand.

- [ ] **Step 3: Visual checklist — local idle**

With no keys pressed:
- ✓ Character is rendered (not a cube).
- ✓ Sword visible in right hand, gripped correctly.
- ✓ Feet are on terrain (no sinking, no floating). **If sinking or floating:** the FBX is not feet-pivoted as assumed (Risk #4 in the spec). Recover by either (a) opening `PlayerCharacter.prefab`, selecting the root, and shifting its first child's local `Position.y` by the observed offset (positive to lift, negative to lower), or (b) reintroducing a `PLAYER_VISUAL_HALF_HEIGHT` constant in `NetworkClient.cs` matching the offset. Option (a) is cleaner — the offset stays asset-local.
- ✓ Skirt and cape sway subtly (PHY motion is alive).
- ✓ Idle clip plays — character breathes / shifts weight; not a rigid T-pose.

- [ ] **Step 4: Visual checklist — local walk/run**

Press and hold `W` (or any WASD):
- ✓ Character moves and **rotates** to face the direction of travel.
- ✓ Animation blends from idle into walk, then run, as the speed increases.
- ✓ Feet do not visibly slide along the ground.

Release WASD:
- ✓ Character stops walking smoothly (no abrupt cut to idle).
- ✓ Final rotation **holds** (does not snap back to identity / north).

- [ ] **Step 5: Tune the BlendTree thresholds if feet slide**

If the walk or run clips show feet slipping at full speed: exit Play mode, open `Assets/Animators/PlayerCharacter.controller`, drill into the Locomotion BlendTree, and adjust the thresholds.

Reference for tuning: `PredictorConstants.PLAYER_SPEED` is the server's authoritative walking speed (check `Monkey Punch/Assets/Scripts/Net/PredictorConstants.cs` for the exact value). The `run` threshold should equal that speed; the `walk` threshold should be roughly half. Re-enter Play mode after each adjustment and re-verify.

If slide persists at the right threshold, the clip's playback speed is wrong. In the Animator, click the `Locomotion` state; in the Inspector, the **Speed** field (state-level multiplier) defaults to 1. Reduce/increase per state until feet plant. This is a per-clip tuning, not a per-BlendTree-threshold one.

- [ ] **Step 6: Exit Play mode**

Press the Play button again to stop. Important: any threshold changes you made **during** Play mode are reverted on exit. Re-apply them in Edit mode if you made them in Play mode.

- [ ] **Step 7: Commit any tuning changes**

If you changed thresholds or state speeds:

```bash
git add "Monkey Punch/Assets/Animators/PlayerCharacter.controller"
git commit -m "tune(m9): BlendTree thresholds against PLAYER_SPEED to fix foot slide

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

If no changes were needed, skip the commit.

---

### Task 10: Two-client smoke test

**Files:** none (runtime verification)

- [ ] **Step 1: Build a development player**

In Unity, `File → Build Settings`. Confirm `SampleScene` is in the Scenes in Build list (add if missing). Platform: `Windows, Mac, Linux` (or your dev platform). Check `Development Build` for faster iteration. Click **Build** → choose `builds/m9-smoketest/` (relative to repo root) as the output folder. Wait for the build to finish.

- [ ] **Step 2: Run two clients side-by-side**

- Terminal 1: `pnpm dev` still running from Task 9 (if not, restart it).
- In the Unity Editor, **enter Play mode** — first client.
- Launch the built `.exe` (or `.app`) from `builds/m9-smoketest/` — second client.

Both clients should land in the same room (default join code mechanism).

- [ ] **Step 3: Visual checklist — remote player**

From each window, observe the **other** player's character:
- ✓ Remote player renders as Female Blademaster (not a cube, not a blue cube — same character as you).
- ✓ Remote player's motion is smooth (no obvious 50ms-step popping; snapshot interpolation is doing its job).
- ✓ Remote player rotates to face direction of travel — same as local.
- ✓ When the remote player stops, their rotation holds (no oscillation).
- ✓ No visible jitter at full run speed for the remote.

- [ ] **Step 4: Exit Play mode and close the built client**

Stop Unity Play mode. Close the built `.exe`.

---

### Task 11: Regression checks + cleanup

**Files:** optional cleanup of repo-root staging folder.

- [ ] **Step 1: Run the Edit Mode test suite**

In Unity's Test Runner window (Edit Mode tab), click **Run All**.

Expected pass set:
- `PredictorGoldenTest` — bit-identical determinism gate, unaffected by M9.
- `LocomotionParamsTest` — 8 cases from Task 4.
- `GameUITest` / `GameUIPlayModeTest` — unaffected.

If `PredictorGoldenTest` fails, M9 has accidentally touched `LocalPredictor` or its constants. Audit Task 8's edits — only `+ PLAYER_VISUAL_HALF_HEIGHT` arithmetic and color tinting should have moved.

- [ ] **Step 2: Run the Vitest suites**

```bash
pnpm test
```

Expected: server and shared suites green. M9 made zero changes to those packages, so anything red is unrelated to this milestone — log a separate issue.

- [ ] **Step 3: Manual regression — camera, CombatVfx, HUD**

Re-enter Play mode and verify:
- Camera mouselook works (Cursor.lockState is `Locked`, mouse rotates yaw/pitch).
- The level-up debug shortcuts still work: press `K` to self-damage, `B` to spawn enemies, `1/2/3/4` to grant weapons. Confirm the existing CombatVfx flashes appear correctly on the rigged character body (damage flash, hit ring, etc.).
- HUD (HP bar, XP bar, weapon/item inventory, level-up overlay) renders and functions normally.

Exit Play mode.

- [ ] **Step 4: Performance sanity check**

Re-enter Play mode with the standard solo setup. Open `Window → Analysis → Profiler` and confirm frame time stays under ~16ms at idle and during active combat with ~30 enemies (use `B` to spawn extras).

This is a directional sanity check — actual 10-player load can't be reproduced solo. If frame time is already burning >12ms at 1 local + 30 enemies, that's a red flag worth investigating (the most likely lever is `SkinnedMeshRenderer` count per character — Task 7's sub-mesh disabling is supposed to take this down, but a still-large count may indicate the unused renderers were merely hidden, not stripped).

Exit Play mode.

- [ ] **Step 4 (optional): Remove the repo-root staging tree**

The source assets at `Female Blademaster 1/` and `Female Blademaster 1.zip` in the repo root are duplicates of what now lives under `Assets/`. To remove them:

```bash
rm -rf "Female Blademaster 1" "Female Blademaster 1.zip"
```

(Skip this step if you'd rather keep an archival copy outside the Unity project.)

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore(m9): cleanup staging tree from repo root

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

If you skipped Step 4, skip this commit too — there'll be nothing to commit.

---

## Done

At this point M9 is complete:
- Local + remote players render as the Female Blademaster.
- Locomotion animation blends smoothly across idle/walk/run from velocity.
- Facing rotates toward direction of travel; holds when stopped.
- Sword is gripped in the right hand throughout.
- PHY-baked secondary motion (skirt, cape, sleeves) animates without cloth components.
- Server / schema / wire are unchanged.

Deferred items (per the design spec's "Out of scope" section) are intentionally untouched and remain as future-milestone candidates.
