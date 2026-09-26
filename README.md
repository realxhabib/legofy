# Legofy

Turn any photo or 3D model into a real LEGO build: watch it go together brick by brick, remove the bits you
don't want, download step-by-step instructions, and order every piece.

## How people use it

1. **Start with something:**
   - **A photo:** drop it in (JPEG, PNG or an iPhone HEIC) and press **Generate 3D model**. The AI models
     the whole object, back included, in about a minute.
   - **A 3D model:** drop in a GLB, OBJ (with its `.mtl` and texture), PLY, STL or USDZ, for example a scan
     exported from Scaniverse, Polycam or KIRI Engine. Apple's binary USDZ can't be read by browsers yet.
     If it comes in lying on its side, change **Which way is up?**.
2. **Remove parts:** **✂ Remove parts** under the build. Tap bricks to delete a ball of them (S / M / L),
   **Keep main part** deletes everything not attached to the biggest piece (stray bits), and there's Undo
   and Reset. Deletions are kept in the model's own proportions, so they survive changing the size.
3. **Adjust:** size (longest side, 12–320 studs), **Keep text & fine detail** (see below), build order,
   hollow, 1×1s only.
4. **Get the pieces:**
   - **🛒 Buy the parts** copies the parts list as a BrickLink Wanted List and opens BrickLink's upload page
     (sign in, paste, add to a Wanted List, then **Easy Buy** finds shops that have everything). If the
     clipboard isn't allowed, the list downloads as an XML file instead. Each row in the parts list also
     links to that part in that colour on BrickLink.
   - **📘 Instructions (PDF):** cover, parts inventory and one step per layer (see below).
   - **Parts list:** CSV in Rebrickable's import format; **PNG:** a picture of the view.

## Run it

A static page with no build step. Serve the folder:

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

Libraries (three.js, jsPDF, libheif) come from the jsDelivr CDN. Photo → 3D needs the server function,
so it only works on the Vercel deployment.

## Deploy on Vercel

Import the repo in Vercel with no build command and `/` as the output directory. The `api/` folder
becomes the serverless function.

**Photo → 3D model** uses Hunyuan3D v2 on fal.ai through `api/generate-3d.js`. Visitors never see the
provider's name, and the key never reaches the browser. The function holds the key, only accepts requests
from the site itself, and uses the provider's queue so slow generations don't hit the function's time
limit. To turn it on, create a key at fal.ai, then in Vercel open **Settings → Environment Variables**,
add `FAL_KEY` and redeploy. Each generation costs about $0.48 (textured, since the bricks take their
colours from it) and anyone who can open the site can start one, so set a spending limit with the
provider. Payments can gate this later (see Stripe below).

## Build checks

Every build is checked and repaired so it can really be built (`src/buildcheck.js`). Pieces only
connect through studs: each piece joins the pieces in the layers directly above and below that overlap
it; pieces side by side in one layer aren't joined. From that graph:

- **Tiling that bonds:** each layer is tiled like a brick wall: a piece scores for bridging a joint
  underneath and loses points for ending right above one, so walls don't split into separate towers.
- **A shell that holds:** hollow models keep every piece that touches the outside along a face or an
  edge (so a cap stays attached to its stem and curved walls stay continuous), and roofs and overhangs
  are two layers thick so their joints cross.
- **Loose parts get tied on:** a part that doesn't connect to the main one gets hidden supports: a
  two-stud column through the solid inside, up or down to the main part. If there's no inside route,
  a stud on the other side of a side-by-side seam takes the part's colour and one piece straddles it.
  Specks of up to 4 pieces that still can't attach are left out; anything bigger is reported, with
  **Show** and **Remove them**.
- **Every step buildable:** the chosen build order is kept, but a piece with nothing under it yet
  waits and goes in right after the piece above it, clipped on underneath (the steps say so).
- **Stands up:** the centre of mass must be over the bottom layer's footprint, or it's flagged with
  **Add a baseplate**. **Build on a baseplate** picks real Light Bluish Gray baseplates (16×16 3867,
  16×32 3857, 32×32 3811, 48×48 4186) that fit, and adds them to the parts list.
- **Weak spots:** joints held by a single stud that carry a group of pieces are listed, with **Show**.
- It also counts stud connections and checks that no two pieces overlap. The result is on the page and
  on the instructions' cover.

## Stripe (to do)

`Legofy.manualAccess` in `src/app.js` decides who may download the instructions; it currently allows
everyone. Return `{ allowed: false, message }` for visitors who haven't paid (e.g. after checking a Stripe
Checkout session) and the download is refused with that message.

## Instruction manual

The PDF is made in the browser (A4): a cover with a render and the piece count and size, a parts
inventory with part numbers, and one layer per step, two steps per page. Each step shows a 3D view with
the new pieces bright and earlier ones faded, a top-down plan of the layer with a FRONT marker, and the
pieces it needs.

## Keeping text readable

**Detail → Keep text & fine detail** builds from plates (a third of a brick tall, so three times the
vertical resolution), reads textures at up to 2048 px, and bumps the size to at least 96 studs, since a
letter only reads once it is several studs tall. Switching back to Normal restores the previous size.
It's a lot of pieces, so turn up the build speed.

## Real LEGO pieces only

- Parts are standard bricks and plates (1×1 up to 2×8), each with its official part number
  (e.g. 3001 = Brick 2 × 4, 3020 = Plate 2 × 4).
- `src/parts-data.js`, generated from [Rebrickable's database downloads](https://rebrickable.com/downloads/),
  lists which footprints LEGO has actually made in each of the 38 colours, and the tiler only uses those.
  Every colour exists as a 1×1, so any shape can still be built.
- `src/palette.js` carries each colour's Rebrickable and BrickLink ids, for the CSV and the BrickLink list.

The baseplate in the 3D view is only for display.

## At real size

**How many at real size?** takes a real-world height and works out the brick count, dimensions, weight,
cost and build time at that size. The **life-size Starship** sample (the full ~123 m Block 2 stack)
comes out around 11 million bricks.

## How it works

1. **Voxels:** every triangle of the model is sampled densely; each sample takes its colour from the
   texture, vertex colours or material, matched to the nearest LEGO colour in CIE Lab, and each voxel keeps
   the colour most of its samples agree on. The closed interior is filled.
2. **Edits:** the user's deletions are replayed on the voxels (the voxelized model is cached, so edits
   rebuild quickly).
3. **Bricks:** the solid is sliced into layers, hollowed like real brick sculptures, and each layer is
   tiled with the largest real pieces made in that colour, alternating direction each layer so bricks
   overlap the joints below.
4. **Build:** bricks drop onto a baseplate layer by layer. Play, pause, step, scrub and change the speed
   (1–1000 bricks/s); while paused the next brick's spot glows. Drag to orbit, scroll to zoom, right-drag
   to pan; **⟲ View** brings the auto camera back.

Keyboard: `Space` play/pause, `←`/`→` step, `Home`/`End` restart/finish.

## Files

- `src/palette.js`: LEGO colours (with Rebrickable and BrickLink ids) and sRGB → Lab
- `src/parts-data.js`: which parts exist in which colours (from Rebrickable)
- `src/sculpt.js`: voxels → bricks (hollowing, bonded tiling, build order), parts list
- `src/buildcheck.js`: build checks and repairs, baseplates
- `src/voxelize.js`: 3D model → coloured voxels, plus the toadstool and Starship samples
- `src/heic.js`: HEIC photo decoding
- `src/scene3d.js`: three.js scene (instanced bricks and studs, drop animation, camera, picking)
- `src/manual.js`: the PDF instruction manual
- `src/app.js`: UI, photo → 3D, removing parts, playback, buying and exports
- `api/generate-3d.js`: Vercel function for photo → 3D model
