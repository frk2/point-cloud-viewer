// PLY has no unit field: coordinates are bare numbers. Some writers note the
// unit in a comment, so look there first and otherwise guess from the size.

export const UNITS = {
  m: { label: 'Metres', mm: 1000 },
  cm: { label: 'Centimetres', mm: 10 },
  mm: { label: 'Millimetres', mm: 1 },
  in: { label: 'Inches', mm: 25.4 },
  ft: { label: 'Feet', mm: 304.8 },
  none: { label: 'Unknown (no scale)', mm: null },
};

const WORDS = [
  [/^(mm|millimet(er|re)s?)$/, 'mm'],
  [/^(cm|centimet(er|re)s?)$/, 'cm'],
  [/^(m|met(er|re)s?)$/, 'm'],
  [/^(in|inch|inches)$/, 'in'],
  [/^(ft|foot|feet)$/, 'ft'],
];

function unitWord(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  for (const [re, unit] of WORDS) if (re.test(w)) return unit;
  return null;
}

// Returns { unit, source } where source is 'comment' or 'size'.
export function guessUnits(comments, extent) {
  for (const c of comments) {
    const m = /\bunits?\b\s*[:=]?\s*([A-Za-z]+)/i.exec(c);
    const unit = m && unitWord(m[1]);
    if (unit) return { unit, source: 'comment' };
  }
  // Scans in metres are rarely over a few dozen units across; scans in
  // millimetres rarely under that.
  return { unit: extent > 0 && extent < 50 ? 'm' : 'mm', source: 'size' };
}

// A 1/2/5 x 10^k length close to `target`.
export function niceLength(target) {
  const p = 10 ** Math.floor(Math.log10(target));
  const f = target / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}

// Rounds away floating-point noise from 1/2/5 x 10^k numbers.
function clean(v) {
  return String(Number(v.toPrecision(12)));
}

export function formatLength(mm) {
  if (mm >= 1000) return `${clean(mm / 1000)} m`;
  if (mm >= 1) return `${clean(mm)} mm`;
  return `${clean(mm * 1000)} µm`;
}
