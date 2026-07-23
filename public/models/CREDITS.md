# Model credits

## jet.glb

- **Source:** "Spitfire" from the *Ultimate Spaceships* pack by
  **Quaternius** (quaternius.com).
- **License:** CC0 1.0 (public domain) — no attribution required; this
  note is courtesy. Verified on the OpenGameArt release page
  (opengameart.org/content/lowpoly-spaceships-pack) and quaternius.com.
- **Processing:** the pack ships OBJ/FBX/Blend (no glTF); the OBJ was
  converted to binary glTF with `scripts/obj2glb.cjs` (a build-time
  script, not a runtime dependency) — geometry only (positions +
  normals), no textures, so the renderer tints it per team.

## hangar_largeA.glb, satelliteDish_large.glb, structure_detailed.glb, hangar_roundA.glb

- **Source:** the **Space Kit** by **Kenney** (kenney.nl) — base
  structures used at the Meridian dogfight base (hangars, a control-block
  girder structure, a satellite dish).
- **License:** CC0 1.0 (from the pack's License.txt: "Creative Commons
  Zero, CC0") — no attribution required.
- **Processing:** none — the Space Kit ships binary glTF, loaded directly
  by `src/gl/glb.ts`. These models colour their parts with material
  `baseColorFactor`s (not vertex colours); the loader bakes that flat
  colour per-part (still no textures).

Only CC0 art is used. Any future CC-BY asset must be flagged and approved
first, with its attribution recorded here.
