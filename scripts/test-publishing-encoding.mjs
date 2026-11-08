import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const source = readFileSync(new URL("./publish-approved-project.mjs", import.meta.url), "utf8");
const statement = source.match(/t=json\.loads\(sys\.stdin\.buffer\.read\(\)\.decode\('utf-8'\)\)/)?.[0];
assert.ok(statement, "Production input must decode explicit UTF-8");
const target = { description: "ค้างคาว ไฟกระพริบ ตกแต่งให้คืน ฮัลโลวีน 🦇", hashtags: ["สร้างสรรค์", "ไฟกระพริบ", "halloween", "ของตกแต่งห้อง"], price: "450.00" };
for (const encoding of ["cp1252", "cp874", "utf-8"]) {
  const result = spawnSync("python", ["-c", `import sys,json; ${statement}; print(json.dumps(t))`], { env: { ...process.env, PYTHONIOENCODING: encoding }, input: JSON.stringify(target), encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, "Python must exit successfully");
  assert.deepEqual(JSON.parse(result.stdout), target, `Thai/emoji must survive ${encoding} default stdin`);
}
console.log("PASS: production stdin decoder preserves Thai, hashtags and emoji under cp1252/cp874/UTF-8; no external calls");
