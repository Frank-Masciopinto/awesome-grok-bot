import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputs = ["docs/catalog-index.json", "docs/index.html", "docs/sitemap.xml", "docs/robots.txt", "llms.txt"];
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "generated-catalog-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ["scripts", "docs", "catalog.json", "llms.txt"]) {
    cpSync(join(root, name), join(dir, name), { recursive: true });
  }
  return {
    read: (name) => readFileSync(join(dir, name), "utf8"),
    write: (name, text) => writeFileSync(join(dir, name), text),
    run: (...args) => spawnSync(process.execPath, [join(dir, "scripts/build-pages-index.mjs"), ...args], { encoding: "utf8" }),
  };
}

test("generated catalog check accepts the current catalog without writing files", (t) => {
  const f = fixture(t);
  const before = outputs.map(f.read);
  const result = f.run("--check");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(outputs.map(f.read), before);
});

test("generated catalog check detects stale outputs and build repairs them idempotently", (t) => {
  const f = fixture(t);
  const catalog = JSON.parse(f.read("catalog.json"));
  const raw = catalog.entries.find((entry) => entry.shelf === "raw");
  const rawCount = catalog.entries.filter((entry) => entry.shelf === "raw").length;
  // Reproduce a nine-row addition while hand-maintained llms totals are updated,
  // but its raw shelf count and generated Pages files are accidentally omitted.
  for (let i = 0; i < 9; i++) {
    catalog.entries.push({ ...raw, slug: `regression-fixture-${i}`, name: `Regression fixture ${i}`,
      import: `https://x.ai/bot/regression-fixture-${i}`, verified: false });
  }
  f.write("catalog.json", JSON.stringify(catalog));
  f.write("llms.txt", f.read("llms.txt").replace(/^> \d+ live/m, `> ${catalog.entries.length} live`)
    .replace(/^\d+ live shares/m, `${catalog.entries.length} live shares`));
  const before = outputs.map(f.read);
  const stale = f.run("--check");
  assert.equal(stale.status, 1, stale.stderr);
  for (const path of ["docs/catalog-index.json", "docs/index.html", "llms.txt"]) assert.ok(stale.stderr.includes(path), stale.stderr);
  assert.deepEqual(outputs.map(f.read), before, "check mode must not repair files");
  assert.equal(f.run().status, 0);
  assert.equal(f.run("--check").status, 0);
  assert.ok(f.read("llms.txt").includes(`raw ${rawCount + 9} —`));
  assert.equal(JSON.parse(f.read("docs/catalog-index.json")).count, catalog.entries.length);
  assert.ok(f.read("docs/index.html").includes("Regression fixture 8"));
  const built = outputs.map(f.read);
  assert.equal(f.run().status, 0);
  assert.deepEqual(outputs.map(f.read), built);
});

test("each generated output is checked independently", (t) => {
  const f = fixture(t);
  for (const path of outputs) {
    const original = f.read(path);
    const corrupted = path === "docs/index.html"
      ? original.replace(/(<strong id="count">)[^<]*/, "$199999")
      : path === "llms.txt" ? original.replace(/raw \d+/, "raw 99999") : original + "\n";
    assert.notEqual(corrupted, original);
    f.write(path, corrupted);
    const result = f.run("--check");
    assert.equal(result.status, 1, path);
    assert.ok(result.stderr.includes(path), result.stderr);
    assert.equal(f.read(path), corrupted);
    f.write(path, original);
  }
});

test("a missing llms count line fails before writing any generated output", (t) => {
  const f = fixture(t);
  f.write("llms.txt", f.read("llms.txt").replace(/^Shelf \(editorial\):.*\n/m, ""));
  const before = outputs.map(f.read);
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /llms.txt: missing generated count line/);
  assert.deepEqual(outputs.map(f.read), before);
});
