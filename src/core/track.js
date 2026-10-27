/* Километровые метки, GPX и проверка загруженной зоны. */
import { hav, px, py, distToSegment } from './geo.js';

/* ---------- километровые метки ---------- */
function kmMarkers(coords, stepM) {
  var out = [];
  if (coords.length < 2 || !(stepM > 0)) return out;
  var acc = 0, next = stepM;
  for (var i = 1; i < coords.length; i++) {
    var a = coords[i - 1], b = coords[i];
    var seg = hav(a[0], a[1], b[0], b[1]);
    while (seg > 0 && acc + seg >= next - 1e-9) {
      var t = (next - acc) / seg;
      out.push({
        km: next / 1000,
        lat: a[0] + (b[0] - a[0]) * t,
        lon: a[1] + (b[1] - a[1]) * t,
        index: i
      });
      next += stepM;
    }
    acc += seg;
  }
  return out;
}

function fmtKm(km) {
  var s = (Math.round(km * 100) / 100).toString().replace('.', ',');
  return s;
}

/* ---------- GPX ---------- */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function toGPX(o) {
  var lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<gpx version="1.1" creator="rundom" xmlns="http://www.topografix.com/GPX/1/1">');
  lines.push('  <metadata><name>' + esc(o.name || 'Маршрут') + '</name><time>' + new Date().toISOString() + '</time></metadata>');
  (o.waypoints || []).forEach(function (w) {
    lines.push('  <wpt lat="' + w.lat.toFixed(6) + '" lon="' + w.lon.toFixed(6) + '"><name>' + esc(w.name) + '</name>' +
      (w.desc ? '<desc>' + esc(w.desc) + '</desc>' : '') + '</wpt>');
  });
  lines.push('  <trk>');
  lines.push('    <name>' + esc(o.name || 'Маршрут') + '</name>');
  if (o.desc) lines.push('    <desc>' + esc(o.desc) + '</desc>');
  lines.push('    <trkseg>');
  o.coords.forEach(function (p) {
    lines.push('      <trkpt lat="' + p[0].toFixed(6) + '" lon="' + p[1].toFixed(6) + '"></trkpt>');
  });
  lines.push('    </trkseg>');
  lines.push('  </trk>');
  lines.push('</gpx>');
  return lines.join('\n');
}

function attr(tag, name) {
  var m = new RegExp('\\b' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')').exec(tag);
  return m ? (m[2] !== undefined ? m[2] : m[3]) : null;
}
function unesc(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function parseGPX(text) {
  var tracks = [], waypoints = [], name = '';
  var mn = /<metadata[^>]*>[\s\S]*?<name>([\s\S]*?)<\/name>/.exec(text) || /<trk[^>]*>[\s\S]*?<name>([\s\S]*?)<\/name>/.exec(text);
  if (mn) name = unesc(mn[1]).trim();
  var ptRe = /<(trkpt|rtept)\b([^>]*?)\/?>/g;
  var segRe = /<(trkseg|rte)\b[^>]*>([\s\S]*?)<\/\1>/g;
  var sm;
  while ((sm = segRe.exec(text))) {
    var pts = [], pm;
    ptRe.lastIndex = 0;
    while ((pm = ptRe.exec(sm[2]))) {
      var la = parseFloat(attr(pm[2], 'lat')), lo = parseFloat(attr(pm[2], 'lon'));
      if (isFinite(la) && isFinite(lo)) pts.push([la, lo]);
    }
    if (pts.length > 1) tracks.push(pts);
  }
  var wRe = /<wpt\b([^>]*)>([\s\S]*?)<\/wpt>/g, wm;
  while ((wm = wRe.exec(text))) {
    var wl = parseFloat(attr(wm[1], 'lat')), wo = parseFloat(attr(wm[1], 'lon'));
    var nn = /<name>([\s\S]*?)<\/name>/.exec(wm[2]);
    if (isFinite(wl) && isFinite(wo)) waypoints.push({ lat: wl, lon: wo, name: nn ? unesc(nn[1]).trim() : '' });
  }
  return { name: name, tracks: tracks, waypoints: waypoints };
}

/* зона, уже загруженная ранее, покрывает новую? (стадион вокруг отрезка) */
function regionContains(old, nw) {
  if (!old) return false;
  function d(p) {
    return distToSegment(px(p[1]), py(p[0]), px(old.A[1]), py(old.A[0]), px(old.B[1]), py(old.B[0]));
  }
  return d(nw.A) + nw.R <= old.R && d(nw.B) + nw.R <= old.R;
}

export { kmMarkers, fmtKm, toGPX, parseGPX, regionContains };
