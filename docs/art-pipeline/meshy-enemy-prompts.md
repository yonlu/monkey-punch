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

## Style anchor (paste into every Stage 1 prompt)

```
stylized low-poly anime JRPG character art, cel-shaded with subtle
gradient, clean readable silhouette, flat base color textures, soft
pastel + vivid accent palette, 3/4 front view, full body, white
background, concept turnaround sheet style
```

For Midjourney, append:
```
--style raw --ar 1:1 --v 7 --sref <your-uploaded-blademaster-image>
```

### Negative directives (Stage 1)

These belong in a "negative prompt" field if your tool has one
(Leonardo, SD); for MJ/ChatGPT, fold them inline ("not realistic,
not photorealistic..."):

```
no photorealism, no anime closeup, no portrait crop, no detailed
PBR roughness, no scene background, no other characters, no text,
no watermark, no perspective distortion, no extreme low angle
```

---

## Enemy roster (8 starters + variants)

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
inner core visible through the gel, [STYLE ANCHOR]
```

**Stage 2 (Meshy):**
```
Stylized low-poly slime creature, rounded squashed sphere body,
single highlight on top suggesting wet gloss, two bead eyes,
PBR-ready, clean topology, game-optimized for real-time rendering
```

**Variants:** swap "translucent rose pink" → `deep cobalt blue` /
`vivid emerald green` / `pale gold` for color rerolls without re-generating
the mesh.

**Role:** trash mob — 1 HP, dies in one hit, spawns in groups of 5-8.

---

### 2. Hopping Bunny (trash mob, fast)

**Stage 1:**
```
A tiny round forest rabbit creature with oversized head and tiny
body, large innocent dark eyes, short stubby legs, fluffy round tail,
sitting upright in alert pose, exaggerated chibi proportions,
soft pastel cream coloring with pink ear interiors, no fierce
features, looks innocent rather than threatening, [STYLE ANCHOR]
```

**Stage 2 (Meshy):**
```
Stylized chibi rabbit creature, oversized round head, small upright
body, fluffy tail, stubby legs, neutral standing pose facing forward,
clean low-poly topology, game-ready PBR maps
```

**Variants:** `pastel cream + pink` / `light gray + blue` / `pale brown + amber`.

**Role:** trash mob — 1 HP, 1.5× movement speed.

---

### 3. Walking Mushroom (mid-tier, melee)

**Stage 1:**
```
A small upright mushroom creature with a wide rounded cap and a
short fat stem, the cap is rich red with simple white circular spots,
two tiny dot eyes embedded in the stem, no arms, two stubby legs
visible beneath the cap edge, no mouth, neutral standing pose,
silhouette resembles an umbrella with feet, [STYLE ANCHOR]
```

**Stage 2 (Meshy):**
```
Stylized cartoon mushroom monster, large round red cap with white
spots, short stem body, two stubby legs, two simple eye dots on
stem, standing upright pose, clean low-poly geometry, full PBR
material set
```

**Variants:** `rich red cap with white spots` / `dark violet cap with
yellow spots` / `forest green cap with cream spots`.

**Role:** mid-tier — 3 HP, normal speed, drops gem on death.

---

### 4. Cocoon Larva (mid-tier, slow)

**Stage 1:**
```
A smooth egg-shaped insect cocoon, slightly elongated vertically,
covered in stylized silk wrapping patterns that suggest layered
threads, two closed half-moon eye slits near the top suggesting it
is sleeping or dormant, no limbs, no mouth, sitting on its rounded
base, monochrome golden silk coloring with subtle highlights,
[STYLE ANCHOR]
```

**Stage 2 (Meshy):**
```
Stylized cocoon monster, egg-shaped body with silk wrap texture,
two closed eye slits, no limbs, dormant standing pose, low-poly
clean topology, PBR-ready
```

**Variants:** `golden silk` / `pale jade silk` / `dusty rose silk`.

**Role:** mid-tier — 4 HP, 0.7× movement speed, denser swarms.

---

### 5. Drifting Ghost (flying, ignores ground)

**Stage 1:**
```
A floating sheet-ghost creature with simple flowing fabric drape
forming the body, no visible feet, the cloth tapers to a wispy
tail at the bottom, two hollow round eye holes near the top, soft
translucent edges suggesting incorporeality, pale lavender-white
coloring, gentle drifting pose with the cloth slightly swept to
one side, [STYLE ANCHOR]
```

**Stage 2 (Meshy):**
```
Stylized floating ghost creature, flowing cloth body shape, two
hollow eye sockets, no limbs visible, wispy tapering bottom,
hovering pose, clean low-poly geometry, soft translucent feel
preserved in baseColor, PBR-compatible
```

**Variants:** `pale lavender-white` / `dusty teal` / `faint sulphur yellow`.

**Role:** flying — ignores ground collision, can pass terrain. 2 HP,
slower than bunnies but unblocked.

---

### 6. Armored Beetle (mid-tier, ground)

**Stage 1:**
```
A stylized armored beetle creature with a glossy dome carapace,
two short curved horns on the head, six small legs in walking
stance (three per side), oversized head relative to body, simple
mandibles, low-detail wing case visible as a single seam down the
back, dark crimson coloring with brass-tone horns, viewed in 3/4
front perspective showing the head clearly, [STYLE ANCHOR]
```

**Stage 2 (Meshy):**
```
Stylized low-poly armored beetle, dome carapace, two horns, six
legs in walking stance, oversized head, clean game topology, full
PBR maps preserving glossy carapace highlight
```

**Variants:** `dark crimson + brass` / `obsidian black + silver` /
`forest green + gold`.

**Role:** mid-tier — 5 HP, normal speed, slight knockback resistance.

---

### 7. Fluffy Chick (trash mob, weakest)

**Stage 1:**
```
A round fluffy baby bird creature with an oversized round head,
tiny vestigial wings tucked at the sides, two shiny black bead eyes,
a small triangular orange beak, short stick legs, standing upright
with a curious tilted-head pose, pale lemon yellow plumage, looks
innocent and harmless, exaggerated chibi proportions, [STYLE ANCHOR]
```

**Stage 2 (Meshy):**
```
Stylized chibi chick creature, round fluffy body with oversized
head, small triangular beak, tiny tucked wings, short legs, curious
upright standing pose, clean low-poly, PBR-ready
```

**Variants:** `pale lemon` / `pale mint` / `pale peach`.

**Role:** trash mob — 1 HP, fastest enemy, spawns in clusters.

---

### 8. Cartoon Bat (flying, evasive)

**Stage 1:**
```
A small cartoon bat creature with oversized round wings spread wide,
the wings have stylized membrane fold lines, big shining round eyes,
two tiny visible fangs in a small open mouth, fuzzy round body, two
small clawed feet tucked beneath, hovering pose with arms-out
wingspan, deep purple body with magenta wing membranes, [STYLE ANCHOR]
```

**Stage 2 (Meshy):**
```
Stylized cartoon bat monster, round body with oversized spread
wings, big shining eyes, two small fangs, hovering pose with full
wingspan, clean low-poly mesh, PBR materials
```

**Variants:** `deep purple + magenta wings` / `midnight blue + cyan
wings` / `charcoal + crimson wings`.

**Role:** flying — fast, erratic horizontal movement, 2 HP.

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

## After Stage 2 — Unity import workflow

Identical to the M9 Blademaster pipeline (commit `541ae90`):

1. **Save the GLB** to `Monkey Punch/Assets/Art/Enemies/<creature>/<creature>.glb`.
2. **Unity imports** — set Animation Type to **None** (these are
   static meshes, no rig). Generate Normals: Calculate. Generate
   Lightmap UVs: off (URP doesn't lightmap dynamic enemies).
3. **Extract materials** to `Assets/Art/Enemies/<creature>/Materials/`
   following the M9 pattern.
4. **Verify URP shader** — Meshy's PBR maps slot into URP/Lit's
   `_BaseMap`, `_MetallicGlossMap`, `_BumpMap`. Re-link if any are missing.
5. **Smart Remesh target** (in Meshy before export): **3000-5000 tris**
   for trash mobs, **5000-8000** for mid-tier, **10000-15000** for
   elites.
6. **Create the prefab** under `Assets/Prefabs/Enemies/<creature>.prefab`.
   Single child GameObject with the static MeshRenderer; no animator,
   no script (the existing `NetworkClient.HandleEnemyAdd` code drives
   the transform).
7. **Wire into NetworkClient** — extend `HandleEnemyAdd` to instantiate
   the right prefab based on `Enemy.kind` (currently a placeholder; this
   is its own future milestone).

---

## Pricing math

Assuming Midjourney Standard ($30/mo) + Meshy Pro ($30/mo):

- **Per concept image:** ~$0.03 effective cost (MJ generates ~1000
  images/month at standard rate).
- **Per 3D model:** depends on Meshy credit consumption; figure
  ~$1–2 in credits for a textured + remeshed model.
- **For all 8 enemies × 3 color variants × 3 concept rerolls:**
  - Concept art: ~72 images = ~$2.16
  - 3D models: 8 meshes × ~$1.50 = ~$12 (color variants share the mesh)
  - Total: **~$14 in usage cost**, well under the monthly subscription.

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
