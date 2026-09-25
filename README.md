# Legofy

Drop in an image and watch it get built in 3D, one LEGO brick at a time.

## Run it

It's a static page with no build step. Open `index.html` directly or serve the folder:

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

three.js is loaded from the jsDelivr CDN, so you need to be online the first time.

## How it works

1. **Input:** drag an image anywhere on the page, click the drop zone, or paste from the clipboard.
2. **Color matching:** the image is downscaled so each stud is one pixel wide and one brick tall
   (bricks are 9.6mm tall and 8mm wide). Each pixel is matched to the nearest of ~38 real LEGO colors in CIE Lab space.
   Transparent areas stay empty and empty margins are trimmed, so a cut-out subject stands on its own.
3. **Tiling:** each row is split into 1×8, 1×6, 1×4, 1×3, 1×2 and 1×1 bricks. Joints are staggered
   against the row below, the way a real wall is built, so it would actually hold together.
4. **3D build:** bricks drop onto a baseplate row by row from the bottom. The order within each row can be
   left to right, zigzag, center outward, or random. At slower speeds (up to 30 bricks/s) the camera
   follows the brick being placed. Faster than that, it frames the whole wall.
   Drag to orbit, scroll to zoom, right-drag to pan (this stops the auto camera; **⟲ View** brings it back).
5. **Following along:** you can play or pause, step forward and back, scrub the timeline, and change the speed
   (1–1000 bricks/s). While paused, the next brick's spot glows and the caption says which brick goes where.
6. **Parts list:** shows bricks by color and length, with live progress. Export it as CSV, or save a PNG of the view.

Keyboard: `Space` play/pause, `←`/`→` step, `Home`/`End` restart/finish.

## Files

- `src/palette.js`: LEGO color palette plus the sRGB → Lab conversion
- `src/mosaic.js`: resize, quantize, crop, tile rows into staggered bricks, build order, parts list
- `src/scene3d.js`: three.js scene (instanced bricks and studs, baseplate, lighting, drop animation, camera)
- `src/app.js`: UI, input handling, playback loop
