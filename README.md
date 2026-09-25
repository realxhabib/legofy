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

## Scan a real object in the browser

Tap **Scan a real object** on a phone, tap the object on screen, and walk slowly around it. There's
no app, no marker and no upload: everything runs on the phone.

- **Where's the camera?** The phone's motion sensors (DeviceOrientation) give its orientation. Because the
  user keeps the object in view at a steady distance (a dashed guide frame shows the size to keep), the
  camera sits on the ray through the object's silhouette, and that pins down its position.
- **What's the object?** MediaPipe's on-device interactive segmenter cuts it out of each frame. After the
  first tap it's prompted with a scribble down the middle of the shape carved so far, so it keeps
  selecting the whole object rather than one part.
- **Mapping:** each captured view (a new one every ~7° of movement) carves away the voxels it sees background
  through, a "visual hull" that updates live in the preview. A voxel only goes if at least two views agree.
  Views whose cut-out misses much of the known shape, or that run off the frame, are skipped. The space
  hidden under the object is trimmed using the estimated tabletop height.
- **Colors:** each surface voxel takes the majority LEGO color from the frames that face it most directly,
  using only pixels well inside the cut-out.

Limits: the object needs to stand out from its background. Hollows and dents (the inside of a bowl)
fill in. Needs https (Vercel is fine) and camera plus motion permission. iOS asks for motion access
when you tap Scan.

## 3D scans from other apps

Already have a scan from Scaniverse, Polycam, KIRI Engine or similar? Export it as **GLB** (or OBJ with
its `.mtl` and texture, PLY, STL) and drop it on the page. Apple's binary USDZ files can't be read by
browsers yet. If a model comes in lying on its side, change **Which way is up?**.

Every triangle is sampled densely, each sample takes its color from the texture, vertex colors or material,
and each voxel keeps the LEGO color most of its samples agree on. The closed interior is filled, and then
it's hollowed and tiled into bricks just like an image.

## At real size

Under the settings, **At real size** takes a real-world height and works out what it would take to build
the thing full size: brick count, dimensions, weight, cost and build time. For heights up to twice
the model it scales this build directly. Beyond that it assumes a sturdy hollow shell 2 studs thick made of
2×4 bricks, so the count grows with surface area (or with volume when **Hollow** is off). The
**life-size Starship** sample (the full ~121 m stack) comes out around 11 million bricks.

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
- `src/scan.js`: walk-around scanning (camera, motion sensors, segmentation, visual-hull carving)
- `src/voxelize.js`: 3D model → colored voxel volume, plus the sample toadstool
- `src/scene3d.js`: three.js scene (instanced bricks and studs, baseplate, lighting, drop animation, camera)
- `src/app.js`: UI, input handling, playback loop
