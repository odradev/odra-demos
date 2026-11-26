// CSPR.name names of accounts, an extra: the page works the same when none can be read.
//
// The registry is on the testnet, which has no CSPR.name of its own. An account has the same
// account hash on both networks, so the names are read from the mainnet, from the storage of the
// CSPR.name contracts, the way their own entry points compute them
// (github.com/odradev/cspr-name-contracts). Nothing is asked of any API:
//
//   account -> name   ReverseResolver.primary_names[account] gives a name, which counts only if
//                     it resolves back to the same account.
//   name -> account   NameToken.token.metadata[id] gives the token's resolver and expiration;
//                     DefaultResolver.nonces[id] and .resolutions[id:name:nonce] give the account.
//
// The id of a name is the blake2b-256 hash of its last label, read as a big-endian number.
import { blake2b } from "@noble/hashes/blake2.js";
import { ContractStorage, formattedKey, Node } from "./storage";
import nameTokenSchema from "./names/name_token_schema.json";
import resolverSchema from "./names/default_resolver_schema.json";
import reverseSchema from "./names/reverse_resolver_schema.json";

const MAINNET_RPC_URL = "https://mainnet-rpc.odra.dev";
const NAME_TOKEN = "hash-50d4d8cfff221e0084c461de81adfec06f04c6601cf4419ea56b9dc823f45488";
const RESOLVER = "hash-2c41427f79cc69456a9ad38e8cb379cb0f1084f17c467b17ccb389346fd2c139";
const REVERSE_RESOLVER = "hash-925a459eeaa286736dd1f1d3887f0e5c5e73c0329ec664ce55043374dca20e85";

const NAME = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+cspr$/;

export const looksLikeName = (text: string) => NAME.test(text.trim().toLowerCase());

interface Contracts {
  token: ContractStorage;
  resolver: ContractStorage;
  reverse: ContractStorage;
}

let opened: Promise<Contracts> | null = null;
const forward = new Map<string, Promise<string | null>>();
const reverse = new Map<string, Promise<string | null>>();

function contracts(): Promise<Contracts> {
  if (!opened) {
    const node = new Node(MAINNET_RPC_URL);
    opened = Promise.all([
      ContractStorage.open(node, nameTokenSchema, NAME_TOKEN),
      ContractStorage.open(node, resolverSchema, RESOLVER),
      ContractStorage.open(node, reverseSchema, REVERSE_RESOLVER),
    ]).then(([token, resolver, reverse]) => ({ token, resolver, reverse }));
    // A failure is not kept: the next read tries again.
    opened.catch(() => (opened = null));
  }
  return opened;
}

/** The account (`account-hash-…`) a name points at, or `null` if it points at nothing. */
export function resolveName(name: string): Promise<string | null> {
  const wanted = name.trim().toLowerCase();
  let found = forward.get(wanted);
  if (!found) {
    found = readForward(wanted);
    found.catch(() => forward.delete(wanted));
    forward.set(wanted, found);
  }
  return found;
}

/** The primary name of an account, or `null` if it has none or it cannot be read. Never fails. */
export function nameOf(account: string): Promise<string | null> {
  let found = reverse.get(account);
  if (!found) {
    found = readReverse(account).catch(() => {
      reverse.delete(account);
      return null;
    });
    reverse.set(account, found);
  }
  return found;
}

async function readForward(name: string): Promise<string | null> {
  if (!NAME.test(name)) return null;
  const { token, resolver } = await contracts();
  const label = name.slice(0, -".cspr".length).split(".").pop()!;
  const hex = Array.from(blake2b(new TextEncoder().encode(label), { dkLen: 32 }), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const id = BigInt(`0x${hex}`).toString();

  const metadata = await token.read("token.metadata", [id]);
  if (metadata === null) return null;
  // Printed as `key:value, key:value`. The resolver of the token must be the one read below.
  const expiration = /(?:^|, )expiration:(\d+)/.exec(metadata)?.[1];
  const tokenResolver = /(?:^|, )resolver:(hash-[0-9a-f]{64})/.exec(metadata)?.[1];
  if (!expiration || tokenResolver !== RESOLVER) return null;
  // The stored expirations are far larger than a time in milliseconds; they read as
  // microseconds. A name past either reading of its expiration is treated as expired.
  const stored = BigInt(expiration);
  const expiresAt = stored > 100_000_000_000_000n ? stored / 1000n : stored;
  if (expiresAt < BigInt(Date.now())) return null;

  const nonce = (await resolver.read("nonces", [id])) ?? "0";
  const resolution = await resolver.read("resolutions", [`${id}:${name}:${nonce}`]);
  if (resolution === null || !/Key::Account\(/.test(resolution)) return null;
  return formattedKey(resolution);
}

async function readReverse(account: string): Promise<string | null> {
  if (!account.startsWith("account-hash-")) return null;
  const { reverse } = await contracts();
  const stored = await reverse.read("primary_names", [account]);
  const name = stored === null ? null : /[a-z0-9.-]+\.cspr/.exec(stored)?.[0];
  if (!name) return null;
  return (await resolveName(name)) === account ? name : null;
}
