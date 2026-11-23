# Payment splitter

Divides income in CEP-18 tokens among payees by fixed shares; each payee withdraws their part when
they like. Written in [Odra](https://odra.dev) for [Casper](https://casper.network).

The project has five parts:

- `src/splitter.rs`: the `Splitter` contract and its tests.
- `src/token.rs`: `TestToken`, a CEP-18 token with a public faucet, for trying the contract on a test network.
- `bin/cli.rs` and `src/demo.rs`: a command line tool that deploys the contract and runs a demo; a test runs the same demo on CasperVM first.
- `web/`: a web app for creating splits, paying into them and withdrawing with a Casper wallet.
- `storage_reader/`: builds [odra-storage-reader](https://github.com/odradev/odra/tree/release/2.11.0/odra-storage-reader), which the web app reads contract state with, to wasm.

## How it works

One deployed contract holds every split, of every token. Anyone can create a split, anyone can pay
into one, and each payee withdraws their own part. The contract has no owner, no fees and no
upgrade key.

A split is a list of payees, each with a whole number of shares. It is fixed once created: nobody,
the creator included, can change the payees or the shares. The creator has no other rights over
the split.

```
            ┌── 50 shares ──▶ alice   50%
payment ────┼── 30 shares ──▶ bob     30%
            └── 20 shares ──▶ carol   20%
```

Payments are counted per split and per token. For each, the contract stores what the split
received in total and what each payee withdrew. Of everything a split has received in a token, a
payee can withdraw

```
received * share / total_shares - withdrawn
```

with the division rounded down. This is the classic pull-payment splitter: a payment costs the same
whatever the number of payees, because nobody is paid at that moment; each payee takes their part
later, in one withdrawal for all the payments so far.

Paying in goes through `pay(split_id, token, amount)`: the contract pulls the tokens with
`transfer_from`, so the payer approves the contract first, and the contract knows which split and
which token the money is for. **A plain CEP-18 transfer to the contract is not supported**: it says
nothing about a split, so it belongs to no split and stays in the contract for good.

### Decisions

- **At most 40 payees.** The arguments of a transaction may take about 2 KB on the testnet: 40
  payees with their shares take about 1.7 KB. Creating a split costs more gas with every payee
  (see the table below); paying in and withdrawing hardly depend on the number of payees.
- **Each account once.** A list with an account twice is rejected (`DuplicatePayee`): add up its
  shares instead. Every payee then has one share and one withdrawal record.
- **No zero shares.** A share of zero is rejected (`ZeroShare`): an account with nothing to get
  does not belong on the list.
- **Rounding dust.** Each payee's part is rounded down, so less than one smallest unit per payee
  can stay in the contract after everyone has withdrawn (with 9 decimals, under 40 × 0.000000001
  TEST). It is not lost: the parts are computed from the total received, so the remainder is
  divided as soon as later payments make it divisible.
- **Shares are `u64`.** Their sum must fit in a `u64` (`SharesOverflow`), and a payment is refused
  if `received * total_shares` would not fit in a `U256` (`AmountTooLarge`).
- **The contract itself cannot be a payee** (`SplitterAsPayee`): it could never withdraw.
- **A contract may be a payee**, but `withdraw` pays the caller, so it gets its part only if it
  calls `withdraw` itself.

## Entry points

| Entry point | Who | What it does |
|---|---|---|
| `create_split(payees, shares)` | anyone | Creates a split: `payees[i]` gets `shares[i]` parts of every payment. |
| `pay(split_id, token, amount)` | anyone | Pulls `amount` of `token` from the caller into the split. |
| `withdraw(split_id, token)` | a payee | Sends the caller everything they are due in `token` and have not withdrawn. |
| `split(split_id)` | view | The split: creator, total shares, payees with their shares. |
| `splits_count()` | view | The number of splits. Ids run from `0` to `count - 1`. |
| `splits_of_creator(address)` | view | Ids of the splits the address created. |
| `splits_of_payee(address)` | view | Ids of the splits the address is a payee of. |
| `tokens_of(split_id)` | view | The tokens paid into the split, in the order of their first payment. |
| `received(split_id, token)` | view | What the split has received in the token. |
| `paid_out(split_id, token)` | view | What the payees have withdrawn in the token, together. |
| `released(split_id, token, payee)` | view | What the payee has withdrawn in the token. |
| `withdrawable(split_id, token, payee)` | view | What `withdraw` would send the payee now. |

The entry points that change state return nothing. The id of a new split is the value
`splits_count` returned before the call, and the `SplitCreated` event carries it.

### Events

| Event | Fields |
|---|---|
| `SplitCreated` | `split_id`, `creator`, `payees` (the number of them), `total_shares` |
| `PaymentReceived` | `split_id`, `token`, `payer`, `amount` |
| `PaymentWithdrawn` | `split_id`, `token`, `payee`, `amount` |

### Errors

| Code | Error | When |
|---|---|---|
| 1 | `NoPayees` | The list of payees is empty. |
| 2 | `TooManyPayees` | The list has more than 40 payees. |
| 3 | `LengthMismatch` | There is not exactly one share for every payee. |
| 4 | `ZeroShare` | One of the shares is zero. |
| 5 | `DuplicatePayee` | An account is listed twice. |
| 6 | `SharesOverflow` | The shares add up to more than fits in a `u64`. |
| 7 | `SplitterAsPayee` | The splitter contract itself is listed. |
| 8 | `SplitNotFound` | No split has this id. |
| 9 | `ZeroAmount` | The amount to pay in is zero. |
| 10 | `AmountTooLarge` | `received * total_shares` would not fit in a `U256`. |
| 11 | `NotPayee` | The caller of `withdraw` is not a payee of the split. |
| 12 | `NothingToWithdraw` | The caller has nothing to withdraw in this token. |

A failed token transfer reverts with the error of the token, for example `InsufficientAllowance`
(60002) when the payer has not approved enough.

### Gas

Measured on CasperVM in November 2026 (the test `the_demo_runs_and_reports_its_gas` prints it). The
deploy and the calls of the demo used exactly as much on the testnet.

| Transaction | Gas used |
|---|---|
| Deploying `Splitter` | 311.6 CSPR |
| `create_split` of 2 payees | 1.14 CSPR |
| `create_split` of 40 payees | 9.62 CSPR |
| `pay`, the first payment of a token into a split | 1.58 CSPR |
| `pay`, a later payment | 1.42 CSPR |
| `withdraw` | 1.35 CSPR |

## Things to know before using it

- **Not audited.** Review and test it yourself before putting real funds behind it.
- **Standard CEP-18 tokens only.** The contract records the amount it asked for. A token that takes a
  fee on transfer or changes balances on its own leaves the contract short, and the last payees
  cannot withdraw.
- **Anyone can pay any token into any split.** The list of a split's tokens grows with every new
  token, worthless ones included; the app shows them all.
- **A split cannot be changed or closed.** To change the shares, create a new split and pay into
  that one.
- **The list of an account's splits is one stored value.** Creating a split for an account that is
  on thousands of them costs more gas each time. Paying in and withdrawing do not read the list.

## Running it

You need Rust, the `wasm32-unknown-unknown` target and
[cargo-odra](https://github.com/odradev/cargo-odra). `wasm-opt` and `wasm-strip` are needed to
build wasm files; see the [installation guide](https://odra.dev/docs/getting-started/installation).

```bash
cargo odra test            # tests on OdraVM
cargo odra test -b casper  # builds the wasm files and runs the tests on CasperVM

# The gas of the deploy and of every call of the demo, on the wasm files `cargo odra build` wrote:
cargo odra build
ODRA_BACKEND=casper cargo test --lib the_demo -- --nocapture
```

The project depends on the `release/2.11.0` branch of Odra, not on a published version: the web
client of the published 2.10 sends transactions the testnet rejects.

## Deploying to the testnet

```bash
cp .env.sample .env        # then set the path of your secret key in .env
cargo odra build
cargo run --bin splitter_cli -- deploy
```

`resources/casper-test-contracts.toml` names the `TestToken` the vesting demo deployed, so `deploy`
loads it and deploys only `Splitter`. That cost 319.4 CSPR on the testnet in November 2026, with a
gas limit of 343 CSPR (`src/demo.rs`): 311.6 used, and three quarters of the rest refunded. A
second `deploy` reuses the saved address.

To see it working, take test tokens, create a split of three shares for you and one for a made-up
account, pay 100 TEST into it and withdraw your 75:

```bash
cargo run --bin splitter_cli -- scenario demo
cargo run --bin splitter_cli -- contract Splitter split --split_id 0
```

The demo sends five transactions (faucet, `create_split`, `approve`, `pay`, `withdraw`); on the
testnet they cost 6.8 CSPR together. `--payee <address>` names the other payee and `--tokens <n>`
the amount. `cargo run --bin splitter_cli -- --help` lists every command.

### Deployed on the testnet

| Contract | Package hash |
|---|---|
| `Splitter` | [`hash-f6d09da244b84973445c8005376dc95d91cdd0ebd080257135a0ce06cac1d4f2`](https://testnet.cspr.live/contract-package/f6d09da244b84973445c8005376dc95d91cdd0ebd080257135a0ce06cac1d4f2) |
| `TestToken` | [`hash-0fafe6f2e4481d7c2e1b3d031a3634dc37189d2ff9c97d064b6a203d4b47ffe4`](https://testnet.cspr.live/contract-package/0fafe6f2e4481d7c2e1b3d031a3634dc37189d2ff9c97d064b6a203d4b47ffe4) |

## The web app

The app in `web/` does two things with the contracts, in two different ways:

- **It reads state straight from the node's storage** with
  [odra-storage-reader](https://github.com/odradev/odra/tree/release/2.11.0/odra-storage-reader).
  The reader takes the schema of a contract (`resources/casper_contract_schemas/`) and says where a
  value is stored; the app fetches it over JSON-RPC and the reader decodes it. No contract code
  runs and nothing is signed, so the page shows any split before a wallet is connected.
  `web/src/storage.ts` holds all of it.
- **It sends transactions** through the client `cargo odra generate-client` generates from the
  contracts, signed with [CSPR.click](https://cspr.click) (Casper Wallet or Ledger).

What a payee can withdraw is computed in the browser from the stored split, what it received and
what the payee withdrew, with the same formula as the contract. Before a payment the app shows how
it will be divided, with the contract's rounding, and how much of it cannot be divided yet.

Tokens are read with the schema of `TestToken`. Another token is shown with its symbol and decimals
only if it stores them the same way, as tokens built on Odra's `Cep18` module do; otherwise the app
shows raw units.

```bash
# 1. Build the two wasm packages the app depends on. Needs wasm-pack.
cargo odra generate-client   # the transaction client: splitter_client/pkg-web (see the note below)
cd web
npm run reader               # the storage reader: storage_reader/pkg-web

# 2. Give the app the contract addresses and start it.
npm install
npm run contracts            # writes src/contracts.json from ../resources/casper-test-contracts.toml
npm run dev
```

`cargo odra generate-client` needs cargo-odra 0.2.1 or newer: 0.2.0 stops with `Project is not a
workspace`. Until 0.2.1 is on crates.io, install it from its branch:
`cargo install cargo-odra --locked --git https://github.com/odradev/cargo-odra --branch release/0.2.1`.

`npm run build` writes a static site to `web/dist`.

`web/src/contracts.json` in the repository holds the testnet addresses above, so `npm run
contracts` is needed only after deploying your own.

Run `cargo odra generate-client` again whenever an entry point, an event or an error of a contract
changes. The storage reader needs no rebuild: it reads the schema files, which `cargo odra build`
rewrites.
