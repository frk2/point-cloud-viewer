// Model Context Protocol endpoint (Streamable HTTP, JSON responses only).
// Tools act on one shared session, named by its session code.

import { StoreError } from './store.mjs';
import { OpError } from './ops.mjs';
import { VIEWS, COLOR_MODES, UP_AXES } from './service.mjs';
import { UNITS } from '../public/units.js';

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = `Point Cloud Viewer lets you inspect and edit a PLY point cloud that the user is looking at in their browser.
Work happens in a session, named by a 32-character session code. The user gets one by opening the viewer, loading a scan and choosing "Share with Claude"; ask them for it. You can also call create_session and give the user its viewer_link.
Sessions are temporary: the scan is deleted from the server after 2 hours without activity, after 24 hours at most, or when the session is ended.
Coordinates you send and receive are in millimetres when the file's units are known (see get_info: coordinate_unit), otherwise in the file's own units. Edits show up in the user's viewer immediately; undo with revert. Use screenshot to see what the user sees.`;

const vec3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };
const session = { type: 'string', description: 'The 32-character session code.' };
const box = {
  type: 'object',
  description: 'Optional axis-aligned box limiting which points are used.',
  properties: { min: vec3, max: vec3 },
  required: ['min', 'max'],
};
const tool = (name, description, properties = {}, required = [], annotations = {}) => ({
  name,
  description,
  inputSchema: { type: 'object', properties: { session, ...properties }, required: ['session', ...required], additionalProperties: false },
  annotations,
});
const readOnly = { readOnlyHint: true };

export const TOOLS = [
  {
    name: 'create_session',
    description: 'Start a new empty session. Returns its code, a viewer link to give the user, and a curl command for uploading a PLY file.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  tool('get_info', 'Point count, units, bounds, edit history, whether a viewer is open and what it is looking at, expiry time, and the export and upload commands.', {}, [], readOnly),
  tool('load_sample', 'Replace the session\'s scan with the bundled sample (a 437,863-point weld-area scan in metres).'),
  tool('set_units', 'Set the unit the file\'s coordinates are in. Lengths are then reported in millimetres.', {
    units: { type: 'string', enum: Object.keys(UNITS) },
  }, ['units']),
  tool('crop_box', 'Keep the points inside (or outside) an axis-aligned box.', {
    min: vec3, max: vec3, keep: { type: 'string', enum: ['inside', 'outside'], default: 'inside' },
  }, ['min', 'max']),
  tool('crop_sphere', 'Keep the points inside (or outside) a sphere.', {
    center: vec3, radius: { type: 'number', exclusiveMinimum: 0 }, keep: { type: 'string', enum: ['inside', 'outside'], default: 'inside' },
  }, ['center', 'radius']),
  tool('crop_plane', 'Keep the points on one side of a plane: "front" is the side the normal points to.', {
    point: vec3, normal: vec3, keep: { type: 'string', enum: ['front', 'back'], default: 'front' },
  }, ['point', 'normal']),
  tool('remove_sparse', 'Remove stray points: drop every point with fewer than min_neighbors other points within radius.', {
    radius: { type: 'number', exclusiveMinimum: 0 }, min_neighbors: { type: 'integer', minimum: 1, maximum: 1000 },
  }, ['radius', 'min_neighbors']),
  tool('downsample', 'Reduce the point count: "voxel" keeps one point per cube of voxel_size; "random" keeps count random points.', {
    method: { type: 'string', enum: ['voxel', 'random'] }, voxel_size: { type: 'number', exclusiveMinimum: 0 }, count: { type: 'integer', minimum: 1 },
  }, ['method']),
  tool('transform', 'Move the points. Either give a 4x4 matrix (rows; translation in the last column), or any of scale, rotate_deg (about X, then Y, then Z) around pivot (default: the centroid), then translate.', {
    matrix: { type: 'array', items: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 }, minItems: 4, maxItems: 4 },
    scale: { type: 'number', exclusiveMinimum: 0 },
    rotate_deg: vec3,
    pivot: { description: '"centroid" or [x, y, z].', anyOf: [{ type: 'string', enum: ['centroid'] }, vec3] },
    translate: vec3,
  }),
  tool('revert', 'Undo the last edit, or go back to the original upload.', {
    to: { type: 'string', enum: ['previous', 'original'], default: 'previous' },
  }),
  tool('stats', 'Count, centroid, bounds and principal axes of the points (optionally within a box). plane_normal and plane_rms describe the best-fit plane.', { box }, [], readOnly),
  tool('histogram', 'Count points along an axis ("x", "y", "z" or a direction), optionally within a box. Useful for finding surfaces and layers.', {
    axis: { anyOf: [{ type: 'string', enum: ['x', 'y', 'z'] }, vec3], default: 'z' }, bins: { type: 'integer', minimum: 1, maximum: 200, default: 50 }, box,
  }, [], readOnly),
  tool('sample_points', 'A random sample of point coordinates (and colours), optionally within a box.', {
    count: { type: 'integer', minimum: 1, maximum: 5000, default: 500 }, box,
  }, [], readOnly),
  tool('set_view', 'Change what the user\'s viewer shows: camera origin (the point the view turns around), view direction, zoom (above 1 zooms in), fit, reset, point size, colour mode and up axis.', {
    origin: vec3,
    view: { type: 'string', enum: VIEWS },
    zoom: { type: 'number', exclusiveMinimum: 0 },
    fit: { type: 'boolean' },
    reset: { type: 'boolean' },
    point_size: { type: 'number', minimum: 1, maximum: 16 },
    color_mode: { type: 'string', enum: COLOR_MODES },
    up_axis: { type: 'string', enum: UP_AXES },
  }),
  tool('screenshot', 'A picture of the user\'s viewer as it is now. Needs the viewer to be open.', {}, [], readOnly),
  tool('end_session', 'End the session now and delete its scan from the server.', {}, [], { destructiveHint: true }),
];

const ok = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 1) }] });
const fail = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

async function callTool(name, args, ctx) {
  const { service, store, baseUrl, sample } = ctx;
  if (name === 'create_session') {
    const token = store.create();
    return ok(service.info(store.find(token), baseUrl, token));
  }
  const s = store.find(args.session);
  if (!s) return fail('Unknown or expired session code. Sessions end after 2 hours without activity.');
  store.touch(s);
  const { session: token, ...rest } = args;
  switch (name) {
    case 'get_info': return ok(service.info(s, baseUrl, token));
    case 'load_sample': {
      const meta = await service.loadBytes(s, await sample(), 'roi-world.ply');
      return ok({ loaded: 'roi-world.ply', points: meta.count, file_units: s.units });
    }
    case 'set_units': return ok(service.setUnits(s, rest.units));
    case 'revert': return ok(await service.revert(s, rest.to ?? 'previous'));
    case 'set_view': return ok(service.setView(s, rest));
    case 'end_session': service.end(s); return ok({ ended: true });
    case 'screenshot': {
      const img = await service.screenshot(s);
      return {
        content: [
          { type: 'image', data: img.data.toString('base64'), mimeType: img.mimeType },
          { type: 'text', text: JSON.stringify({ viewer: service.live(s).viewer, coordinate_unit: service.coordinateUnit(s) }) },
        ],
      };
    }
    case 'stats':
    case 'histogram':
    case 'sample_points':
      return ok(await service.query(s, name, rest));
    default:
      if (service.EDITS.includes(name)) return ok(await service.edit(s, name, rest));
      return fail(`Unknown tool ${name}.`);
  }
}

// Handles one JSON-RPC message; returns the response, or null for a notification.
export async function handleRpc(msg, ctx) {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const error = (code, message) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return error(-32600, 'Invalid request.');
  if (msg.id === undefined) return null;
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'point-cloud-viewer', title: 'Point Cloud Viewer', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS });
    case 'tools/call': {
      const { name, arguments: args = {} } = msg.params ?? {};
      if (name !== 'create_session' && !TOOLS.some((t) => t.name === name)) return error(-32602, `Unknown tool ${name}.`);
      try {
        return reply(await callTool(name, args ?? {}, ctx));
      } catch (err) {
        if (err instanceof StoreError || err instanceof OpError) return reply(fail(err.message));
        console.error(err);
        return reply(fail('The tool failed unexpectedly.'));
      }
    }
    default: return error(-32601, `Method ${msg.method} not found.`);
  }
}
