# Point Cloud Viewer

A public EmptyOS service for opening `.ply` point clouds in the browser,
inspecting them in 3D at real-world scale, and letting Claude work on them
through MCP.

Live at https://point-cloud-viewer.faraz.emptyos.com/ (source:
https://github.com/frk2/point-cloud-viewer).

## Viewing (all in the browser)

Opening a file reads it in a Web Worker. Nothing is uploaded unless the
visitor chooses **Share with Claude**.

- ASCII and binary (little- or big-endian) PLY. It keeps x/y/z and, when
  present, red/green/blue. Non-finite points are skipped and counted.
- Positions are float32 offsets from a double-precision centroid, so world
  coordinates far from zero stay precise. Points are shuffled with a fixed
  seed, so any prefix is a uniform sample. The renderer uses this to thin out
  while the camera moves if frames are slow.
- Raw WebGL2, one draw call, height colours computed in the shader.
- Starts with the origin at the centroid and the cloud fitted to the window.
- Point size, colour mode, round points, up axis, Iso/Top/Front/Side, fit,
  reset, and camera origin (typed, centroid, box centre, or double-click).
- **Scale:** PLY has no unit field. The unit is read from a header comment
  (`comment units mm`) when one names it. Otherwise it is guessed from the
  cloud's size (under 50 units across means metres, else millimetres), and the
  visitor can change it. Sizes and coordinates are then shown in mm, with a
  scale bar that is true at the depth of the camera origin.

## Sharing with Claude

**Share with Claude** uploads the open file to a temporary session and shows
a 32-character session code. Claude uses the MCP endpoint at `/mcp`
(Streamable HTTP, no sign-in):

```sh
claude mcp add --transport http point-cloud https://point-cloud-viewer.faraz.emptyos.com/mcp
```

Then tell Claude: "Use the point-cloud tools with session <code>." Claude can
also start a session itself (`create_session`) and give the visitor a
`/#session=<code>` link.

Tools: `get_info`, `load_sample`, `set_units`, `crop_box`, `crop_sphere`,
`crop_plane`, `remove_sparse`, `downsample` (voxel or random), `transform`
(matrix, or scale/rotate/translate), `revert` (previous or original), `stats`
(bounds, principal axes, best-fit plane), `histogram`, `sample_points`,
`set_view` (origin, view, zoom, fit, point size, colour, up axis),
`screenshot`, `end_session`. Coordinates are in millimetres when the file's
unit is known.

The page long-polls the session. It downloads each new version Claude makes
(keeping the camera where it is), applies view commands, and answers
screenshot requests by rendering a frame and posting a JPEG.

### Session storage and limits

- Each session's upload and versions live in the `point-cloud-viewer-data`
  Database, chunked in SQLite, keyed by the SHA-256 of the session code.
- A session and everything in it is deleted 2 hours after its last use (by
  the page or Claude), 24 hours after it was created at the latest, or when
  ended. A sweep runs every minute.
- The original upload plus the last three versions are kept for undo.
- Limits: 10,000,000 points and 1 GiB per shared file, 40 sessions, 4 GiB
  in total. One heavy job runs at a time, which keeps the service under its
  1 GiB memory limit.
- The session code is the only key: whoever has it can edit and download that
  scan. Codes are 128-bit random and are never listed.

### HTTP API (used by the page; handy with curl)

All `/api/session/*` requests take `Authorization: Bearer <code>`.

- `POST /api/sessions`: new session
- `PUT /api/session/ply?offset=&total=&name=`: upload a PLY, whole or in
  ordered chunks (`curl -T scan.ply`)
- `GET /api/session/state[?since=&wait=1]`: state, long-polled
- `GET /api/session/cloud?kind=positions|colors&version=`: raw arrays
- `GET /api/session/export.ply`: current version as binary PLY
- `POST /api/session/units`, `/viewer`, `/screenshot?rid=`; `DELETE /api/session`

## Files

- `server.mjs`: HTTP server, static files, routes
- `lib/store.mjs`: SQLite session storage and expiry
- `lib/service.mjs`: sessions, uploads, edits, view sync, screenshots
- `lib/ops.mjs`: point operations
- `lib/mcp.mjs`: MCP endpoint and tool definitions
- `public/`: the viewer (`ply.js` and `units.js` are shared with the server)
- `test.mjs`, `test-server.mjs`: offline checks run by `./verify`

## Change and publish

This folder is a bound `empty clone`, with GitHub as the `github` remote.

```sh
./verify
git commit -am "..."
empty put . --json
git push github main
```
