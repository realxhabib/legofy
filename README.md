# Legofy

Drop in an image and watch it get rebuilt as a LEGO mosaic, one brick at a time.

## Run it

It's a static page with no dependencies and no build step. Either open `index.html` directly, or serve the folder:

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

## How it works

1. **Input:** drag an image anywhere on the page, click the drop zone, or paste from the clipboard.
2. **Color matching:** the image is downscaled to the chosen stud width and each stud is matched to the
   nearest of ~38 real LEGO plate colors in CIE Lab space. Optional error-diffusion dithering helps photos.
   Transparent pixels are left empty so the baseplate shows through.
3. **Tiling:** same-color regions are covered greedily with the largest plates that fit
   (2×8 down to 1×1), or 1×1s only if you prefer.
4. **Build:** plates drop onto the baseplate in the chosen order (bottom→top, top→bottom, one color at a
   time, center-out, or random). You can play or pause, step forward and back, scrub the timeline, and
   change the speed (1–1000 plates/s). While paused, the next plate's spot is outlined so you can follow
   along with real bricks.
5. **Parts list:** shows plates by color and size, with live placed/total progress. Export it as CSV,
   or export the finished mosaic as PNG.

Keyboard: `Space` play/pause, `←`/`→` step, `Home`/`End` restart/finish.

## Files

- `src/palette.js`: LEGO color palette plus the sRGB → Lab conversion
- `src/mosaic.js`: resize, quantize, tile into plates, build order, parts list
- `src/renderer.js`: canvas drawing of baseplate, plates and studs, and the drop animation
- `src/app.js`: UI, input handling, playback loop
