# Asset integration — scoping

A concrete plan for bringing external 3-D art into the sim, with effort,
the dependency question, and a recommendation. **Nothing here is
implemented yet** — the repo is 100% procedural meshes today.

## The one real blocker: it breaks the tiny-deps rule

The project's hard rule (memory: [[user-space-sim-preferences]]) is
zero runtime dependencies — hand-rolled WebGL2, procedural meshes, "fifty
lines over a dependency." Importing 3-D models means parsing a model
format, which is either a **new dependency** or a **non-trivial
hand-rolled parser**. That is the decision to make before any code; the
rest is mechanics.

## Sources (licenses verified July 2026)

| Source | License | Formats | Best for here |
|---|---|---|---|
| [Kenney](https://kenney.nl) | CC0 1.0 — no attribution required | OBJ, glTF, FBX (some DAE/STL) | Already the stylistic target; kits (space, blaster, cars) match the low-poly look |
| [Quaternius](https://quaternius.com) | CC0 | glTF, OBJ, FBX, some .blend | Aircraft, gear, nacelles; the [Ultimate Space Kit](https://sketchfab.com/3d-models/ultimate-space-kit-84c108ff2bcf4d4cbf2adff74a942822) and vehicle packs |
| [ambientCG](https://ambientcg.com) | CC0 | PNG/JPG PBR maps | Runway tarmac, painted metal — but needs textured/PBR shading we don't have |
| [Poly Haven](https://polyhaven.com) | CC0 | HDRI, glTF | HDRIs for sky lighting — needs an IBL pipeline we don't have |

All CC0 → no attribution file required. If any CC-BY asset is ever
wanted, it must be flagged and approved first (that's a standing rule).

## What the current renderer can and can't take

`src/gl/renderer.ts` today: one lighting shader, per-vertex position +
normal + optional color, indexed triangles, flat/simple lighting, **no
textures, no UVs, no materials, no tangent space**. So:

- **glTF/OBJ geometry (positions + normals + vertex colors)** drops
  straight into the existing `MeshData` path. This is the cheap win and
  covers Kenney/Quaternius low-poly kits, which are largely flat-colored.
- **PBR textures (ambientCG) and HDRIs (Poly Haven)** do NOT — they need
  UVs, texture sampling, and image loading added to the shader/renderer.
  Materially bigger, and against the "no textures" grain of the current
  design.

## Three options, by cost

**A. glTF-mesh loader, minimal (recommended first step).**
A ~150–250-line hand-rolled loader for **glTF 2.0 `.glb`** (binary) that
reads only what we render: `POSITION`, `NORMAL`, `COLOR_0`, indices, and
the node transforms. glTF accessors are just typed-array views into one
binary blob — no decompression, no external deps (unlike OBJ, which
needs `.mtl` parsing for color, or FBX, which is a proprietary binary
format needing a big library). Convert chosen kits to `.glb`, embed as
base64 or serve from `public/`, feed the parsed buffers into
`renderer.mesh()`. **Keeps zero runtime deps.** ~1 focused session.

**B. Same, but add a dependency.**
Use a maintained glTF loader (e.g. a small `@gltf-transform`/`three`
subset). Faster to write, handles edge cases (Draco compression,
skins/animation), but adds a runtime dependency and likely pulls in more
than "fifty lines" — a direct break of the tiny-deps rule. Only worth it
if we want rigged/animated models (walking crew, animated gear).

**C. Full textured/PBR + HDRI.**
Add UVs, texture upload, an image loader, and IBL for Poly Haven skies.
Biggest visual payoff (real tarmac, lit skies) but the largest change to
the renderer and the furthest from the current aesthetic. A multi-session
effort; I'd only do this if the look is a priority over the physics work.

## Recommendation

1. **Keep going procedural for now.** The starfield and the low-poly
   dogfight jets show how far procedural gets with zero cost. Immediate
   procedural wins still on the table: missile smoke trails, afterburner
   glow, a runway/base skyline, cloud layers, a day/night terminator.
2. **When models are wanted, do Option A** (hand-rolled `.glb` mesh
   loader, no dependency) and start with Quaternius aircraft for the
   dogfight jets and Kenney space kit for pad/base detail — geometry +
   vertex color only, which the current shader already lights.
3. **Defer Options B and C** unless animation or textured realism becomes
   a goal; both break tiny-deps and reshape the renderer.

This keeps the decision in your hands: Option A is the only one that
respects the zero-dep rule, and it's the natural next step if you want
real models. Say the word and I'll build the `.glb` loader and wire one
Quaternius jet into the dogfight as a proof of concept.

Sources: [Kenney](https://kenney.nl), [Kenney model import notes](https://kenney.nl/knowledge-base/game-assets-3d/importing-3d-models-into-game-engines), [Quaternius](https://quaternius.com/packs/universalanimationlibrary.html), [Quaternius Ultimate Space Kit](https://sketchfab.com/3d-models/ultimate-space-kit-84c108ff2bcf4d4cbf2adff74a942822), [ambientCG](https://ambientcg.com), [Poly Haven](https://polyhaven.com).
