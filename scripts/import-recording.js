// Unpack a recorded scan session (the .zip scan-debug.html's "Export samples"
// downloads) into the dataset folder, ready for the report:
//
//   node scripts/import-recording.js ~/Downloads/scan-samples-*.zip
//   node scripts/import-recording.js <zip> --to=test/cases   # promote to tests
//   node scripts/scan-report.js --dir=test_data/recordings
//
// Default destination is test_data/recordings/ — gitignored, because a session
// is tens of full-resolution PNGs. That is the DATASET; test/cases/ is the
// regression suite, and only a few hand-picked frames belong there (every case
// there costs seconds on each commit). Each zip holds one folder per session,
// so imports never collide. Frames you didn't label are unpacked too but
// skipped by listCases() until someone labels them.
const fs = require("node:fs");
const path = require("node:path");
const { readZip } = require("../src/zip-store.js");
const { ROOT, boxesFromClient } = require("./case-set.js");

const argv = process.argv.slice(2);
const toArg = argv.find((a) => a.startsWith("--to="));
const dest = path.resolve(
  toArg ? toArg.slice(5) : path.join(ROOT, "test_data", "recordings"),
);
const zips = argv.filter((a) => !a.startsWith("--"));
if (!zips.length) {
  console.error("usage: node scripts/import-recording.js <zip>... [--to=dir]");
  process.exit(1);
}

for (const zip of zips) {
  const files = readZip(new Uint8Array(fs.readFileSync(zip)));
  let labelled = 0,
    frames = 0;
  for (const f of files) {
    // Never let an entry name climb out of the destination.
    const out = path.resolve(dest, f.name);
    if (!out.startsWith(dest + path.sep))
      throw new Error(`refusing entry outside destination: ${f.name}`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    let data = f.data;
    if (f.name.endsWith(".json")) {
      frames++;
      const j = JSON.parse(Buffer.from(f.data).toString("utf8"));
      if (j.labelled !== false) labelled++;
      // Labels from before boxes were stored carry only a rect: freeze it into
      // boxes now, with the template it was most likely labelled against.
      if (j.client && !j.boxes) {
        j.boxes = boxesFromClient(j.client);
        data = Buffer.from(JSON.stringify(j, null, 2) + "\n");
      }
    }
    fs.writeFileSync(out, data);
  }
  console.log(
    `${path.basename(zip)}: ${frames} frames (${labelled} labelled) → ${
      path.relative(ROOT, dest) || "."
    }`,
  );
}
