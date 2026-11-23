# Merkle airdrop

Drops CEP-18 tokens to a long list of recipients, each of whom claims their own amount with a
proof. The contract stores one 32-byte hash per drop, the Merkle root of the list, never the list.
Written in [Odra](https://odra.dev) for [Casper](https://casper.network).

The project has five parts:

- `src/airdrop.rs`: the `Airdrop` contract and its tests; `src/merkle.rs`: how a list becomes a root and a proof.
- `src/token.rs`: `TestToken`, a CEP-18 token with a public faucet, for trying the contract on a test network.
- `bin/cli.rs` and `src/demo.rs`: a command line tool that deploys the contract and runs a demo.
- `web/`: a web app for creating a drop, sharing its list and claiming from it with a Casper wallet.
- `storage_reader/`: builds [odra-storage-reader](https://github.com/odradev/odra/tree/release/2.11.0/odra-storage-reader), which the web app reads contract state with, to wasm.

## How it works

It is the counterpart of [multisend](../multisend/). There the sender pays the gas of every
transfer, about 1 CSPR per recipient, and about 50 recipients fit in one transaction. Here the
creator sends one transaction whatever the length of the list, and each recipient pays for their
own claim, so a list can have thousands of entries.

1. The creator builds the Merkle tree of the list off-chain, approves the contract for the sum, and
   calls `create_drop` with the token, the root, the sum, the number of entries and an optional
   deadline. The contract pulls the tokens with `transfer_from`.
2. The creator hands the list to the recipients. Anyone holding it can see every entry.
3. A recipient computes the proof of their entry from the list and calls
   `claim(drop_id, recipient, amount, proof)`. The contract hashes the entry into a leaf, follows
   the proof up to a root, compares it with the stored one, and checks that the recipient has not
   claimed from this drop before. Then it transfers the amount.
4. If the drop has a deadline, claims stop at it, and from then on the creator may call `reclaim`
   to take back what was not claimed. A drop without a deadline stays open for ever.

Anyone can create a drop for any CEP-18 token. The contract has no owner, no fees and no upgrade
key. One deployed contract holds every drop, of every token.

### The tree

The contract and the web app build the tree the same way; `src/merkle.rs` and
`web/src/merkle.ts` are the two copies. `blake2b256` is blake2b with a 32-byte output and no key,
which is what `self.env().hash(…)` computes on Casper.

- **Leaf** of an entry: `blake2b256(0x00 ‖ address ‖ amount)`, 66 bytes hashed.
  - `address`: 33 bytes, as Odra serializes an `Address` (the bytes of a `Key`): the tag `0x00`
    and the 32 bytes of an account hash (`account-hash-…`), or the tag `0x01` and the 32 bytes of
    a contract package hash (`hash-…`). A public key on the list is turned into its account hash
    first.
  - `amount`: 32 bytes, big-endian, in the smallest unit of the token.
- **Node**: `blake2b256(0x01 ‖ min(a, b) ‖ max(a, b))`, where `a` and `b` are its children and
  `min`/`max` compare them as byte strings. Sorted pairs mean a proof needs no left/right bits.
- **Levels**: the leaves in the order of the list. Each level pairs its nodes in order, the first
  with the second, the third with the fourth, and so on; a last node without a partner moves up
  unchanged. The root is the node left at the top. A list of one entry has its leaf as the root.
- **Proof** of an entry: the partner of its node on each level, from the leaves up, skipping the
  levels where it has none. The contract takes it as one byte string, the 32-byte nodes one after
  another (`Bytes`; a `Uint8Array` in the web client).

The two prefixes, and the different lengths hashed, keep an inner node from being passed off as
a leaf. A list of `n` entries has proofs of about `log2(n)` nodes: 10 for 1,000 entries, 14 for
10,000, 20 (640 bytes) for a million. The arguments of a transaction may take about 2 KB on the
testnet, so proofs fit where lists do not.

`resources/merkle_vector.json` pins the two copies together. `npm run vector` in `web/` writes it
with the TypeScript code: a list of five entries (an account hash of all zeros, one of all `0xff`,
a contract package hash, the largest `U256`), every leaf and proof, and the root. The Rust test
`the_tree_of_the_web_app_is_the_same` builds the tree of the same list and compares each leaf,
each proof and the root. `npm run build` stops if the file no longer matches the TypeScript code.

### Who gets what

- **A recipient claims once per drop.** The contract records claims by drop and address, so an
  address that appears twice on a list can claim only one of its entries. The web app refuses a
  list with an address twice.
- **Anyone may send a claim**; the tokens always go to the recipient on the list. A friend can
  pay the fee for someone who has no CSPR.
- **A drop never pays out more than was put in.** The contract cannot check the sum or the number
  of entries against a root, so it takes the creator's word for them. A claim that would take a
  drop past its total fails with `ExceedsDrop`: a list that adds up to more than its drop leaves
  its last claimers short, and never reaches the tokens of other drops.

## Entry points

| Entry point | Who | What it does |
|---|---|---|
| `create_drop(token, root, total, recipients, deadline)` | anyone | Creates a drop and pulls `total` of `token` from the caller. `deadline` is a block time in milliseconds, or `0` for none. |
| `claim(drop_id, recipient, amount, proof)` | anyone | Pays `amount` to `recipient` if the proof shows the pair is on the list and the recipient has not claimed. |
| `reclaim(drop_id)` | the creator | After the deadline, sends what was not claimed back to the creator. |
| `drop(drop_id)` | view | The drop: creator, token, root, total, claimed, recipients, claims, deadline, reclaimed. |
| `drops_count()` | view | The number of drops. Ids run from `0` to `count - 1`. |
| `is_claimed(drop_id, recipient)` | view | Whether the recipient has claimed from the drop. |

The entry points that change state return nothing. The id of a new drop is the value
`drops_count` returned before the call, and the `DropCreated` event carries it.

The storage has three fields: `drops`, a mapping from id to drop; `count`; and `claimed`, a
mapping from `(drop_id, recipient)` to `true`, which the web app reads for one recipient with the
key `<drop_id>:<account-hash-…>`.

### Events

| Event | Fields |
|---|---|
| `DropCreated` | `drop_id`, `creator`, `token`, `root`, `total`, `recipients`, `deadline` |
| `TokensClaimed` | `drop_id`, `recipient`, `amount` |
| `DropReclaimed` | `drop_id`, `creator`, `amount` |

### Errors

| Code | Error | When |
|---|---|---|
| 1 | `ZeroAmount` | The total of the drop is zero. |
| 2 | `NoRecipients` | The number of recipients is zero. |
| 3 | `InvalidRoot` | The root is not 32 bytes long. |
| 4 | `DeadlineInPast` | The deadline is not after the current block time. |
| 5 | `DropNotFound` | No drop has this id. |
| 6 | `ClaimsClosed` | The deadline of the drop has passed. |
| 7 | `AlreadyClaimed` | The recipient has claimed from this drop before. |
| 8 | `InvalidProof` | The proof does not lead from the entry to the root. |
| 9 | `ExceedsDrop` | The claim is larger than what is left of the drop. |
| 10 | `NotCreator` | Someone other than the creator tried to reclaim. |
| 11 | `NoDeadline` | The drop has no deadline, so nothing can be reclaimed. |
| 12 | `DeadlineNotReached` | The deadline has not passed yet. |
| 13 | `NothingToReclaim` | Everything was claimed or reclaimed already. |

A failed token transfer reverts with the error of the token, for example `InsufficientAllowance`
(60002) when the creator has not approved enough.

## Things to know before using it

- **Not audited.** Review and test it yourself before putting real funds behind it.
- **What it costs.** Gas measured on CasperVM in November 2026, where it matched the testnet
  within 2% for the calls sent there: creating a drop 1.72 CSPR whatever the length of the
  list; a claim 1.45 CSPR with a proof of 2 nodes and 1.54 CSPR with 10 (a list of 1,000), about
  0.01 CSPR more per level; a reclaim 1.24 CSPR (not sent on the testnet). The network charges
  the gas limit and refunds three quarters of what is unused, so with the 2.5 CSPR limit the web
  app sets, a claim costs a recipient about 1.7 CSPR.
- **The list must reach the recipients.** The contract cannot give anyone their proof. Lose the
  list and nobody can claim; after the deadline, the creator can take the tokens back.
- **The list is public to whoever has it**, every address and amount on it.
- **Standard CEP-18 tokens only.** The contract records the amount it asked for. A token that takes
  a fee on transfer leaves the contract short, and the last claimers cannot claim.
- **The number of recipients is what the creator says.** It is shown, never checked.

## Running it

You need Rust, the `wasm32-unknown-unknown` target and
[cargo-odra](https://github.com/odradev/cargo-odra). `wasm-opt` and `wasm-strip` are needed to
build wasm files; see the [installation guide](https://odra.dev/docs/getting-started/installation).

```bash
cargo odra test            # tests on OdraVM
cargo odra test -b casper  # builds the wasm files and runs the tests on CasperVM
```

`cargo odra test -b casper -- --nocapture` prints the gas reports of the tests that measure: a
claim at depth 10, a reclaim, and the demo.

The project depends on the `release/2.11.0` branch of Odra, not on a published version: the web
client of the published 2.10 sends transactions the testnet rejects.

## Deploying to the testnet

```bash
cp .env.sample .env        # then set the path of your secret key in .env
cargo odra build
cargo run --bin airdrop_cli -- deploy
```

Deploying `Airdrop` cost 288.3 CSPR on the testnet in November 2026: 281.0 CSPR of gas, as
measured on CasperVM, under the 310 CSPR limit set in `src/demo.rs`. The addresses are saved to
`resources/casper-test-contracts.toml`, and a second `deploy` reuses them. The file in the
repository already lists a `TestToken`, the one deployed for the [vesting](../vesting/) project,
so `deploy` does not deploy another; remove that entry to deploy your own.

To see it working, drop 40 TEST to a list of three (you with 25, two made-up accounts with 10 and
5), open for a week, and claim your 25:

```bash
cargo run --bin airdrop_cli -- scenario demo
cargo run --bin airdrop_cli -- contract Airdrop drop --drop_id 0
```

The scenario sends four transactions (faucet, approve, create, claim; 5.5 CSPR together on the
testnet) and prints the list, which can be pasted into the web app. The test
`the_demo_runs_to_the_end` runs the same calls with the same gas limits on CasperVM.
`cargo run --bin airdrop_cli -- --help` lists every command.

### Deployed on the testnet

| Contract | Package hash |
|---|---|
| `Airdrop` | [`hash-6957d11fd45dbd688eb8a3221dd4507921e76e2aef7f4b5be22da96fc2ebdcf4`](https://testnet.cspr.live/contract-package/6957d11fd45dbd688eb8a3221dd4507921e76e2aef7f4b5be22da96fc2ebdcf4) |
| `TestToken` | [`hash-0fafe6f2e4481d7c2e1b3d031a3634dc37189d2ff9c97d064b6a203d4b47ffe4`](https://testnet.cspr.live/contract-package/0fafe6f2e4481d7c2e1b3d031a3634dc37189d2ff9c97d064b6a203d4b47ffe4) (shared with vesting) |

Drop 0 is the demo run.

## The web app

The app in `web/` has two parts:

- **Create a drop.** Paste a list, one recipient per line (`address, amount`, as in multisend),
  and choose a deadline and, if not TEST, a token. Before anything is signed the app shows the
  list as a table with the total, the number of recipients and the root. It then sends the
  approval and `create_drop`, and gives the creator a **claim link** and the **list as a file**.
- **Claim your tokens.** Give the drop number and its list: open the claim link, which carries
  both, paste the list, or open the file. The app reads the drop, rebuilds the tree, and says
  whether the list is the drop's (the roots match), whether the connected account is on it, for
  how much, and whether it has claimed. The claim button sends the proof the app computed from
  the list. The drop's public state (total, claimed so far as a progress bar, how many recipients
  claimed, deadline) shows from the number alone, without a wallet. After the deadline, the
  creator gets a button to take back what is left.

How the list travels: the claim link carries it in the fragment of the URL,
`#drop=<id>&list=<the list as URL-safe base64>`. Browsers do not send a fragment to the web
server, so the list goes only where the link goes. The app offers the link for lists of up to 300
entries; for longer ones, only the file (the same text, every digit of each amount). **A real
project would host the list**, or one proof per address, at a stable address (its own site,
IPFS), publish the root next to it so anyone can check one against the other, and have the claim
page fetch the connected account's entry. Nothing in the contract changes for that.

The app reads state straight from the node's storage with
[odra-storage-reader](https://github.com/odradev/odra/tree/release/2.11.0/odra-storage-reader)
(`web/src/storage.ts`): a drop, `count`, and `claimed` for one address. No contract code runs and
nothing is signed to read. It sends transactions through the client `cargo odra generate-client`
generates from the contracts, signed with [CSPR.click](https://cspr.click) (Casper Wallet or
Ledger). Blake2b comes from [`@noble/hashes`](https://github.com/paulmillr/noble-hashes), bundled
by Vite.

Its look is the Odra web style shared by every project of this repository; see
[`../style/`](../style/).

```bash
# 1. Build the two wasm packages the app depends on. Needs wasm-pack.
cargo odra generate-client   # the transaction client: airdrop_client/pkg-web (see the note below)
cd web
npm run reader               # the storage reader: storage_reader/pkg-web

# 2. Start it.
npm install
npm run dev
```

`cargo odra generate-client` needs cargo-odra 0.2.1 or newer: 0.2.0 stops with `Project is not a
workspace`. Until 0.2.1 is on crates.io, install it from its branch:
`cargo install cargo-odra --locked --git https://github.com/odradev/cargo-odra --branch release/0.2.1`.
Generate the client with `WASM_CLIENT_SK` unset: the app needs no reader key.

`npm run build` writes a static site to `web/dist`. `web/src/contracts.json` holds the testnet
addresses above; `npm run contracts` rewrites it from `resources/casper-test-contracts.toml` after
you deploy your own.

Tokens are read with the schema of `TestToken`. Another token is shown with its symbol and decimals
only if it stores them the same way, as tokens built on Odra's `Cep18` module do; otherwise the app
shows raw units.
