/* Минимальное чтение OSM PBF (https://wiki.openstreetmap.org/wiki/PBF_Format).
   readPbf(file, {node(id, lat, lon, tags), way(id, refs, tags), relation(id, members, tags), header(h)}).
   Теги разбираются только для элементов, у которых они есть; координаты — в градусах. */
import { openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import Pbf from 'pbf';

const td = new TextDecoder();

function readBlobHeader(pbf) {
  return pbf.readFields((tag, h, p) => {
    if (tag === 1) h.type = p.readString();
    else if (tag === 3) h.datasize = p.readVarint();
  }, { type: '', datasize: 0 });
}

function readBlob(pbf) {
  const b = pbf.readFields((tag, o, p) => {
    if (tag === 1) o.raw = p.readBytes();
    else if (tag === 3) o.zlib = p.readBytes();
  }, {});
  if (b.raw) return b.raw;
  if (b.zlib) return inflateSync(b.zlib);
  throw new Error('PBF: поддерживаются только raw и zlib блоки');
}

function readHeader(buf) {
  return new Pbf(buf).readFields((tag, h, p) => {
    if (tag === 32) h.timestamp = p.readVarint(true);
    else if (tag === 16) h.program = p.readString();
    else if (tag === 34) h.url = p.readString();
  }, {});
}

function tagsOf(keys, vals, st) {
  if (!keys.length) return null;
  const t = {};
  for (let i = 0; i < keys.length; i++) t[st[keys[i]]] = st[vals[i]];
  return t;
}

function readBlock(buf, h) {
  const pbf = new Pbf(buf);
  const st = [];
  const groups = [];
  let gran = 100, latOff = 0, lonOff = 0;
  pbf.readFields((tag, _, p) => {
    if (tag === 1) {
      const end = p.readVarint() + p.pos;
      while (p.pos < end) {
        const v = p.readVarint();
        if ((v >> 3) === 1) st.push(td.decode(p.readBytes()));
        else p.skip(v);
      }
    } else if (tag === 2) groups.push(p.readBytes());
    else if (tag === 17) gran = p.readVarint();
    else if (tag === 19) latOff = p.readVarint(true);
    else if (tag === 20) lonOff = p.readVarint(true);
  }, null);
  const coord = (off, v) => 1e-9 * (off + gran * v);

  for (const g of groups) {
    new Pbf(g).readFields((tag, _, p) => {
      if (tag === 2 && h.node) {
        /* DenseNodes */
        const d = p.readFields((t2, o, q) => {
          if (t2 === 1) q.readPackedSVarint(o.id);
          else if (t2 === 8) q.readPackedSVarint(o.lat);
          else if (t2 === 9) q.readPackedSVarint(o.lon);
          else if (t2 === 10) q.readPackedVarint(o.kv);
        }, { id: [], lat: [], lon: [], kv: [] }, p.readVarint() + p.pos);
        let id = 0, lat = 0, lon = 0, k = 0;
        for (let i = 0; i < d.id.length; i++) {
          id += d.id[i]; lat += d.lat[i]; lon += d.lon[i];
          let tags = null;
          if (d.kv.length) {
            while (d.kv[k] !== 0) { (tags || (tags = {}))[st[d.kv[k]]] = st[d.kv[k + 1]]; k += 2; }
            k++;
          }
          h.node(id, coord(latOff, lat), coord(lonOff, lon), tags);
        }
      } else if (tag === 1 && h.node) {
        const n = p.readFields((t2, o, q) => {
          if (t2 === 1) o.id = q.readSVarint();
          else if (t2 === 2) q.readPackedVarint(o.keys);
          else if (t2 === 3) q.readPackedVarint(o.vals);
          else if (t2 === 8) o.lat = q.readSVarint();
          else if (t2 === 9) o.lon = q.readSVarint();
        }, { id: 0, keys: [], vals: [], lat: 0, lon: 0 }, p.readVarint() + p.pos);
        h.node(n.id, coord(latOff, n.lat), coord(lonOff, n.lon), tagsOf(n.keys, n.vals, st));
      } else if (tag === 3 && h.way) {
        const w = p.readFields((t2, o, q) => {
          if (t2 === 1) o.id = q.readVarint(true);
          else if (t2 === 2) q.readPackedVarint(o.keys);
          else if (t2 === 3) q.readPackedVarint(o.vals);
          else if (t2 === 8) q.readPackedSVarint(o.refs);
        }, { id: 0, keys: [], vals: [], refs: [] }, p.readVarint() + p.pos);
        for (let i = 1; i < w.refs.length; i++) w.refs[i] += w.refs[i - 1];
        h.way(w.id, w.refs, tagsOf(w.keys, w.vals, st));
      } else if (tag === 4 && h.relation) {
        const r = p.readFields((t2, o, q) => {
          if (t2 === 1) o.id = q.readVarint(true);
          else if (t2 === 2) q.readPackedVarint(o.keys);
          else if (t2 === 3) q.readPackedVarint(o.vals);
          else if (t2 === 8) q.readPackedVarint(o.roles, true);
          else if (t2 === 9) q.readPackedSVarint(o.ids);
          else if (t2 === 10) q.readPackedVarint(o.types);
        }, { id: 0, keys: [], vals: [], roles: [], ids: [], types: [] }, p.readVarint() + p.pos);
        const members = [];
        let mid = 0;
        for (let i = 0; i < r.ids.length; i++) {
          mid += r.ids[i];
          members.push({ type: ['node', 'way', 'relation'][r.types[i]], ref: mid, role: st[r.roles[i]] || '' });
        }
        h.relation(r.id, members, tagsOf(r.keys, r.vals, st));
      }
    }, null);
  }
}

export function readPbf(file, h) {
  const fd = openSync(file, 'r');
  const size = fstatSync(fd).size;
  let pos = 0;
  const len4 = Buffer.alloc(4);
  try {
    while (pos < size) {
      readSync(fd, len4, 0, 4, pos); pos += 4;
      const hl = len4.readUInt32BE(0);
      const hb = Buffer.alloc(hl); readSync(fd, hb, 0, hl, pos); pos += hl;
      const bh = readBlobHeader(new Pbf(hb));
      const bb = Buffer.alloc(bh.datasize); readSync(fd, bb, 0, bh.datasize, pos); pos += bh.datasize;
      const data = readBlob(new Pbf(bb));
      if (bh.type === 'OSMHeader') { if (h.header) h.header(readHeader(data)); }
      else if (bh.type === 'OSMData') readBlock(data, h);
    }
  } finally { closeSync(fd); }
}
