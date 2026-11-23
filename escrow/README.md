# Escrow with an arbiter

Holds a buyer's CEP-18 tokens for a seller until the deal is settled: the buyer releases them, the
seller sends them back, or, if the two disagree, an arbiter named when the deal was made decides
who gets them. Written in [Odra](https://odra.dev) for [Casper](https://casper.network).

The project has five parts:

- `src/escrow.rs`: the `Escrow` contract and its tests.
- `src/token.rs`: `TestToken`, a CEP-18 token with a public faucet, for trying the contract on a test network. It is the token of `vesting/`, deployed once and shared by the demos.
- `bin/cli.rs`: a command line tool that deploys the contract and runs a scenario.
- `web/`: a web app for making and settling deals with a Casper wallet, and for looking up any deal without one.
- `storage_reader/`: builds [odra-storage-reader](https://github.com/odradev/odra/tree/release/2.11.0/odra-storage-reader), which the web app reads contract state with, to wasm.

## How it works

Anyone can open a deal in any CEP-18 token. The contract has no owner, no fees and no upgrade key.
One deployed contract holds every deal.

A deal has three parties, an amount and a deadline:

- the **buyer**, who opens the deal and deposits the amount;
- the **seller**, whom the amount is for;
- the **arbiter**, whom both trust to decide a dispute.

```
                     release (buyer)
              +---------------------------> Released:  all to the seller
              |      refund (seller)
              +---------------------------> Refunded:  all back to the buyer
   Funded ----+
              |      reclaim (buyer, from the deadline on)
              +---------------------------> Reclaimed: all back to the buyer
              |
              | open_dispute (buyer or seller, before the deadline)
              v
   Disputed --+-- resolve (arbiter) -------> Resolved:  split as the arbiter says
              +-- release (buyer) ---------> Released
              +-- refund (seller) ---------> Refunded
```

- `create_deal` pulls the amount from the caller, the buyer, with `transfer_from`, so the buyer
  approves the contract first. The deadline must be in the future.
- While the deal is open (`Funded` or `Disputed`), the buyer can release the whole amount to the
  seller and the seller can send the whole amount back. Either of them can give in this way during
  a dispute too.
- Before the deadline, the buyer or the seller can open a dispute. From then on only the arbiter's
  decision, a release or a refund closes the deal.
- The arbiter decides with `resolve(deal_id, seller_share)`: `seller_share` goes to the seller, the
  rest back to the buyer. Zero decides for the buyer, the whole amount for the seller.
- From the deadline on, if no dispute is open, the buyer can take the amount back with `reclaim`.
  A deal nobody disputes cannot hold the tokens forever.

Times are block times: milliseconds since the Unix epoch.

Any account may hold more than one role, the buyer included. That is how the demo runs with one
wallet: the same account buys, sells and arbitrates. The tokens always move from the contract to a
party, never from a party to itself, so CEP-18's rule against a transfer to oneself does not get in
the way.

The contract keeps, for every account, the ids of its deals as the buyer, as the seller and as the
arbiter, so an app can list them from storage. Closed deals stay in the lists and keep their final
state and `seller_share`, so the history stays visible.

## Entry points

| Entry point | Who | What it does |
|---|---|---|
| `create_deal(seller, arbiter, token, amount, deadline)` | anyone, as the buyer | Opens a deal and pulls `amount` of `token` from the caller. |
| `release(deal_id)` | the buyer | Pays the whole amount to the seller. |
| `refund(deal_id)` | the seller | Sends the whole amount back to the buyer. |
| `open_dispute(deal_id)` | the buyer or the seller | Hands the deal to the arbiter. Before the deadline only. |
| `resolve(deal_id, seller_share)` | the arbiter | Pays `seller_share` to the seller and the rest to the buyer. Only with a dispute open. |
| `reclaim(deal_id)` | the buyer | Sends the whole amount back to the buyer. From the deadline on, with no dispute open. |
| `deal(deal_id)` | view | The deal. |
| `deals_count()` | view | The number of deals. Ids run from `0` to `count - 1`. |
| `deals_of_buyer(account)` | view | Ids of the deals of the account as the buyer. |
| `deals_of_seller(account)` | view | Ids of the deals of the account as the seller. |
| `deals_of_arbiter(account)` | view | Ids of the deals of the account as the arbiter. |

The entry points that change state return nothing. The id of a new deal is the value
`deals_count` returned before the call, and the `DealCreated` event carries it.

A deal stores `state`, one of `Funded`, `Disputed`, `Released`, `Refunded`, `Resolved` and
`Reclaimed`, and `seller_share`: what the seller received when the deal closed (zero while it is
open). The buyer received `amount - seller_share`.

### Events

| Event | Fields |
|---|---|
| `DealCreated` | `deal_id`, `buyer`, `seller`, `arbiter`, `token`, `amount`, `deadline` |
| `DisputeOpened` | `deal_id`, `by` |
| `DealClosed` | `deal_id`, `state`, `to_seller`, `to_buyer` |

### Errors

| Code | Error | When |
|---|---|---|
| 1 | `ZeroAmount` | The amount of a new deal is zero. |
| 2 | `DeadlineNotInFuture` | The deadline of a new deal is not after the current block time. |
| 3 | `DealNotFound` | No deal has this id. |
| 4 | `NotBuyer` | Someone other than the buyer tried to release or reclaim. |
| 5 | `NotSeller` | Someone other than the seller tried to refund. |
| 6 | `NotParty` | Someone other than the buyer or the seller tried to open a dispute. |
| 7 | `NotArbiter` | Someone other than the arbiter tried to resolve. |
| 8 | `DealClosed` | The deal has been settled already. |
| 9 | `AlreadyDisputed` | A dispute is open already. |
| 10 | `NotDisputed` | The arbiter tried to resolve a deal with no dispute open. |
| 11 | `DeadlinePassed` | A dispute was opened at or after the deadline. |
| 12 | `DeadlineNotReached` | The buyer tried to reclaim before the deadline. |
| 13 | `DisputeOpen` | The buyer tried to reclaim with a dispute open. |
| 14 | `ShareTooLarge` | The seller's share is more than the amount. |

A failed token transfer reverts with the error of the token, for example `InsufficientAllowance`
(60002) when the buyer has not approved enough.

## Things to know before using it

- **Not audited.** Review and test it yourself before putting real funds behind it.
- **The arbiter has the last word in a dispute, and no deadline.** A dispute stays open until the
  arbiter decides it, or until the buyer releases or the seller refunds. An arbiter who never
  answers leaves the tokens in the contract; choose one who will.
- **The roles are not checked against each other.** An arbiter who is also the buyer can take the
  deposit back through a dispute. The seller sees the arbiter in the deal (and in the
  `DealCreated` event) and should check it before delivering anything.
- **The deadline cuts both ways.** Before it, the seller can open a dispute to stop the buyer from
  taking the tokens back; after it, nobody can, and the buyer can reclaim a deal nobody disputed.
  A seller who has not been paid by the deadline should open a dispute in time.
- **Standard CEP-18 tokens only.** The contract records the amount it asked for. A token that takes
  a fee on transfer or changes balances on its own leaves the contract short.
- **The lists of an account's deals are stored values.** Opening a deal for an account that has
  thousands of them costs more gas each time. Settling a deal does not read the lists.

## Running it

You need Rust, the `wasm32-unknown-unknown` target and
[cargo-odra](https://github.com/odradev/cargo-odra). `wasm-opt` and `wasm-strip` are needed to
build wasm files; see the [installation guide](https://odra.dev/docs/getting-started/installation).

```bash
cargo odra test            # tests on OdraVM
cargo odra test -b casper  # builds the wasm files and runs the tests on CasperVM
```

The project depends on the `release/2.11.0` branch of Odra, not on a published version: the web
client of the published 2.10 sends transactions the testnet rejects.

To see what each call consumes, run the `demo_scenario` test on CasperVM with the wasm files
`cargo odra build` wrote; it prints the gas report:

```bash
cargo odra build
ODRA_BACKEND=casper cargo test --lib demo_scenario -- --nocapture
```

## Deploying to the testnet

```bash
cp .env.sample .env        # then set the path of your secret key in .env
cargo odra build
cargo run --bin escrow_cli -- deploy
```

Deploying `Escrow` cost 296.96 CSPR on the testnet in November 2026: 289.28 CSPR consumed, the
same as on CasperVM, of the 320 CSPR limit in `bin/cli.rs`; 75% of the unused part comes back.
`TestToken` is the one the vesting project deployed, listed in
`resources/casper-test-contracts.toml` before the first `deploy`, so it was reused. The addresses
are saved to that file, and a second `deploy` reuses them.

To see it working, open two deals of 100 TEST with yourself as the seller and the arbiter: the
first is released, the second disputed and split in half by you as the arbiter. The scenario takes
TEST from the faucet and approves the contract only if the caller lacks them.

```bash
cargo run --bin escrow_cli -- scenario demo
cargo run --bin escrow_cli -- contract Escrow deal --deal_id 1
```

`--seller` and `--arbiter` name other accounts; the second deal then stays disputed until the
arbiter decides it.

The demo's calls on the testnet, in CSPR, each with its limit, what it consumed and what it cost
after the refund:

| Call | Limit | Consumed | Paid |
|---|---|---|---|
| `approve` | 2.5 | 0.36 | 0.90 |
| `create_deal` | 4 | 2.29 | 2.72 |
| `release` | 2.5 | 1.24 | 1.56 |
| `create_deal` | 4 | 2.31 | 2.74 |
| `open_dispute` | 2.5 | 0.50 | 1.00 |
| `resolve` (two transfers) | 3.5 | 2.02 | 2.39 |

On CasperVM `refund` and `reclaim` consumed 1.23 CSPR and `faucet` 0.30. A transaction that fails
is charged its whole limit, with no refund.

`cargo run --bin escrow_cli -- --help` lists every command.

### Deployed on the testnet

| Contract | Package hash |
|---|---|
| `Escrow` | [`hash-afb4d38b6d308288ecc22517fcaba68be5571a56076cede2141ffa867e435d43`](https://testnet.cspr.live/contract-package/afb4d38b6d308288ecc22517fcaba68be5571a56076cede2141ffa867e435d43) |
| `TestToken` | [`hash-0fafe6f2e4481d7c2e1b3d031a3634dc37189d2ff9c97d064b6a203d4b47ffe4`](https://testnet.cspr.live/contract-package/0fafe6f2e4481d7c2e1b3d031a3634dc37189d2ff9c97d064b6a203d4b47ffe4) |

## The web app

The app in `web/` does two things with the contracts, in two different ways:

- **It reads state straight from the node's storage** with
  [odra-storage-reader](https://github.com/odradev/odra/tree/release/2.11.0/odra-storage-reader).
  The reader takes the schema of a contract (`resources/casper_contract_schemas/`) and says where a
  value is stored; the app fetches it over JSON-RPC and the reader decodes it. No contract code
  runs and nothing is signed, so the page shows deals before a wallet is connected.
  `web/src/storage.ts` holds all of it.
- **It sends transactions** through the client `cargo odra generate-client` generates from the
  contracts, signed with [CSPR.click](https://cspr.click) (Casper Wallet or Ledger).

"Your deals" lists the connected account's deals in three tabs, as the buyer, as the seller and as
the arbiter, from the contract's three lists. Each deal shows only the buttons the connected
account may use. The app keeps 15 seconds away from a deadline, by the local clock, before it
offers to open a dispute or to take the tokens back: the contract compares the deadline with the
time of the block, and a refused transaction costs its whole limit.

The form fills in the connected account as the seller and the arbiter, so one wallet can try every
part. To play the parts with separate accounts, switch accounts in the wallet (Switch in the
toolbar); the page follows the account the wallet has selected.

Tokens are read with the schema of `TestToken`. Another token is shown with its symbol and decimals
only if it stores them the same way, as tokens built on Odra's `Cep18` module do; otherwise the app
shows raw units.

```bash
# 1. Build the two wasm packages the app depends on. Needs wasm-pack.
cargo odra build             # writes the schemas the app reads with
cargo odra generate-client   # the transaction client: escrow_client/pkg-web
cd web
npm run reader               # the storage reader: storage_reader/pkg-web

# 2. Give the app the contract addresses and start it.
npm install
npm run contracts            # writes src/contracts.json from ../resources/casper-test-contracts.toml
npm run dev
```

`npm run build` writes a static site to `web/dist`.

`web/src/contracts.json` in the repository holds the testnet addresses above, so `npm run
contracts` is needed only after deploying your own.

Run `cargo odra generate-client` again whenever an entry point, an event or an error of the
contract changes. The storage reader needs no rebuild: it reads the schema files, which
`cargo odra build` rewrites.
