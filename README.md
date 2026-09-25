# Legofy

Drop in an image or a 3D scan and watch it get built as a LEGO sculpture, one brick at a time.

Live site: <https://realxhabib.github.io/legofy/> (once GitHub Pages is enabled, see below).

## Run it

It's a static page with no build step. Open `index.html` directly or serve the folder:

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

three.js is loaded from the jsDelivr CDN, so you need to be online the first time.

## Put it on the web

Everything runs in the browser: images and scans never leave the visitor's device, and there's no server.
Any static host works.

- **GitHub Pages (free):** in the repo, open *Settings → Pages*, set *Source* to *Deploy from a branch*,
  pick the branch and `/ (root)`, and save. After a minute it's live at `https://realxhabib.github.io/legofy/`.
  The `.nojekyll` file tells Pages to serve the files as-is.
- **Netlify / Cloudflare Pages / Vercel:** connect the repo with no build command and `/` as the output
  directory, or drag the folder onto Netlify Drop.

## 3D scans from an iPhone

Websites can't use the iPhone's LiDAR camera directly, so capture with a scanning app and drop the result in:

1. Scan the object with an app such as Scaniverse, Polycam or KIRI Engine (or Apple's Object Capture in
   Reality Composer), walking slowly all the way around it.
2. Process it as a mesh, crop away the floor, and export **GLB**. OBJ works too if you pick its `.mtl` and
   texture files along with it. PLY (mesh or colored point cloud) and STL also load.
3. Open the site on the phone and choose the file, or AirDrop it to a computer and drop it on the page.

Apple's binary USDZ files can't be read by browsers yet, so prefer GLB. If a model comes in lying on its
side, change **Which way is up?**.

The scan is scaled so its longest side matches **Size**. Every triangle is sampled densely, each sample takes
its color from the texture, vertex colors or material, and each voxel keeps the LEGO color most of its samples
agree on. The closed interior is filled, and then it's hollowed and tiled into bricks just like an image.

## How it works

1. **Input:** drag an image anywhere on the page, click the drop zone, or paste from the clipboard.
   Works best with one subject on a plain or transparent background (a logo, a cartoon, a product shot).
   The steps below are for images. 3D scans skip steps 2–3 (see above).
2. **Cut-out:** transparent pixels are dropped, and a plain background is detected from the image border and
   flood-filled away. Empty margins are trimmed so the subject stands on the baseplate.
3. **Inflation:** the silhouette is puffed up into a rounded solid. How thick each pixel gets depends on how
   far it is from the edge, following a sphere profile, so a disc becomes a ball and thin parts stay slim.
   **Thickness** controls how chunky it is (0% gives a flat brick wall).
4. **Colors:** each stud is matched to the nearest of ~38 real LEGO colors in CIE Lab space. Anti-aliased
   in-between colors along edges are snapped to the neighboring color they came from.
5. **Bricks:** the solid is sliced into layers (one brick tall), made hollow like real brick sculptures, and each
   layer is tiled with 1×1 up to 2×8 bricks of the same color. The preferred brick direction alternates
   each layer so bricks overlap the joints below.
6. **Build:** bricks drop onto a baseplate layer by layer from the bottom (back to front, zigzag, outside in,
   center out, or random within a layer). The camera slowly orbits and rises with the build. Drag to orbit,
   scroll to zoom, right-drag to pan; **⟲ View** brings the auto camera back.
7. **Following along:** you can play or pause, step forward and back, scrub the timeline, and change the speed
   (1–1000 bricks/s). While paused, the next brick's spot glows and the caption names it.
8. **Parts list:** shows bricks by color and size, with live progress. Export it as CSV, or save a PNG of the view.

Keyboard: `Space` play/pause, `←`/`→` step, `Home`/`End` restart/finish.

## Files

- `src/palette.js`: LEGO color palette plus the sRGB → Lab conversion
- `src/sculpt.js`: resize, background removal, quantize, inflate to 3D, hollow, tile layers into bricks, build order, parts list
- `src/voxelize.js`: 3D model → colored voxel volume, plus the sample toadstool
- `src/scene3d.js`: three.js scene (instanced bricks and studs, baseplate, lighting, drop animation, camera)
- `src/app.js`: UI, input handling, playback loop
