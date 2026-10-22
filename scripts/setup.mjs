// Vendors the Meterless open engines (Apache-2.0) into vendor/ (gitignored).
import { execSync } from "node:child_process";
import fs from "node:fs";
const sh = (c) => execSync(c, { stdio: "inherit" });
for (const [dir, src] of [["vendor/hmem", "meterless/meterless/engines/hmem/reference#1742dec56a66e58eef9dda2d2b865823758ca8cd"], ["vendor/world-model", "meterless/meterless/engines/world-model/reference#1742dec56a66e58eef9dda2d2b865823758ca8cd"]]) {
  if (!fs.existsSync(`${dir}/src/index.ts`)) sh(`npx --yes degit ${src} ${dir}`);
  sh(`cd ${dir} && npm install --no-audit --no-fund --silent`);
}
console.log("Meterless engines ready: H-MEM + World Model");
