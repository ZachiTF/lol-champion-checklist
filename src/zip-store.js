// Minimal ZIP writer/reader for the "stored" (uncompressed) method only.
//
// Exists so the scan debugger can hand a whole recorded session over as ONE
// download — browsers block a page that fires dozens of separate downloads —
// without a library or a build step. PNGs are already compressed, so storing
// them loses nothing. The reader only has to understand zips this file wrote
// (scripts/import-recording.js unpacks them); anything else is rejected.
//
// Dual browser/Node like scan-core.js: top-level functions become globals in a
// classic <script>, and the module.exports tail serves require().

const ZIP_CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function zipCrc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++)
    c = ZIP_CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * files: [{ name: "dir/a.png", data: Uint8Array }] → Uint8Array of a .zip.
 * Names are UTF-8 (flag bit 11). No zip64, so the archive stays under 4 GB.
 */
function buildZip(files) {
  const enc = new TextEncoder();
  const entries = files.map((f) => ({
    name: enc.encode(f.name),
    data: f.data,
    crc: zipCrc32(f.data),
  }));
  let size = 22;
  for (const e of entries) size += 30 + 46 + 2 * e.name.length + e.data.length;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  let p = 0;
  const u16 = (v) => (dv.setUint16(p, v, true), (p += 2));
  const u32 = (v) => (dv.setUint32(p, v >>> 0, true), (p += 4));
  const bytes = (b) => (out.set(b, p), (p += b.length));

  for (const e of entries) {
    e.offset = p;
    u32(0x04034b50); // local file header
    u16(20); // version needed
    u16(0x0800); // UTF-8 names
    u16(0); // method: stored
    u16(0); // mod time
    u16(0x21); // mod date: 1980-01-01
    u32(e.crc);
    u32(e.data.length);
    u32(e.data.length);
    u16(e.name.length);
    u16(0);
    bytes(e.name);
    bytes(e.data);
  }
  const cdStart = p;
  for (const e of entries) {
    u32(0x02014b50); // central directory header
    u16(20); // version made by
    u16(20);
    u16(0x0800);
    u16(0);
    u16(0);
    u16(0x21);
    u32(e.crc);
    u32(e.data.length);
    u32(e.data.length);
    u16(e.name.length);
    u16(0); // extra
    u16(0); // comment
    u16(0); // disk
    u16(0); // internal attrs
    u32(0); // external attrs
    u32(e.offset);
    bytes(e.name);
  }
  const cdSize = p - cdStart;
  u32(0x06054b50); // end of central directory
  u16(0);
  u16(0);
  u16(entries.length);
  u16(entries.length);
  u32(cdSize);
  u32(cdStart);
  u16(0);
  return out;
}

/** Inverse of buildZip: Uint8Array → [{ name, data }]. Stored entries only. */
function readZip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--)
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error("not a zip (no end-of-directory record)");
  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const files = [];
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50)
      throw new Error("corrupt central directory");
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    if (method !== 0)
      throw new Error(`${name}: compressed entries are not supported`);
    const lName = dv.getUint16(off + 26, true);
    const lExtra = dv.getUint16(off + 28, true);
    const start = off + 30 + lName + lExtra;
    const data = buf.subarray(start, start + csize);
    if (zipCrc32(data) !== crc) throw new Error(`${name}: CRC mismatch`);
    files.push({ name, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

if (typeof module !== "undefined" && module.exports)
  module.exports = { buildZip, readZip, zipCrc32 };
