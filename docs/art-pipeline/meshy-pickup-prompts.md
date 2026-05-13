# Pickup Asset Generation — Two-Stage AI Pipeline

Reference for generating stylized low-poly **pickups** — EXP gems, gold
coins, treasure chests — that match the PSX/N64-era visual language
established for the enemy roster in `meshy-enemy-prompts.md`. Same
two-stage Midjourney → Meshy pipeline, adjusted for inert props.

## Pipeline

```
[Stage 1: Image AI] — generate concept art (3/4 view, white BG)
         ↓ pick the best concept
[Stage 2: Meshy Image-to-3D] — produce GLB with PBR maps
         ↓
[Unity import] — extract materials → URP/Lit → pickup prefab
                 (procedural MonoBehaviour for bob / spin)
```

### Differences vs the enemy pipeline

- **No `--sref`.** The Blademaster reference is for creature design
  language; on inert props it can leak humanoid features (faces on
  coins, limbs on gems). Verbal PSX/N64 anchoring carries the look on
  its own. Re-evaluate after the slime ships — if it lands cleanly
  PSX/N64, use the **slime** as the prop `--sref` going forward.
- **Lower triangle targets.** Pickups are small in-world. Smart
  Remesh targets are roughly half of the trash-mob range (see
  workflow section below).
- **All Path A.** No rigs. Animation is procedural in Unity (gem
  float-bob, coin Y-spin, chest static — with the lid as an optional
  separate child mesh if a future opening animation lands).

## Style anchor — PSX/N64-era aesthetic

Same anchor as the enemy doc, lightly retuned for inert single-object
shots (no "full body" or "standing pose" wording). **Inlined directly
into every prompt below** — paste each as-is.

```
late-1990s PlayStation 1 / Nintendo 64 era 3D game art aesthetic,
low-poly faceted geometry with visible polygon edges, chunky
simple silhouette, limited color palette (16-32 colors),
low-resolution pixelated baked textures, no smooth shading, flat
or per-face lighting, vintage stylized anime JRPG sensibility,
3/4 front view, isolated single item centered in frame, neutral
resting pose, white background, concept turnaround sheet style
```

For Midjourney, append:
```
--style raw --ar 1:1 --v 7
```

### Negative directives (Stage 1)

Expanded from the enemy doc to suppress anatomy bleed-through. For
MJ/ChatGPT, fold inline. For Leonardo/SD, paste into the
negative-prompt field:

```
no photorealism, no high-poly modern 3D, no smooth normals, no
subsurface scattering, no detailed PBR roughness, no scene background,
no characters, no creatures, no living beings, no hands, no feet,
no anthropomorphic features, no text, no watermark, no perspective
distortion, no extreme low angle, no Pixar / DreamWorks rendering
style, no Unreal Engine look, no Octane render, no 8K textures
```

---

## Animation source — all Path A (procedural)

Every pickup is animated entirely in Unity, never via a Meshy rig. The
scripts are 5–10 lines each and share scaffolding with `SlimeBob.cs`.

| Asset | Procedural behavior |
|---|---|
| EXP gem (all tiers) | Sine Y-bob (~0.05m amplitude, ~1.5 Hz) + slow Y-rotation (~30°/s) |
| Gold coin (single & stack) | Y-axis spin (~180°/s); the stack and pile rotate as a single unit |
| Treasure chest (all tiers) | Static. If an opening animation lands later, hinge the lid as a separate child mesh and rotate around its bottom-rear edge |

Don't enable Meshy's auto-rig step on any pickup. Wastes credits and
adds Animator import complexity for zero animation gain.

---

## Pickup roster (3 gems + 3 coins + 3 chests)

Each entry has:
- **Stage 1**: complete prompt for image generation
- **Stage 2**: complete prompt for Meshy (paired with the picked image)
- **Role**: how the asset fits the game
- **Animation**: always Path A — script-driven in Unity

---

### 1. EXP Gem — Small Tier (cyan)

**Stage 1:**
```
A small floating gemstone shaped as a sharply pointed octahedron
crystal, eight clearly faceted triangular faces meeting at the top
and bottom apex points, luminous cyan blue color (#5be6ff range)
with a bright glowing inner core visible through the translucent
gem, the surface catches a single hard highlight on the upper-front
facet, the gem hovers in mid-air with no visible support beneath it,
classic JRPG experience-point gem silhouette, late-1990s PlayStation
1 / Nintendo 64 era 3D game art aesthetic, low-poly faceted geometry
with visible polygon edges, chunky simple silhouette, limited color
palette, low-resolution pixelated baked textures, no smooth shading,
vintage stylized anime JRPG sensibility, 3/4 front view, isolated
single item centered in frame, neutral hovering pose, white
background, concept turnaround sheet style
```

**Stage 2 (Meshy):**
```
Late-1990s PSX/N64-era low-poly octahedral gemstone, sharply pointed
bipyramidal crystal with eight clearly faceted triangular faces
meeting at top and bottom apex points, luminous cyan glowing color
with a bright inner-light gradient baked into the texture (bright
saturated core visible through the gem reads as self-emissive even
on an unlit diffuse), ~100-200 triangle target, faceted flat
shading (no smooth normals), low-resolution baked texture atlas at
128x128, retro game-ready
```

**Role:** small XP drop — `Gem.value` in the low bracket (1–4 XP).
Dropped by trash mobs.

**Animation:** Path A. Unity MonoBehaviour (`GemBob.cs`) drives sine
Y-bob + slow Y-rotation. Matches the existing `GemSwarm.tsx` hover
height (Y ≈ 0.4).

---

### 2. EXP Gem — Medium Tier (magenta)

**Stage 1:**
```
A small floating gemstone shaped as a sharply pointed octahedron
crystal, eight clearly faceted triangular faces meeting at the top
and bottom apex points, luminous magenta-violet color (vivid
fuchsia, roughly #e860ff range) with a bright glowing inner core
visible through the translucent gem, the surface catches a single
hard highlight on the upper-front facet, the gem hovers in mid-air
with no visible support beneath it, classic JRPG experience-point
gem silhouette, late-1990s PlayStation 1 / Nintendo 64 era 3D game
art aesthetic, low-poly faceted geometry with visible polygon
edges, chunky simple silhouette, limited color palette, low-
resolution pixelated baked textures, no smooth shading, vintage
stylized anime JRPG sensibility, 3/4 front view, isolated single
item centered in frame, neutral hovering pose, white background,
concept turnaround sheet style
```

**Stage 2 (Meshy):**
```
Late-1990s PSX/N64-era low-poly octahedral gemstone, sharply
pointed bipyramidal crystal with eight clearly faceted triangular
faces meeting at top and bottom apex points, luminous magenta-
violet glowing color with a bright inner-light gradient baked into
the texture (bright saturated core visible through the gem reads
as self-emissive even on an unlit diffuse), ~100-200 triangle
target, faceted flat shading (no smooth normals), low-resolution
baked texture atlas at 128x128, retro game-ready
```

**Role:** medium XP drop — `Gem.value` in the mid bracket (5–14 XP).
Dropped by mid-tier enemies (mushroom, cocoon, beetle).

**Animation:** Path A. Same `GemBob.cs` script, identical motion to
the small gem. Tier is purely a visual + value distinction.

**Mesh reuse note:** the geometry is identical to the small gem —
you can save Meshy credits by re-skinning the cyan mesh's texture to
magenta in Photoshop rather than re-generating. The Stage 1 prompt is
included separately in case you want a tier-specific concept reroll.

---

### 3. EXP Gem — Large Tier (gold)

**Stage 1:**
```
A small floating gemstone shaped as a sharply pointed octahedron
crystal, eight clearly faceted triangular faces meeting at the top
and bottom apex points, luminous warm gold-amber color (rich
yellow-gold, roughly #ffd24a range) with a bright glowing inner
core visible through the translucent gem, the surface catches a
single hard highlight on the upper-front facet, the gem hovers in
mid-air with no visible support beneath it, classic JRPG experience-
point gem silhouette suggesting rare and valuable, late-1990s
PlayStation 1 / Nintendo 64 era 3D game art aesthetic, low-poly
faceted geometry with visible polygon edges, chunky simple
silhouette, limited color palette, low-resolution pixelated baked
textures, no smooth shading, vintage stylized anime JRPG
sensibility, 3/4 front view, isolated single item centered in
frame, neutral hovering pose, white background, concept turnaround
sheet style
```

**Stage 2 (Meshy):**
```
Late-1990s PSX/N64-era low-poly octahedral gemstone, sharply
pointed bipyramidal crystal with eight clearly faceted triangular
faces, luminous warm gold-amber glowing color with a bright inner-
light gradient baked into the texture (bright saturated core
visible through the gem reads as self-emissive even on an unlit
diffuse), ~100-200 triangle target, faceted flat shading (no
smooth normals), low-resolution baked texture atlas at 128x128,
retro game-ready
```

**Role:** large XP drop — `Gem.value` in the high bracket (15+ XP).
Dropped by elites and the skeleton warrior.

**Animation:** Path A. Same script as small/medium gems.

**Mesh reuse note:** same geometry as the other two tiers — re-skin
or re-generate per concept needs.

---

### 4. Gold Coin — Single

**Stage 1:**
```
A single gold coin disc resting in mid-rotation, the coin is a
thick faceted cylinder with a chamfered beveled rim, bright warm
yellow-gold color throughout, the front face has a simple stamped
five-pointed star or sunburst icon engraved into the center,
visible polygonal edges around the rim and bevels, the coin is
tilted at a slight angle so both the front face and the thick edge
are visible, classic JRPG currency pickup silhouette, late-1990s
PlayStation 1 / Nintendo 64 era 3D game art aesthetic, low-poly
faceted geometry with visible polygon edges, chunky simple
silhouette, limited color palette, low-resolution pixelated baked
textures, no smooth shading, vintage stylized anime JRPG
sensibility, 3/4 front view, isolated single item centered in
frame, neutral resting pose, white background, concept turnaround
sheet style
```

**Stage 2 (Meshy):**
```
Late-1990s PSX/N64-era low-poly gold coin, thick faceted cylindrical
disc with a chamfered beveled rim, bright warm yellow-gold color,
front face has a stamped recessed sunburst or five-pointed star
icon baked into the texture (no separate geometry for the icon),
visibly faceted cylindrical sides showing the polygonal cylinder
approximation, ~100-200 triangle target, flat shading (no smooth
normals), low-resolution baked texture atlas at 128x128, retro
game-ready
```

**Role:** standard currency drop — small value, common.

**Animation:** Path A. Unity MonoBehaviour (`CoinSpin.cs`) does
constant Y-axis rotation (~180°/s) so the disc catches the eye from
any camera angle.

---

### 5. Gold Coin — Small Stack (3 coins)

**Stage 1:**
```
A small stack of three gold coin discs piled on top of each other,
slightly offset and jaunty rather than perfectly aligned, each
coin is a thick faceted cylinder with a chamfered beveled rim and
a stamped sunburst icon on its top face, bright warm yellow-gold
color throughout, the topmost coin catches a hard highlight, the
stack rests on a flat neutral surface, classic JRPG currency
pickup silhouette suggesting a slightly more valuable drop than a
single coin, late-1990s PlayStation 1 / Nintendo 64 era 3D game
art aesthetic, low-poly faceted geometry with visible polygon
edges, chunky simple silhouette, limited color palette, low-
resolution pixelated baked textures, no smooth shading, vintage
stylized anime JRPG sensibility, 3/4 front view, isolated single
item centered in frame, neutral resting pose, white background,
concept turnaround sheet style
```

**Stage 2 (Meshy):**
```
Late-1990s PSX/N64-era low-poly stack of three gold coin discs,
slightly offset stacking (not perfectly aligned), each coin a
thick faceted cylinder with chamfered beveled rims, bright warm
yellow-gold color, top coin has a stamped sunburst icon baked
into the texture, the whole stack is a single welded mesh,
visibly faceted geometry, ~250-400 triangle target, flat shading
(no smooth normals), low-resolution baked texture atlas at
128x128, retro game-ready
```

**Role:** medium currency drop — mid-tier enemy reward.

**Animation:** Path A. Same `CoinSpin.cs` script; the stack rotates
as a single welded unit.

**Mesh reuse alternative:** if you want to save Meshy credits, skip
this prompt and instead instance the single-coin prefab three times
in Unity at slight Y / rotation offsets, parented under one
spinning anchor. Visually equivalent at PSX texture sizes.

---

### 6. Gold Coin — Large Pile (6–8 coins)

**Stage 1:**
```
A small loose pile of six to eight gold coin discs scattered on a
flat surface, coins overlapping and lying at various tilted angles,
some flat-down some on their edges, each coin is a thick faceted
cylinder with a chamfered beveled rim and a stamped sunburst icon
on its visible face, bright warm yellow-gold color throughout, the
top coins catch hard highlights, the pile sits as a small loose
heap rather than a tower, classic JRPG currency pickup silhouette
suggesting a generous rare drop, late-1990s PlayStation 1 /
Nintendo 64 era 3D game art aesthetic, low-poly faceted geometry
with visible polygon edges, chunky simple silhouette, limited
color palette, low-resolution pixelated baked textures, no smooth
shading, vintage stylized anime JRPG sensibility, 3/4 front view,
isolated single item centered in frame, neutral resting pose,
white background, concept turnaround sheet style
```

**Stage 2 (Meshy):**
```
Late-1990s PSX/N64-era low-poly pile of six to eight gold coin
discs scattered loosely, coins overlapping at various tilts (some
flat, some on edge), each coin a thick faceted cylinder with a
chamfered rim, bright warm yellow-gold color, sunburst icon baked
into the texture on visible top faces, the whole pile is a single
welded mesh, visibly faceted geometry, ~500-800 triangle target,
flat shading (no smooth normals), low-resolution baked texture
atlas at 128x128, retro game-ready
```

**Role:** large currency drop — elite / chest reward.

**Animation:** Path A. Same `CoinSpin.cs` (the pile rotates as a
unit) — or skip rotation and let the pile sit static for a more
"loot heap" feel; if static, raise it slightly with a Y-bob like
the gems for visibility.

**Mesh reuse alternative:** same idea as the small stack — instance
the single-coin prefab 6–8 times in Unity with randomized rotation
+ position offsets under a parent anchor. Cheapest path to a
"pile" without paying Meshy for a third coin mesh.

---

### 7. Treasure Chest — Wooden (common)

**Stage 1:**
```
A small square wooden treasure chest with a flat hinged lid, the
body is a squat cube made of warm honey-brown wooden planks with
visible vertical seams between boards, two dark iron horizontal
banding strips wrap around the body (one near the top and one
near the bottom), a simple iron padlock plate sits centered on the
front face, the lid is closed and seated flush on top, the chest
rests directly on a flat neutral surface, classic JRPG treasure
chest silhouette in the Dragon Quest / Final Fantasy lineage,
late-1990s PlayStation 1 / Nintendo 64 era 3D game art aesthetic,
low-poly faceted geometry with visible polygon edges, chunky
simple silhouette, limited color palette, low-resolution pixelated
baked textures, no smooth shading, vintage stylized anime JRPG
sensibility, 3/4 front view, isolated single item centered in
frame, neutral resting pose, white background, concept turnaround
sheet style
```

**Stage 2 (Meshy):**
```
Late-1990s PSX/N64-era low-poly wooden treasure chest, squat cube
body of warm honey-brown wooden planks with vertical board seams
in the texture, two dark iron horizontal bands wrapping around the
body, simple iron padlock plate centered on the front face, flat
hinged lid closed and seated flush, resting flat on a neutral base,
classic flat-top JRPG chest silhouette, visibly faceted geometry,
~400-600 triangle target, flat shading (no smooth normals), low-
resolution baked texture atlas at 128x128, retro game-ready
```

**Role:** common chest — drops small/medium coin piles and a tier-1
gem on opening. (Chest interaction logic doesn't yet exist in the
codebase — this is the asset prep.)

**Animation:** Path A. Static MeshRenderer prefab. When chest-
opening is added later, author the lid as a separate child mesh
hinged on its bottom-rear edge and rotate ~110° on interaction —
no rig required.

---

### 8. Treasure Chest — Iron-Banded (rare)

**Stage 1:**
```
A small square reinforced treasure chest with a flat hinged lid,
the body is a squat cube of dark-stained wooden planks heavily
reinforced with thick dark iron banding — four iron bands wrap the
body horizontally (top, upper-middle, lower-middle, bottom) plus
two vertical iron corner reinforcement straps on the front face,
prominent iron rivet studs along the bands, a heavy iron padlock
plate with a keyhole sits centered on the front face, the lid is
closed and seated flush on top, dark cool palette of deep walnut
brown wood and gunmetal iron, the chest rests directly on a flat
neutral surface, classic JRPG rare treasure chest silhouette,
late-1990s PlayStation 1 / Nintendo 64 era 3D game art aesthetic,
low-poly faceted geometry with visible polygon edges, chunky
simple silhouette, limited color palette, low-resolution pixelated
baked textures, no smooth shading, vintage stylized anime JRPG
sensibility, 3/4 front view, isolated single item centered in
frame, neutral resting pose, white background, concept turnaround
sheet style
```

**Stage 2 (Meshy):**
```
Late-1990s PSX/N64-era low-poly iron-reinforced treasure chest,
squat cube body of dark walnut wood with vertical board seams,
four horizontal dark iron bands plus two vertical iron corner
straps on the front, rivet studs along the bands baked into the
texture, heavy iron padlock plate with keyhole centered on the
front, flat hinged lid closed and seated flush, resting flat on a
neutral base, classic flat-top JRPG chest silhouette with rare-
tier visual weight, visibly faceted geometry, ~600-900 triangle
target, flat shading (no smooth normals), low-resolution baked
texture atlas at 128x128, retro game-ready
```

**Role:** rare chest — drops the large coin pile and a tier-2 gem.

**Animation:** Path A. Same approach as the wooden chest.

---

### 9. Treasure Chest — Gilded (legendary)

**Stage 1:**
```
A small square ornate treasure chest with a flat hinged lid, the
body is a squat cube of dark mahogany wooden planks lavishly
trimmed with bright gold metal accents — gold horizontal bands top
and bottom, gold corner reinforcement caps on every vertical edge,
ornamental gold filigree pattern engraved into the gold banding,
a single small inset red ruby or red gemstone embedded in the
center of the front face below an ornate gold padlock plate, the
lid is closed and seated flush on top, the silhouette is richer
and more decorated than a common chest but still recognizably the
same flat-top JRPG chest shape, the chest rests directly on a flat
neutral surface, classic JRPG legendary treasure chest silhouette,
late-1990s PlayStation 1 / Nintendo 64 era 3D game art aesthetic,
low-poly faceted geometry with visible polygon edges, chunky
simple silhouette, limited color palette, low-resolution pixelated
baked textures, no smooth shading, vintage stylized anime JRPG
sensibility, 3/4 front view, isolated single item centered in
frame, neutral resting pose, white background, concept turnaround
sheet style
```

**Stage 2 (Meshy):**
```
Late-1990s PSX/N64-era low-poly gilded legendary treasure chest,
squat cube body of dark mahogany wood with bright gold horizontal
banding top and bottom, gold corner reinforcement caps on every
vertical edge, ornamental filigree pattern baked into the gold
band texture, single inset red ruby gemstone centered on the front
face below an ornate gold padlock plate, flat hinged lid closed
and seated flush, resting flat on a neutral base, classic flat-top
JRPG chest silhouette with legendary-tier visual weight, visibly
faceted geometry, ~800-1200 triangle target, flat shading (no
smooth normals), low-resolution baked texture atlas at 128x128,
retro game-ready
```

**Role:** legendary chest — guaranteed gem of the highest tier
(gold) plus a large coin pile, possibly future item drops.

**Animation:** Path A static. The gem inlay is texture-baked, not
a separate emissive mesh — keeps the prefab a single MeshRenderer.

---

## After Stage 2 — Unity import workflow (pickup-tuned)

Mirrors the enemy-pipeline workflow with pickup-specific tweaks at
the scale and material layers.

1. **Save the file** to `Monkey Punch/Assets/Art/Pickups/<asset>/<asset>.glb`.
   All pickups are Path A → GLB, never FBX.

2. **Mesh import settings:**
   - **Animation Type:** None.
   - **Generate Normals:** **Calculate** with **Smoothing Angle = 0**
     — faceted flat shading. The single biggest PSX-look lever at
     the mesh level.
   - **Generate Lightmap UVs:** off.
   - **Read/Write Enabled:** off.
   - **Scale Factor:** tune so the imported mesh fits the in-world
     pickup radius (gems ~0.3, coins ~0.25, chests ~0.6 — match
     the gameplay collision radius).

3. **Texture import settings** (per imported PNG):
   - **Filter Mode:** **Point (no filter)**.
   - **Max Size:** **128**.
   - **Compression:** None or Low.
   - **Generate Mip Maps:** off.
   - **sRGB:** on.

4. **Extract materials** to `Assets/Art/Pickups/<asset>/Materials/`.

5. **Material setup:**
   - **Coins, chests:** URP/Lit with the extracted baseColor texture.
     No emission. Smoothness 0, Metallic 0 (defer the "metallic
     coin shine" to a Unity-side rim-light or per-pixel highlight
     bake — actual PBR metal looks wrong against the faceted
     shading).
   - **Gems:** URP/Lit with the extracted baseColor texture **and**
     the same texture wired into the **Emission** slot at a low-to-
     moderate intensity (~0.6–1.0). The Stage-2 prompts asked Meshy
     to bake the inner-light gradient into the baseColor; reusing
     that texture as the emission map gives a free "luminous core"
     look without authoring a second map. Match the existing
     web-client GemSwarm.tsx emissive direction (`emissive={color}`
     + `emissiveIntensity={0.7}`).

6. **Smart Remesh target** (in Meshy *before* export):
   - **Gems:** 100–200 tris
   - **Single coin:** 100–200 tris
   - **Coin stack (3):** 250–400 tris
   - **Coin pile (6–8):** 500–800 tris
   - **Wooden chest:** 400–600 tris
   - **Iron-banded chest:** 600–900 tris
   - **Gilded chest:** 800–1200 tris

   Roughly half the enemy roster's tri budget — pickups are small
   and the silhouette work is simple geometric primitives.

7. **Create the prefab** under `Assets/Prefabs/Pickups/<asset>.prefab`.
   Root GameObject + MeshRenderer + the procedural script:
   - `GemBob.cs` — sine Y-bob + Y-rotation (applied to all three gem
     tiers; tier-specific prefabs share the script).
   - `CoinSpin.cs` — constant Y-axis rotation.
   - (Chests need no script — static mesh.)

8. **Wire selection into the spawn path.** `Gem.value` already
   exists on the schema (`uint16`). Map value brackets to gem
   prefabs in the Unity-side gem renderer (the equivalent of
   `GemSwarm.tsx` for the Unity client):
   - `1..4` → cyan small
   - `5..14` → magenta medium
   - `15..∞` → gold large

   For coins/chests, schema work is still to-do — these prompts
   prep the assets ahead of the gameplay code that will use them.

---

## Pricing math

Same Midjourney Standard + Meshy Pro assumption as the enemy doc.

- **Per concept image:** ~$0.03.
- **Per 3D model (static GLB):** ~$1–1.50 in Meshy credits.
- **For all 9 pickups × 3 concept rerolls:**
  - Concept art: ~27 images = ~$0.81
  - 3D models: 9 × ~$1.25 = ~$11.25
  - Total: **~$12 in usage cost**.
- **Mesh-reuse optimization** (skip generating medium/large gem
  meshes, re-skin cyan mesh to magenta and gold textures instead;
  skip stack/pile coin meshes and Unity-instance single coins
  instead): drops 3D generation cost to ~$5 — total **~$6**.

Either way, well inside one month of Meshy Pro.

---

## Iteration discipline

Same rules as the enemy doc, plus one pickup-specific addition:

- **Side-by-side test with a gem already in scene.** When the cyan
  gem comes back, drop it into SampleScene at the existing
  `GemSwarm` Y=0.4 hover height and confirm the silhouette reads
  at the camera distance the player will actually see it from. If
  the gem looks fine in isolation but vanishes against the terrain
  during gameplay, that's a Stage-1 color/saturation issue — re-
  prompt with more aggressive saturation language, not a texture
  fix in Photoshop.

- **Generate the gem tiers in order: cyan first.** Cyan matches the
  current placeholder, so it's the easiest tier to A/B-test against
  the existing in-game gem. Magenta and gold tiers are color
  reskins of the validated cyan shape — no need to re-judge the
  silhouette per tier.

- **For chests, generate the wooden tier first.** It's the most
  common drop and the visual baseline. If wooden lands right, the
  iron and gilded tiers are escalations of the same silhouette.

---

## Future follow-ups (not blocking)

- **Open-state chest mesh.** Currently scoped as "closed only" with
  the lid hinged via a separate child mesh in Unity if an opening
  animation is needed. If gameplay later wants a persistent "opened
  chest stays in world" state, generate a matching open-lid mesh
  per tier (3 more prompts, mirrors the closed structure).
- **Locked-chest variant.** A glow / chain-wrap indicator for
  special drops, deferred until a lock mechanic exists in code.
- **Slime as future `--sref`.** Once the bouncy slime ships and
  reads cleanly PSX/N64, swap it in as the prop style anchor for
  future pickup additions — gives the same style-locking benefit
  the Blademaster `--sref` gives to enemy generation.
