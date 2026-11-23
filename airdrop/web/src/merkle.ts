// The Merkle tree of a drop, built the same way as the contract checks it (../../src/merkle.rs).
//
// - A leaf is blake2b256(0x00 ‖ address ‖ amount): the address as the contract serializes it, a
//   tag byte (0x00 for `account-hash-…`, 0x01 for a contract package `hash-…`) and its 32 bytes,
//   then the amount as 32 bytes, big-endian.
// - A node is blake2b256(0x01 ‖ min(a, b) ‖ max(a, b)), its children compared as byte strings.
// - Leaves are taken in the order of the list; each level pairs its nodes in order, and a last
//   node without a partner moves up unchanged. A list of one entry has its leaf as the root.
// - A proof is the partner of the entry's node on each level that has one, from the leaves up.
//
// This file imports nothing but blake2b, so node runs it as it is (`npm run vector`), and the
// test vector it writes is checked by the Rust tests.
import { blake2b } from "@noble/hashes/blake2.js";

export type Hash = Uint8Array;

export interface Entry {
  /** A formatted key: `account-hash-…` or `hash-…`. */
  address: string;
  /** In the smallest unit of the token. */
  amount: bigint;
}

const LEAF_PREFIX = 0x00;
const NODE_PREFIX = 0x01;

const blake2b256 = (data: Uint8Array): Hash => blake2b(data, { dkLen: 32 });

export const toHex = (bytes: Uint8Array) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

function fromHex(hex: string): Uint8Array {
  if (!/^([0-9a-fA-F]{2})*$/.test(hex)) throw new Error(`Not hex: ${hex}`);
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
}

/** The 33 bytes of an address as the contract serializes it (`Address::to_bytes`). */
export function addressBytes(address: string): Uint8Array {
  const match = /^(account-hash|hash)-([0-9a-fA-F]{64})$/.exec(address);
  if (!match) throw new Error(`Not a formatted key: ${address}`);
  const bytes = new Uint8Array(33);
  bytes[0] = match[1] === "account-hash" ? 0 : 1;
  bytes.set(fromHex(match[2]), 1);
  return bytes;
}

function u256BigEndian(value: bigint): Uint8Array {
  if (value < 0n || value >= 1n << 256n) throw new Error(`Not a U256: ${value}`);
  const bytes = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}

export function leaf(entry: Entry): Hash {
  const preimage = new Uint8Array(66);
  preimage[0] = LEAF_PREFIX;
  preimage.set(addressBytes(entry.address), 1);
  preimage.set(u256BigEndian(entry.amount), 34);
  return blake2b256(preimage);
}

function compare(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export function node(a: Hash, b: Hash): Hash {
  const [first, second] = compare(a, b) <= 0 ? [a, b] : [b, a];
  const preimage = new Uint8Array(65);
  preimage[0] = NODE_PREFIX;
  preimage.set(first, 1);
  preimage.set(second, 33);
  return blake2b256(preimage);
}

export class Tree {
  /** From the leaves (first) to the root (last, one node). */
  private readonly levels: Hash[][];

  constructor(entries: Entry[]) {
    if (entries.length === 0) throw new Error("A tree needs at least one entry.");
    this.levels = [entries.map(leaf)];
    for (let level = this.levels[0]; level.length > 1;) {
      const next: Hash[] = [];
      for (let i = 0; i < level.length; i += 2) {
        next.push(i + 1 < level.length ? node(level[i], level[i + 1]) : level[i]);
      }
      this.levels.push(next);
      level = next;
    }
  }

  get root(): Hash {
    return this.levels[this.levels.length - 1][0];
  }

  /** The proof of the entry at `index`: its partner on each level that has one. */
  proof(index: number): Hash[] {
    const proof: Hash[] = [];
    let position = index;
    for (const level of this.levels.slice(0, -1)) {
      const partner = level[position ^ 1];
      if (partner) proof.push(partner);
      position >>= 1;
    }
    return proof;
  }

  /** The proof as the contract takes it: the nodes one after another, 32 bytes each. */
  proofBytes(index: number): Uint8Array {
    const proof = this.proof(index);
    const bytes = new Uint8Array(proof.length * 32);
    proof.forEach((hash, i) => bytes.set(hash, i * 32));
    return bytes;
  }
}

/** Whether `proof` leads from the leaf of `entry` to `root`, as the contract checks it. */
export function verify(root: Hash, entry: Entry, proof: Hash[]): boolean {
  return compare(proof.reduce(node, leaf(entry)), root) === 0;
}
