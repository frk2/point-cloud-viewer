# Point Cloud Viewer

A public static Thing for opening `.ply` point clouds in the browser and
inspecting them in 3D. Files are read locally by the visitor's browser; nothing
is uploaded or stored.

## What it does

- Reads ASCII and binary (little- or big-endian) PLY in a Web Worker, in
  chunks, so large files don't freeze the page. It keeps x/y/z and, when
  present, red/green/blue (or r/g/b, diffuse_*). Points with non-finite
  coordinates are skipped and counted.
- Stores positions as float32 relative to the cloud's centroid (computed in
  double precision), so world coordinates far from zero stay precise.
- Shuffles the points once with a fixed seed. Every prefix is then a uniform
  sample, which lets the renderer draw fewer points while the camera moves
  if frames get slow ("Thin out while moving if slow").
- Draws everything with raw WebGL2 in one draw call and computes height
  colours in the shader. Frames render only when something changes.
- Starts with the camera origin at the centroid and the distance fitted
  exactly so every point is inside the window.
- Controls: point size, colour (file / height / X / Y / Z / single), round
  points, up axis, Iso/Top/Front/Side views, fit, reset, and the camera origin
  (typed coordinates, centroid, box centre, or double-click a point).

`public/samples/roi-world.ply` is a bundled sample scan (437,863 points),
published with the owner's approval.

## Files

- `public/ply.js`: streaming PLY reader (shared with the tests)
- `public/worker.js`: runs the reader off the main thread
- `public/camera.js`: orbit camera, view presets, exact fit
- `public/renderer.js`: WebGL2 point and origin-marker drawing
- `public/app.js`: UI, input handling, picking
- `test.mjs`: parser, precision, chunking, fit and page checks

## Verify and publish

```sh
./verify
git commit -am "..."
empty put . --json
```
