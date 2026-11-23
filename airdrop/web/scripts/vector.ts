// Writes ../resources/merkle_vector.json: a list, its leaves, proofs and root, computed with the
// tree code of the app (src/merkle.ts). The Rust tests (src/merkle.rs) build the same tree and
// compare, so the page and the contract cannot drift apart. `--check` fails if the file differs.
import { readFileSync, writeFileSync } from "node:fs";
import { leaf, toHex, Tree, verify, type Entry } from "../src/merkle.ts";

const list: Entry[] = [
  {
    address: "account-hash-2ccbc1dd4b1d1e7a3bc8c9cbbd2d1dd4fc4ef8b84ea6c1b4ea72a41f1e9c11c1",
    amount: 25_000_000_000n,
  },
  { address: "hash-0fafe6f2e4481d7c2e1b3d031a3634dc37189d2ff9c97d064b6a203d4b47ffe4", amount: 1n },
  {
    address: "account-hash-0000000000000000000000000000000000000000000000000000000000000000",
    amount: 10_500_000_000n,
  },
  {
    address: "account-hash-ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    amount: (1n << 256n) - 1n,
  },
  {
    address: "account-hash-a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    amount: 4_000_000_000n,
  },
];

const tree = new Tree(list);
for (const [index, entry] of list.entries()) {
  if (!verify(tree.root, entry, tree.proof(index))) throw new Error(`The proof of entry ${index} fails.`);
}
const vector = {
  about: "Written by `npm run vector` in web/ from src/merkle.ts; checked by the tests of src/merkle.rs.",
  list: list.map((entry, index) => ({
    address: entry.address,
    amount: entry.amount.toString(),
    leaf: toHex(leaf(entry)),
    proof: tree.proof(index).map(toHex),
  })),
  root: toHex(tree.root),
};

const target = new URL("../../resources/merkle_vector.json", import.meta.url);
const text = JSON.stringify(vector, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== text) {
    throw new Error("resources/merkle_vector.json differs from what src/merkle.ts computes.");
  }
  console.log(`The test vector matches src/merkle.ts (root ${vector.root}).`);
} else {
  writeFileSync(target, text);
  console.log(`Wrote resources/merkle_vector.json (root ${vector.root}).`);
}
