# Legofy

Drop in an image and watch it get built as a 3D LEGO sculpture, one brick at a time.

## Run it

It's a static page with no build step. Open `index.html` directly or serve the folder:

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

three.js is loaded from the jsDelivr CDN, so you need to be online the first time.

## How it works

1. **Input:** drag an image anywhere on the page, click the drop zone, or paste from the clipboard.
   Works best with one subject on a plain or transparent background (a logo, a cartoon, a product shot).
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
- `src/scene3d.js`: three.js scene (instanced bricks and studs, baseplate, lighting, drop animation, camera)
- `src/app.js`: UI, input handling, playback loop
