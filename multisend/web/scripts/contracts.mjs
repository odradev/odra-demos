// Writes src/contracts.json, the file the app reads contract addresses from, out of the
// contracts file the CLI wrote when it deployed: ../resources/<chain>-contracts.toml.
import { readFileSync, writeFileSync } from "node:fs";

const chain = process.argv[2] ?? "casper-test";
const source = new URL(`../../resources/${chain}-contracts.toml`, import.meta.url);
const target = new URL("../src/contracts.json", import.meta.url);

const toml = readFileSync(source, "utf8");
const lastUpdated = /^last_updated\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
// One `[[contracts]]` table per contract; only its name and package hash are needed.
const contracts = toml
  .split("[[contracts]]")
  .slice(1)
  .map((table) => ({
    name: /^name\s*=\s*"([^"]+)"/m.exec(table)?.[1],
    package_hash: /^package_hash\s*=\s*"([^"]+)"/m.exec(table)?.[1],
  }))
  .filter((contract) => contract.name && contract.package_hash);
if (contracts.length === 0) {
  throw new Error(`No contracts found in ${source.pathname}`);
}

writeFileSync(target, JSON.stringify({ last_updated: lastUpdated, contracts }, null, 2) + "\n");
console.log(`Wrote ${contracts.length} contracts of ${chain} to src/contracts.json`);
