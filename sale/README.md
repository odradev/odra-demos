# Token sale

Sells a CEP-18 token for CSPR at one fixed price, up to a cap and a limit per wallet, between a
start and an end, to everyone or only to the accounts of a list. Written in [Odra](https://odra.dev)
for [Casper](https://casper.network).

The project has five parts:

- `src/sale.rs`: the `TokenSale` contract and its tests.
- `src/merkle.rs`: the Merkle tree of a list of buyers, taken from the [airdrop](../airdrop/) project.
- `src/token.rs`: `TestToken`, a CEP-18 token with a public faucet, for trying the contract on a test network.
- `bin/cli.rs` and `src/demo.rs`: a command line tool that deploys the contract and runs a demo.
- `web/`: a web app to create a sale, buy from one, and take out what it raised, with a Casper wallet.
- `storage_reader/`: builds [odra-storage-reader](https://github.com/odradev/odra/tree/release/2.11.0/odra-storage-reader), which the web app reads contract state with, to wasm.

## How it works

Anyone can create a sale of any CEP-18 token. The contract has no owner, no fees and no upgrade
key. One deployed contract holds every sale, of every token.

```
tokens
  ^
cap  - - - - - - - - - *--------- sold out: nobody can buy more
  |                 /  .
  |              /     .
  |           *        .          a buyer: 2 CSPR for 4 TEST at 0.5 CSPR each
  |        /           .
  |     /              .
  |  /                 .
  +--------------------+--------> CSPR paid
                    cap × price
```

A sale has these terms, fixed when it is created:

- **token**: the CEP-18 token on sale. The contract reads its `decimals` once, at creation.
- **price**: the price of one whole token (`10^decimals` of its smallest unit), in motes.
- **cap**: how much is on sale, in the token's smallest unit. Creating the sale pulls exactly this
  much from the creator with `transfer_from`, so the creator approves the contract for it first.
- **per_wallet**: the most one address may buy over the whole sale. At least one unit, at most the
  cap; set it to the cap for no limit of its own.
- **start** and **end**: block times in milliseconds. Buying is open from `start` (which may be in
  the past) until `end`; the end must be after the start and in the future.
- **allowlist_root**: empty for a sale open to everyone, or the 32-byte Merkle root of the
  accounts that may buy.

**Buying.** `buy(sale_id, proof)` is payable: the CSPR attached to the call is the payment, and it
decides the amount. The buyer receives `paid × 10^decimals / price` of the smallest unit, sent by
the contract in the same transaction. The purchase reverts:

- before `start` (`NotStarted`) or from `end` on (`Ended`);
- with no CSPR attached (`NothingAttached`);
- **when the division is not exact** (`InexactPayment`): the contract never rounds and never keeps
  CSPR that buys nothing. With a price of 0.5 CSPR and 9 decimals, any whole number of motes buys a
  whole number of units (1 mote buys 2); with 3 CSPR, the payment must be a multiple of 3 motes. A
  buyer works out the payment from the amount they want: `amount × price / 10^decimals`, which is
  whole when `amount` is a multiple of `10^decimals / gcd(price, 10^decimals)`. The web app rounds
  the amount typed down to such a multiple and attaches exactly its price. `quote(sale_id, paid)`
  answers what a payment buys, or reverts the same way;
- when it is more than is left of the cap (`ExceedsCap`), or takes the buyer past `per_wallet`,
  counting what they bought before (`ExceedsWalletLimit`). A purchase is never cut down to fit;
- for a sale with a list, when `proof` does not lead from the caller's leaf to the root
  (`NotOnAllowlist`). A sale without a list ignores `proof`.

**The creator.** `withdraw_proceeds(sale_id)` sends the CSPR paid so far, and not taken out yet,
to the creator, at any time, also while the sale runs. `withdraw_unsold(sale_id)` sends back the
tokens nobody bought, from `end` on. Nobody else can call either.

The end is the first moment the sale is closed: a purchase in a block timed at `end` is rejected, a
`withdraw_unsold` in that block is accepted.

### The list of buyers

The list is a Merkle tree of addresses, built like the airdrop's with one change: a leaf holds an
address and no amount, since everyone on the list may buy up to the same limit.

- A **leaf** is `blake2b256(0x00 ‖ address)`: the address as the contract serializes it, a tag
  byte (`0x00` for an account hash, `0x01` for a contract package hash) and its 32 bytes.
- A **node** is `blake2b256(0x01 ‖ min(a, b) ‖ max(a, b))`, its children compared as bytes.
- Leaves are taken in the order of the list; each level pairs its nodes in order, and a last node
  without a partner moves up unchanged. A list of one address has its leaf as the root.
- The **proof** of an address is the partner of its node on each level that has one, from the
  leaves up, passed to `buy` as one byte string of 32-byte nodes.

`web/src/merkle.ts` builds the same tree in the browser. `resources/merkle_vector.json`, written by
`npm run vector` in `web/`, holds a list with its leaves, proofs and root; a Rust test builds the
tree from it and compares, and `npm run build` checks that the file is still what the page
computes.

## Entry points

| Entry point | Who | What it does |
|---|---|---|
| `create_sale(token, price, cap, per_wallet, start, end, allowlist_root)` | anyone | Creates a sale and pulls `cap` of `token` from the caller. |
| `buy(sale_id, proof)` | anyone, or the list | Payable. Sends what the attached CSPR buys to the caller. |
| `withdraw_proceeds(sale_id)` | the creator | Sends the CSPR not taken out yet to the creator. At any time. |
| `withdraw_unsold(sale_id)` | the creator | From the end on, sends what is unsold back to the creator. |
| `sale(sale_id)` | view | The sale: its terms, `sold`, `raised`, `buyers`, `withdrawn`, `reclaimed`. |
| `sales_count()` | view | The number of sales. Ids run from `0` to `count - 1`. |
| `sales_of_creator(address)` | view | The ids of the sales the address created, oldest first. |
| `bought_by(sale_id, address)` | view | What the address has bought from the sale. |
| `quote(sale_id, paid)` | view | What `paid` motes buy from the sale. |

The entry points that change state return nothing. The id of a new sale is the value
`sales_count` returned before the call, and the `SaleCreated` event carries it.

The storage has four fields, all the web app needs: `sales`, a mapping from id to sale; `count`;
`bought`, a mapping from `(sale_id, buyer)` to an amount, read with the key
`<sale_id>:<account-hash-…>`; and `sales_of_creator`, a mapping from an address to its list of ids.

### Events

| Event | Fields |
|---|---|
| `SaleCreated` | `sale_id`, `creator`, `token`, `price`, `cap`, `per_wallet`, `start`, `end`, `allowlist_root` |
| `TokensBought` | `sale_id`, `buyer`, `amount`, `paid` |
| `ProceedsWithdrawn` | `sale_id`, `creator`, `amount` (motes) |
| `UnsoldWithdrawn` | `sale_id`, `creator`, `amount` |

### Errors

| Code | Error | When |
|---|---|---|
| 1 | `ZeroPrice` | The price is zero. |
| 2 | `ZeroCap` | The cap is zero. |
| 3 | `InvalidWalletLimit` | The limit per wallet is zero or larger than the cap. |
| 4 | `InvalidWindow` | The end is not after the start. |
| 5 | `EndInPast` | The end is not after the current block time. |
| 6 | `InvalidRoot` | The root is neither empty nor 32 bytes long. |
| 7 | `UnsupportedDecimals` | The token has more than 30 decimals. |
| 8 | `SaleNotFound` | No sale has this id. |
| 9 | `NotStarted` | The sale has not started. |
| 10 | `Ended` | The sale has ended. |
| 11 | `NothingAttached` | No CSPR was attached to `buy`. |
| 12 | `InexactPayment` | The CSPR does not buy a whole number of the smallest unit. |
| 13 | `ExceedsCap` | The purchase is more than is left. |
| 14 | `ExceedsWalletLimit` | The purchase takes the buyer past the limit per wallet. |
| 15 | `NotOnAllowlist` | The proof does not show the caller is on the list. |
| 16 | `NotCreator` | Someone other than the creator tried to withdraw. |
| 17 | `NothingToWithdraw` | There is no CSPR to take out. |
| 18 | `NotEnded` | The sale has not ended, so nothing unsold can be taken back. |
| 19 | `NothingUnsold` | Everything was sold or taken back already. |

A failed token transfer reverts with the error of the token, for example `InsufficientAllowance`
(60002) when the creator has not approved the cap.

## Things to know before using it

- **Not audited.** Review and test it yourself before putting real funds behind it.
- **What it costs.** On the testnet in November 2026: creating a sale used 2.26 CSPR of gas,
  a purchase 4.73 CSPR, taking out the CSPR 3.03 CSPR. A purchase is a payable call: Casper runs it
  through a session that carries the CSPR, which costs more than a plain call. On CasperVM the same
  purchase measured 7.40 CSPR (7.74 with a proof of 10 nodes, a list of 1,000), so CasperVM
  overstates payable calls; the other calls matched the testnet within 0.2%. Taking back what is
  unsold measured 1.29 CSPR on CasperVM. The network charges the gas limit and refunds three
  quarters of what is unused.
- **A limit per wallet is a limit per address.** In a sale open to everyone, one person with many
  accounts can buy past it. A list stops that only as far as the creator knows who is on it.
- **The list must reach the buyers.** The contract cannot give anyone their proof.
- **Standard CEP-18 tokens only.** The contract records the cap it asked for. A token that takes a
  fee on transfer leaves the contract short, and the last buyers cannot buy.
- **The price does not change** and a sale cannot be cancelled or edited. To stop selling early,
  nothing can be done but wait for the end; a creator who wants that option sets a short window.

## Running it

You need Rust, the `wasm32-unknown-unknown` target and
[cargo-odra](https://github.com/odradev/cargo-odra). `wasm-opt` and `wasm-strip` are needed to
build wasm files; see the [installation guide](https://odra.dev/docs/getting-started/installation).

```bash
cargo odra test            # tests on OdraVM
cargo odra test -b casper  # builds the wasm files and runs the tests on CasperVM
```

`cargo odra test -b casper -- --nocapture` prints the gas reports of the tests that measure: a
purchase with a proof of 10 nodes followed by `withdraw_unsold`, and the demo.

The project depends on the `release/2.11.0` branch of Odra, not on a published version: the web
client of the published 2.10 sends transactions the testnet rejects.

## Deploying to the testnet

```bash
cp .env.sample .env        # then set the path of your secret key in .env
cargo odra build
cargo run --bin sale_cli -- deploy
```

Deploying `TokenSale` cost 345.6 CSPR on the testnet in November 2026: 337.5 CSPR of gas, the
same as measured on CasperVM, under the 370 CSPR limit set in `src/demo.rs`. The addresses are
saved to `resources/casper-test-contracts.toml`, and a second `deploy` reuses them. The file in the
repository already lists a `TestToken`, the one deployed for the [vesting](../vesting/) project, so
`deploy` does not deploy another; remove that entry to deploy your own.

To see it working, put 100 TEST on sale at 0.5 CSPR each, 20 per wallet, for a week, to a list of
three (you and two made-up accounts), buy 4 TEST for 2 CSPR with your proof, and take the 2 CSPR
out again as the creator:

```bash
cargo run --bin sale_cli -- scenario demo
cargo run --bin sale_cli -- contract TokenSale sale --sale_id 0
```

The scenario sends five transactions (faucet, approve, create, buy, withdraw; 12.9 CSPR together on
the testnet) and prints the list, which can be pasted into the web app. The test
`the_demo_runs_to_the_end` runs the same calls with the same gas limits on CasperVM.
`cargo run --bin sale_cli -- --help` lists every command.

### Deployed on the testnet

| Contract | Package hash |
|---|---|
| `TokenSale` | [`hash-82a8af35e16c28cc7c2bf8f07e608783f57c8882b6bc9116f3c2513023d656b1`](https://testnet.cspr.live/contract-package/82a8af35e16c28cc7c2bf8f07e608783f57c8882b6bc9116f3c2513023d656b1) |
| `TestToken` | [`hash-0fafe6f2e4481d7c2e1b3d031a3634dc37189d2ff9c97d064b6a203d4b47ffe4`](https://testnet.cspr.live/contract-package/0fafe6f2e4481d7c2e1b3d031a3634dc37189d2ff9c97d064b6a203d4b47ffe4) (shared with vesting) |

Sale 0 is the demo run.

## The web app

The app in `web/` has three parts:

- **Buy tokens.** Give the sale number, or open a sale link, which carries it. The app shows the
  sale: what is on sale at what price, a bar of what is sold toward the cap, what is left and what
  it raised, and whether it is open. Type how many tokens to buy; before anything is signed the app
  says what that costs in CSPR and what the account will hold of its limit, rounding the amount
  down to one with a whole price. For a sale with a list, it reads the list from the link or the
  pasted text, checks it against the sale's root, and works out the proof.
- **Put tokens on sale.** Choose how many, the price, the limit per wallet, when the sale opens and
  closes, and who can buy: everyone, or a pasted list of public keys and account hashes, shown as a
  table with the root before signing. It sends the approval and `create_sale`, then gives a
  **sale link** (`#sale=<id>&list=<the list as URL-safe base64>` for lists of up to 300 accounts)
  and the **list as a file**, as the airdrop app does.
- **Sales.** Every sale, newest first, or the ones the connected account created. A creator's sale
  has buttons to take out the CSPR it raised and, after the end, to take back what is unsold.

The app reads state straight from the node's storage with
[odra-storage-reader](https://github.com/odradev/odra/tree/release/2.11.0/odra-storage-reader)
(`web/src/storage.ts`): a sale, `count`, `bought` for one address and `sales_of_creator`. No
contract code runs and nothing is signed to read. It sends transactions through the client
`cargo odra generate-client` generates from the contracts, signed with
[CSPR.click](https://cspr.click) (Casper Wallet or Ledger). Blake2b comes from
[`@noble/hashes`](https://github.com/paulmillr/noble-hashes), bundled by Vite.

Its look is the Odra web style shared by every project of this repository; see
[`../style/`](../style/).

```bash
# 1. Build the two wasm packages the app depends on. Needs wasm-pack.
cargo odra build                                  # the schemas the app reads with
env -u WASM_CLIENT_SK cargo odra generate-client  # the transaction client: sale_client/pkg-web
cd web
npm run reader                                    # the storage reader: storage_reader/pkg-web

# 2. Start it.
npm install
npm run dev
```

`cargo odra generate-client` needs cargo-odra 0.2.1 or newer: 0.2.0 stops with `Project is not a
workspace`. Until 0.2.1 is on crates.io, install it from its branch:
`cargo install cargo-odra --locked --git https://github.com/odradev/cargo-odra --branch release/0.2.1`.

`npm run build` writes a static site to `web/dist`. `web/src/contracts.json` holds the testnet
addresses above; `npm run contracts` rewrites it from `resources/casper-test-contracts.toml` after
you deploy your own.

Tokens are read with the schema of `TestToken`. Another token is shown with its symbol only if it
stores it the same way, as tokens built on Odra's `Cep18` module do; the decimals always come from
the sale.
