// The recorder's export format: scan-debug.html zips a session in the browser,
// scripts/import-recording.js unpacks it here. Both ends are src/zip-store.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildZip, readZip, zipCrc32 } = require("../src/zip-store.js");

test("crc32 matches the standard check value", () => {
  assert.equal(zipCrc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("buildZip → readZip round-trips names and bytes", () => {
  const files = [
    {
      name: "rec-1/000.png",
      data: Uint8Array.from({ length: 5000 }, (_, i) => i * 7),
    },
    {
      name: "rec-1/000.json",
      data: new TextEncoder().encode('{"labelled":false}\n'),
    },
    { name: "rec-1/ünïcode.json", data: new Uint8Array(0) },
  ];
  const back = readZip(buildZip(files));
  assert.deepEqual(
    back.map((f) => f.name),
    files.map((f) => f.name),
  );
  back.forEach((f, i) => assert.deepEqual([...f.data], [...files[i].data]));
});

test("readZip refuses a corrupted entry", () => {
  const zip = buildZip([{ name: "a", data: new Uint8Array([1, 2, 3]) }]);
  zip[30 + 1] ^= 0xff; // flip a data byte (local header is 30 bytes + name)
  assert.throws(() => readZip(zip), /CRC/);
});
