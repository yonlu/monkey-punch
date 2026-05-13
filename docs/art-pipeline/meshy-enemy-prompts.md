# Enemy Asset Generation — Two-Stage AI Pipeline

Reference for generating stylized low-poly enemies that match the Female
Blademaster's visual language. Inspired by Ragnarok Online's monster
roster but deliberately abstracted to avoid 1:1 lookalikes.

## Pipeline

```
[Unity screenshot of Blademaster]
         ↓ used as style reference
[Stage 1: Image AI] — generate concept art (front view, white BG)
         ↓ pick the best concept
[Stage 2: Meshy Image-to-3D] — produce GLB with PBR maps
         ↓
[Unity import] — extract materials → URP/Lit → static enemy prefab
```

### Why two stages

- Text-to-3D in any tool struggles to lock a specific art style across
  multiple assets. Style drifts shot-to-shot.
- A concept image is a hard visual anchor that Meshy's Image-to-3D
  reliably reproduces in 3D.
- You get to *pick* the best concept (re-roll cheap) before paying for
  the (slower, more expensive) 3D generation.
- The Stage-1 concept also doubles as a portfolio / pitch artifact even
  if the 3D version doesn't ship.

---

## Tool choices for Stage 1

| Tool | Strengths | Weaknesses |
|---|---|---|
| **Midjourney v7** (recommended) | Strongest for stylized concept art; `--sref` accepts an image to lock style consistently across multiple generations | $10/mo minimum, Discord-based UI |
| **ChatGPT image gen (GPT-5 image)** | Accepts a style reference image natively in chat; conversational refinement | Slower per-image, fewer variations per request |
| **Leonardo.ai** | Free tier; game-art presets; "Image Guidance" for style references | Quality below MJ; outputs lean toward generic fantasy |
| **Stable Diffusion + Anime LoRA** (local, free) | Free, infinite tweaking, no rate limits | Setup effort; needs a GPU; LoRA hunting |

**Recommended for this project:** Midjourney v7 with `--sref` of a
Blademaster screenshot. Cleanest results with minimal iteration.

### Capturing the style reference

Before any Stage 1 prompt:

1. Open Unity, enter Play mode, position the Blademaster in good light
   (the Directional Light in `SampleScene` is fine).
2. Frame her in a 3/4 front view at her idle pose (`idle_weapon_ready_PHY`).
3. Take a clean screenshot at 1024×1024 or larger. Crop to square.
4. Save as `style_ref_blademaster.png` in your concept-art workspace.
5. In Midjourney: upload this image and use it as `--sref` on every
   enemy prompt. In ChatGPT image gen: attach it as a reference image
   in the message.

---

## Style anchor — PSX/N64-era aesthetic

Target look: **late-90s 3D era — original PlayStation / Nintendo 64 game
art**, but stylized rather than ugly. The aesthetic is mostly enforced
at *rendering time* (low texture res, point filtering, flat shading,
optional vertex snap shader) — concept art alone can't fully produce
it. But Stage 1 directives bias the look toward chunky, faceted
geometry that Meshy will then interpret in 3D.

This anchor is **inlined directly into every prompt below** — no
placeholder to substitute, paste each prompt as-is.

```
late-1990s PlayStation 1 / Nintendo 64 era 3D game art aesthetic,
low-poly faceted geometry with visible polygon edges, chunky
square-ish silhouettes, limited color palette (16-32 colors),
low-resolution pixelated baked textures, no smooth shading, flat
or per-face lighting, vintage stylized anime JRPG sensibility,
3/4 front view, full body, neutral standing pose, white background,
concept turnaround sheet style
```

For Midjourney, append:
```
--style raw --ar 1:1 --v 7 --sref <your-uploaded-blademaster-image>
```

> **Note on the Blademaster `--sref`:** her current import is *not* PSX/N64 —
> she's modern stylized anime. The `--sref` still helps Midjourney match
> her *creature design language* (cute, anime-flavored), and the explicit
> PSX wording in the prompt pulls the rendering style toward retro. After
> the Blademaster retrofit (see end of doc), the `--sref` will match
> end-to-end. Until then, expect the concept art to be "more chunky-retro
> than the Blademaster" — that's the target end state anyway.

### Negative directives (Stage 1)

For MJ/ChatGPT, fold inline. For Leonardo/SD, paste into the
negative-prompt field:

```
no photorealism, no high-poly modern 3D, no smooth normals, no
subsurface scattering, no anime closeup, no portrait crop, no
detailed PBR roughness, no scene background, no other characters,
no text, no watermark, no perspective distortion, no extreme low
angle, no Pixar / DreamWorks rendering style, no Unreal Engine
look, no Octane render, no 8K textures
```

---

## Animation source — decide before exporting

Every enemy is animated in-game, but **how** the animation is
authored is a per-creature decision made at Meshy export time:

### Path A — Static mesh + procedural Unity animation

- **In Meshy:** skip the auto-rig step. Export as **GLB**.
- **In Unity:** a small MonoBehaviour wiggles `transform` every frame
  (squash, bob, float, drift). No Animator, no Animator Controller,
  no rig.
- **Why it works:** blob / amorphous / wing-less creatures have nothing
  to articulate. A slime "animated" via squash-and-stretch code looks
  identical to (and is cheaper than) one with a baked rig.
- **Examples in this roster:** slime, cocoon, ghost, chick.

### Path B — Rigged FBX + Meshy bundled animations

- **In Meshy:** enable auto-rig at export. Pick clips from Meshy's
  motion library (`idle`, `walk`, `attack`, `flying`, etc.). Export
  as **FBX**.
- **In Unity:** Animator + simple controller (single state or 1D
  BlendTree, matching the M9 Blademaster pattern).
- **Why it's needed:** anything with legs (mushroom, beetle, skeleton)
  or wings (bat) needs articulation that procedural transform tweaks
  can't fake convincingly.
- **Examples in this roster:** mushroom, bunny, beetle, bat, skeleton.

### Quick reference

| Creature | Path | Why |
|---|---|---|
| Slime | A (procedural) | No limbs; squash/stretch is the look |
| Bunny | A (procedural) | Hop-bob reads better than walk cycle on a chibi body |
| Mushroom | B (rigged) | Stubby legs need to step |
| Cocoon | A (procedural) | Dormant wobble in place; no limbs |
| Ghost | A (procedural) | Float-bob + rotation drift; no body to rig |
| Beetle | B (rigged) | Six legs walking is signature |
| Chick | A (procedural) | Wings too vestigial to rig; idle hop |
| Bat | B (rigged) | Wing flap is essential, procedural can't fake it |
| Skeleton | B (rigged) | Humanoid walk + attack with weapon — needs full rig |

### Cost implication

Path B (rigged FBX) consumes more Meshy credits per asset — typically
~50% more than a static GLB, plus per-animation credits. Path A
externalizes the animation work to your Unity codebase, which is free
but takes engineer time. For a 9-enemy roster, Paths A + B split
roughly 50/50 here, so total Meshy cost lands ~25% higher than the
all-static estimate (~$20 vs ~$16). Still well inside one month's
Meshy Pro subscription.

---

## Enemy roster (9 starters + variants)

Each entry has:
- **Stage 1**: complete prompt for image generation
- **Stage 2**: complete prompt for Meshy (paired with the picked image)
- **Role**: gameplay tier — drives spawner weighting and HP

---

### 1. Bouncy Slime (trash mob, swarm)

**Stage 1:**
```
A small round gelatinous slime creature, glossy translucent surface
with a single highlight on top, two simple bead eyes, no mouth, no
limbs, slightly squashed sphere shape, cheerful cute expression,
single dominant color (translucent rose pink) with a darker pink
inner core visible through the gel, late-1990s PlayStation / N64 era game art aesthetic, low-poly
faceted geometry, limited color palette, low-resolution baked
textures, no smooth shading, stylized anime JRPG sensibility, 3/4
front view, full body, neutral pose, white background, concept
turnaround sheet style
```

**Stage 2 (Meshy):**
```
Late-1990s PSX/N64-era low-poly slime creature, rounded squashed
sphere body with visibly faceted geometry, single highlight on top
suggesting wet gloss, two bead eyes, no limbs, ~500-1000 triangle
target, faceted flat shading (no smooth normals), low-resolution
baked texture atlas at 128x128, retro game-ready
```

**Variants:** swap "translucent rose pink" → `deep cobalt blue` /
`vivid emerald green` / `pale gold` for color rerolls without re-generating
the mesh.

**Role:** trash mob — 1 HP, dies in one hit, spawns in groups of 5-8.

**Animation:** Path A (procedural). Skip Meshy's rig step. Unity
MonoBehaviour squashes + bobs the transform on a sine wave.

---

### 2. Hopping Bunny (trash mob, fast)

**Stage 1:**
```
A tiny round forest rabbit creature with oversized head and tiny
body, large innocent dark eyes, short stubby legs, fluffy round tail,
sitting upright in alert pose, exaggerated chibi proportions,
soft pastel cream coloring with pink ear interiors, no fierce
features, looks innocent rather than threatening, late-1990s PlayStation / N64 era game art aesthetic, low-poly
faceted geometry, limited color palette, low-resolution baked
textures, no smooth shading, stylized anime JRPG sensibility, 3/4
front view, full body, neutral pose, white background, concept
turnaround sheet style
```

**Stage 2 (Meshy):**
```
Late-1990s PSX/N64-era low-poly chibi rabbit creature, oversized
round head, small upright body, fluffy tail, stubby legs, neutral
standing pose facing forward, visibly faceted geometry, ~700-1200
triangle target, flat shading (no smooth normals), low-resolution
baked texture atlas at 128x128, retro game-ready
```

**Variants:** `pastel cream + pink` / `light gray + blue` / `pale brown + amber`.

**Role:** trash mob — 1 HP, 1.5× movement speed.

**Animation:** Path A (procedural). Unity MonoBehaviour drives a
hop-bob (vertical sine + slight forward lean on the upstroke).

---

### 3. Walking Mushroom (mid-tier, melee)

**Stage 1:**
```
A small upright mushroom creature with a wide rounded cap and a
short fat stem, the cap is rich red with simple white circular spots,
two tiny dot eyes embedded in the stem, no arms, two stubby legs
visible beneath the cap edge, no mouth, neutral standing pose,
silhouette resembles an umbrella with feet, late-1990s PlayStation / N64 era game art aesthetic, low-poly
faceted geometry, limited color palette, low-resolution baked
textures, no smooth shading, stylized anime JRPG sensibility, 3/4
front view, full body, neutral pose, white background, concept
turnaround sheet style
```

**Stage 2 (Meshy):**
```
Late-1990s PSX/N64-era low-poly mushroom monster, large round red
cap with white spots, short stem body, two stubby legs, two simple
eye dots on stem, standing upright pose, visibly faceted geometry,
~800-1500 triangle target, flat shading (no smooth normals),
low-resolution baked texture atlas at 128x128, retro game-ready
```

**Variants:** `rich red cap with white spots` / `dark violet cap with
yellow spots` / `forest green cap with cream spots`.

**Role:** mid-tier — 3 HP, normal speed, drops gem on death.

**Animation:** Path B (rigged). Enable Meshy auto-rig at export.
Bundled clips: `idle`, `walk`. Export as FBX. Unity Animator with
the M9 BlendTree pattern (idle@0 → walk@0.5 on `Speed`).

---

### 4. Cocoon Larva (mid-tier, slow)

**Stage 1:**
```
A smooth egg-shaped insect cocoon, slightly elongated vertically,
covered in stylized silk wrapping patterns that suggest layered
threads, two closed half-moon eye slits near the top suggesting it
is sleeping or dormant, no limbs, no mouth, sitting on its rounded
base, monochrome golden silk coloring with subtle highlights,
late-1990s PlayStation / N64 era game art aesthetic, low-poly
faceted geometry, limited color palette, low-resolution baked
textures, no smooth shading, stylized anime JRPG sensibility, 3/4
front view, full body, neutral pose, white background, concept
turnaround sheet style
```

**Stage 2 (Meshy):**
```
Late-1990s PSX/N64-era low-poly cocoon monster, egg-shaped body
with silk wrap pattern baked into the texture, two closed eye
slits, no limbs, dormant standing pose, visibly faceted geometry,
~500-900 triangle target, flat shading (no smooth normals),
low-resolution baked texture atlas at 128x128, retro game-ready
```

**Variants:** `golden silk` / `pale jade silk` / `dusty rose silk`.

**Role:** mid-tier — 4 HP, 0.7× movement speed, denser swarms.

**Animation:** Path A (procedural). Unity MonoBehaviour applies a
tiny rotational wobble (the cocoon trembles in place) + a slow
breathing-scale pulse. No locomotion clip needed — server-driven
position handles forward motion.

---

### 5. Drifting Ghost (flying, ignores ground)

**Stage 1:**
```
A floating sheet-ghost creature with simple flowing fabric drape
forming the body, no visible feet, the cloth tapers to a wispy
tail at the bottom, two hollow round eye holes near the top, soft
translucent edges suggesting incorporeality, pale lavender-white
coloring, gentle drifting pose with the cloth slightly swept to
one side, late-1990s PlayStation / N64 era game art aesthetic, low-poly
faceted geometry, limited color palette, low-resolution baked
textures, no smooth shading, stylized anime JRPG sensibility, 3/4
front view, full body, neutral pose, white background, concept
turnaround sheet style
```

**Stage 2 (Meshy):**
```
Late-1990s PSX/N64-era low-poly ghost creature, flowing cloth body
shape, two hollow eye sockets, no limbs visible, wispy tapering
bottom, hovering pose, visibly faceted geometry, ~600-1200 triangle
target, flat shading (no smooth normals), low-resolution baked
texture atlas at 128x128 (soft translucent feel baked into the
baseColor as alpha or color variation), retro game-ready
```

**Variants:** `pale lavender-white` / `dusty teal` / `faint sulphur yellow`.

**Role:** flying — ignores ground collision, can pass terrain. 2 HP,
slower than bunnies but unblocked.

**Animation:** Path A (procedural). Unity MonoBehaviour bobs the
ghost vertically + drifts a slow Y-rotation so it feels haunted, not
mechanical. No rig in Meshy — there's no body to articulate.

---

### 6. Armored Beetle (mid-tier, ground)

**Stage 1:**
```
A stylized armored beetle creature with a glossy dome carapace,
two short curved horns on the head, six small legs in walking
stance (three per side), oversized head relative to body, simple
mandibles, low-detail wing case visible as a single seam down the
back, dark crimson coloring with brass-tone horns, viewed in 3/4
front perspective showing the head clearly, late-1990s PlayStation / N64 era game art aesthetic, low-poly
faceted geometry, limited color palette, low-resolution baked
textures, no smooth shading, stylized anime JRPG sensibility, 3/4
front view, full body, neutral pose, white background, concept
turnaround sheet style
```

**Stage 2 (Meshy):**
```
Late-1990s PSX/N64-era low-poly armored beetle, dome carapace, two
horns, six legs in walking stance, oversized head, visibly faceted
geometry (the carapace dome is a clear polygonal hemisphere), ~1000-1500
triangle target, flat shading (no smooth normals), low-resolution
baked texture atlas at 128x128 (glossy carapace highlight painted
into the baseColor), retro game-ready
```

**Variants:** `dark crimson + brass` / `obsidian black + silver` /
`forest green + gold`.

**Role:** mid-tier — 5 HP, normal speed, slight knockback resistance.

**Animation:** Path B (rigged). Enable Meshy auto-rig. Bundled clip:
`walking` (six-legged). Export as FBX. Unity Animator: single state
playing the walk clip on loop — server position handles movement,
the clip handles articulation.

---

### 7. Fluffy Chick (trash mob, weakest)

**Stage 1:**
```
A round fluffy baby bird creature with an oversized round head,
tiny vestigial wings tucked at the sides, two shiny black bead eyes,
a small triangular orange beak, short stick legs, standing upright
with a curious tilted-head pose, pale lemon yellow plumage, looks
innocent and harmless, exaggerated chibi proportions, late-1990s PlayStation / N64 era game art aesthetic, low-poly
faceted geometry, limited color palette, low-resolution baked
textures, no smooth shading, stylized anime JRPG sensibility, 3/4
front view, full body, neutral pose, white background, concept
turnaround sheet style
```

**Stage 2 (Meshy):**
```
Late-1990s PSX/N64-era low-poly chibi chick creature, round fluffy
body with oversized head, small triangular beak, tiny tucked wings,
short legs, curious upright standing pose, visibly faceted geometry,
~500-900 triangle target, flat shading (no smooth normals),
low-resolution baked texture atlas at 128x128, retro game-ready
```

**Variants:** `pale lemon` / `pale mint` / `pale peach`.

**Role:** trash mob — 1 HP, fastest enemy, spawns in clusters.

**Animation:** Path A (procedural). Unity MonoBehaviour bobs the
chick on a fast sine wave (suggests rapid little hops). Wings stay
static against the body.

---

### 8. Cartoon Bat (flying, evasive)

**Stage 1:**
```
A small cartoon bat creature with oversized round wings spread wide,
the wings have stylized membrane fold lines, big shining round eyes,
two tiny visible fangs in a small open mouth, fuzzy round body, two
small clawed feet tucked beneath, hovering pose with arms-out
wingspan, deep purple body with magenta wing membranes, late-1990s PlayStation / N64 era game art aesthetic, low-poly
faceted geometry, limited color palette, low-resolution baked
textures, no smooth shading, stylized anime JRPG sensibility, 3/4
front view, full body, neutral pose, white background, concept
turnaround sheet style
```

**Stage 2 (Meshy):**
```
Late-1990s PSX/N64-era low-poly bat monster, round body with
oversized spread wings, big shining eyes, two small fangs, hovering
pose with full wingspan, visibly faceted geometry (wings are flat
polygonal sheets), ~700-1200 triangle target, flat shading (no
smooth normals), low-resolution baked texture atlas at 128x128,
retro game-ready
```

**Variants:** `deep purple + magenta wings` / `midnight blue + cyan
wings` / `charcoal + crimson wings`.

**Role:** flying — fast, erratic horizontal movement, 2 HP.

**Animation:** Path B (rigged). Enable Meshy auto-rig. Bundled clip:
`flying` (wing flap). Export as FBX. Unity Animator: single state
playing the flap clip on loop. Wing flap is essential — procedural
won't fake it convincingly.

---

### 9. Skeleton Warrior (mid-tier, humanoid melee)

**Stage 1:**
```
A tall slender humanoid skeleton warrior with bone-white skeletal
body, hollow black eye sockets emitting a faint inner glow, exposed
ribcage and visible spine, wearing tattered cloth wraps around the
hips and shoulders and a single rusted iron pauldron on the right
shoulder, holding a simple curved short sword in the right hand,
standing in a neutral combat-ready pose with feet slightly apart,
classic undead silhouette, bone-white and rusty brown palette with
a faint amber eye glow, no excessive gore or horror, more cartoon-
spooky than realistic, late-1990s PlayStation / N64 era game art
aesthetic, low-poly faceted geometry, limited color palette,
low-resolution baked textures, no smooth shading, stylized anime
JRPG sensibility, 3/4 front view, full body, neutral pose, white
background, concept turnaround sheet style
```

**Stage 2 (Meshy):**
```
Late-1990s PSX/N64-era low-poly humanoid skeleton warrior,
bone-white skeletal body with hollow eye sockets, simplified
ribcage as a faceted cage shape, exposed spine, tattered cloth
wraps at hips and shoulders, single rusted iron pauldron on right
shoulder, short curved sword held in right hand, combat-ready
standing pose with feet slightly apart, visibly faceted geometry
(limbs are angular tubes, joints are clear polygonal hinges),
~1500-2500 triangle target, flat shading (no smooth normals),
low-resolution baked texture atlas at 128x128, retro game-ready
```

**Variants:**
- Weapon: `curved short sword` / `straight bone club` / `rusty cleaver`
  / `simple wooden spear`
- Eye glow: `faint amber` / `pale cyan` / `blood red` / `acid green`
- Armor accent: `rusted iron pauldron` / `mossy bronze pauldron` /
  `dark verdigris pauldron`

Combine modifiers for elite/named variants (e.g. "bone club + blood
red eyes + dark verdigris pauldron" reads as a stronger skeleton).

**Role:** mid-tier humanoid — 6 HP, normal speed, holds a weapon
(visual flair only — damage still resolves via current server-side
contact-damage system). Drops 2 gems on death. **Design intent:** the
skeleton is the visual foil to the Blademaster — both humanoid, but
one living-warrior and one undead-soldier. They should feel in
silhouette dialogue with each other.

**Animation:** Path B (rigged). Enable Meshy auto-rig. Bundled clips:
`idle`, `walk`, optionally `attack`. Export as FBX. Unity Animator:
1D BlendTree on `Speed` (same pattern as the Blademaster, M9 commit
`c29ea92`). If you include `attack`, fire it on contact via the
existing server `hit` event.

---

## Elite / mini-boss variant (any creature)

To create a beefed-up version of any of the above without designing
a new creature from scratch:

**Stage 1 modifier (append to base prompt):**
```
Hulking elite variant, twice the normal size, darker more saturated
color palette, glowing eyes, additional armor plating or thorny
spines added, more menacing stance, the silhouette is unmistakably
larger and more dangerous than the trash mob version
```

**Role:** elite — 25 HP, slower, drops a guaranteed item gem.

---

## After Stage 2 — Unity import workflow (PSX-tuned)

Same scaffolding as the M9 Blademaster pipeline (commit `541ae90`),
but with PSX-specific tightening at the texture and shading layers.

1. **Save the file** to `Monkey Punch/Assets/Art/Enemies/<creature>/`.
   - **Path A (procedural):** save as `<creature>.glb`.
   - **Path B (rigged):** save as `<creature>.fbx`.

2. **Import settings:**
   - **Path A (GLB, no rig):**
     - **Animation Type:** None.
     - **Generate Normals:** **Calculate** with **Smoothing Angle = 0**
       (faceted flat shading — the single biggest PSX-look lever at
       the mesh level).
     - **Generate Lightmap UVs:** off.
     - **Read/Write Enabled:** off.
   - **Path B (FBX, rigged):**
     - **Animation Type:** **Generic** (Humanoid only if the rig's
       bones map to Unity's standard humanoid skeleton — most Meshy
       auto-rigs produce non-standard bone names. Same fallback story
       as the M9 Blademaster).
     - **Avatar Definition:** Create From This Model.
     - **Import Animation:** ✓ on; enable **Loop Time** on locomotion
       clips (`walk`, `flying`, etc.).
     - **Generate Normals:** **Calculate** with **Smoothing Angle = 0**.
     - **Generate Lightmap UVs:** off.
     - **Optimize Game Objects:** off (lets you parent VFX to bones
       if needed later).

3. **Texture import settings** (per imported PNG/JPG — this is
   where PSX/N64 lives at the rendering layer):
   - **Filter Mode:** **Point (no filter)** — eliminates the bilinear
     blur that modern textures use; gives the chunky pixel look.
   - **Max Size:** **128** — caps the resolution to PSX-era atlas size.
     Even if Meshy exports at 1024×1024, Unity will downscale on
     import. This trumps Meshy's output resolution.
   - **Compression:** None or Low (point-filtered textures don't hide
     compression artifacts as well as filtered ones).
   - **Generate Mip Maps:** off (no mip maps was a PSX/N64 trait).
   - **sRGB:** on (these are color textures, not data maps).

4. **Extract materials** to `Assets/Art/Enemies/<creature>/Materials/`
   following the M9 pattern (commit `541ae90`).

5. **URP shader selection** — TWO choices:
   - **Quick path (good enough):** assign URP/Lit and let the flat-
     shaded normals + point-filtered textures carry the look.
   - **Full PSX path (best look, one-time setup):** install or write
     a custom URP shader that adds:
     - **Vertex snapping** (snap vertex screen positions to integer
       grid to produce the classic PSX wobble),
     - **Affine UV interpolation** (disable perspective-correct UVs
       per polygon for the texture warp wobble),
     - **No specular / posterized lighting** (flat or 2-band lighting).
     There's an open-source `URPPSXShader` GitHub repo that's a clean
     starting point; this is its own follow-up task documented in
     the Blademaster retrofit milestone (see below).

6. **Smart Remesh target** (in Meshy *before* export, to keep poly
   counts honest):
   - **Trash mobs** (slime, bunny, chick): **500–1200 triangles**
   - **Mid-tier** (mushroom, cocoon, beetle, ghost, bat, skeleton):
     **1000–2500 triangles**
   - **Elites:** **2000–4000 triangles**

   These are an order of magnitude lower than modern game targets —
   that's the point. PSX-era characters were typically 500–1500 tris;
   N64 mid-tier was 1000–3000 tris. The Smart Remesh slider gives you
   fine control.

7. **Create the prefab** under `Assets/Prefabs/Enemies/<creature>.prefab`.
   - **Path A:** root GameObject with the static MeshRenderer +
     procedural animator MonoBehaviour (e.g., `SlimeBob.cs`,
     `GhostFloat.cs` — one tiny script per creature, three to five
     lines each). The MonoBehaviour reads `Time.time` and writes
     `transform.localScale` / `transform.localPosition`.
   - **Path B:** root with the SkinnedMeshRenderer (Meshy auto-rigs
     usually skin) + Animator wired to a controller (single state
     for one-clip creatures like bat/beetle; 1D BlendTree for
     skeleton/mushroom matching the M9 pattern from commit `c29ea92`).

8. **Wire into NetworkClient** — extend `HandleEnemyAdd` to instantiate
   the right prefab based on `Enemy.kind` (currently a placeholder; this
   is its own future milestone).

---

## Pricing math

Assuming Midjourney Standard ($30/mo) + Meshy Pro ($30/mo):

- **Per concept image:** ~$0.03 effective cost (MJ generates ~1000
  images/month at standard rate).
- **Per 3D model:** depends on Meshy credit consumption; figure
  ~$1–2 in credits for a textured + remeshed model.
- **For all 9 enemies × 3 color variants × 3 concept rerolls:**
  - Concept art: ~81 images = ~$2.43
  - 3D models (4 × Path A static GLB at ~$1.50): ~$6
  - 3D models (5 × Path B rigged FBX at ~$2.25, ~50% premium for
    auto-rig + bundled clips): ~$11.25
  - Total: **~$20 in usage cost**, still well inside one month of
    Meshy Pro.

Cheaper if you only generate one variant per creature initially and
expand later, or if you use the free tier of either tool (with the
CC BY 4.0 attribution caveat for Meshy Free).

---

## Iteration discipline

Before generating, ALWAYS:
- Confirm you uploaded the Blademaster `--sref` (every prompt drifts
  without it).
- Generate 4 concept variants per creature, pick the best one, discard
  the others. Don't iterate on a 3D model from a weak concept.
- For Stage 2, **wait for Meshy's preview** before paying for the full
  textured + remeshed model. The preview is free credits; the polished
  output is paid.

After generating:
- **Side-by-side test** — drop all enemies into the SampleScene at the
  same scale near the Blademaster. Anything that doesn't visually
  agree with her gets re-generated, not "fixed" in Blender. The pipeline
  is cheap; cleanup is expensive.

---

## Follow-up milestone: Blademaster retrofit to PSX/N64

The Blademaster is **not currently PSX/N64**. She has smooth normals,
modern PBR maps, ~512-1024 px textures, and bilinear filtering. To
make the whole game cohesively retro, she'll need a separate retrofit
pass:

- **Re-import textures** with Point filter + Max Size 128 + no mipmaps
  (same settings as the enemy textures above).
- **Re-import FBX** with `Generate Normals: Calculate` + `Smoothing
  Angle = 0` — gives her flat-shaded faceted look matching the
  enemies.
- **(Optional) Swap shader** — from URP/Lit to a PSX shader (vertex
  snap + affine UVs + posterized lighting). One shader serves both
  player and enemies — write once, apply via the `Materials/`
  folder's `MAT_*.mat` files.
- **(Optional) Mesh decimation** in Blender if the silhouette still
  reads too smooth — target ~3000 tris for the full character body.

This is its own milestone — call it M10 "Retro Shader Pass" — and is
worth scheduling *after* generating 2-3 enemies, so the visual gap
between her current state and the enemies makes the retrofit
priorities clear (do textures + flat normals first; ship the
vertex-snap shader later if the cheaper changes already feel right).

Until then: enemies will look "more chunky-retro than the Blademaster."
That visual gap is expected and informs the retrofit scope.
