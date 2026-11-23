# Multisend

Sends CSPR or a CEP-18 token to many recipients in one transaction, signed once. Either everyone
on the list is paid or, if anything is wrong, nobody is. Written in [Odra](https://odra.dev) for
[Casper](https://casper.network).

The project has five parts:

- `src/multisend.rs`: the `Multisend` contract and its tests.
- `src/token.rs`: `TestToken`, a CEP-18 token with a public faucet, for trying the contract on a test network.
- `bin/cli.rs`: a command line tool that deploys both and runs a demo.
- `web/`: a web app that takes a pasted list of recipients and amounts and sends it with a Casper wallet.
- `storage_reader/`: builds [odra-storage-reader](https://github.com/odradev/odra/tree/release/2.11.0/odra-storage-reader), which the web app reads balances with, to wasm.

## How it works

The contract keeps no state and holds no funds between calls. It has no owner, no fees and no
upgrade key.

- **CSPR**: the caller attaches the sum of the amounts to `send_cspr`, and the contract pays each
  recipient out of it. A call with any other sum attached reverts.
- **Tokens**: the caller approves the contract for the sum, and `send_token` moves each amount
  straight from the caller to its recipient with `transfer_from`. The contract never holds the
  tokens, and a finished call leaves no allowance behind.

A recipient may appear on the list more than once.

## Entry points

| Entry point | What it does |
|---|---|
| `send_cspr(recipients, amounts)` | Payable. Sends `amounts[i]` motes to `recipients[i]`. The attached CSPR must equal the sum. |
| `send_token(token, recipients, amounts)` | Sends `amounts[i]` of the CEP-18 `token` from the caller to `recipients[i]`. Needs an allowance of the sum. |

### Events

| Event | Fields |
|---|---|
| `CsprSent` | `sender`, `recipients` (how many), `total` |
| `TokenSent` | `sender`, `token`, `recipients` (how many), `total` |

### Errors

| Code | Error | When |
|---|---|---|
| 1 | `NoRecipients` | The list of recipients is empty. |
| 2 | `LengthMismatch` | There is not exactly one amount for every recipient. |
| 3 | `ZeroAmount` | One of the amounts is zero. |
| 4 | `WrongAttachedValue` | The CSPR attached to `send_cspr` is not the sum of the amounts. |
| 5 | `AmountOverflow` | The amounts add up to more than their type holds. |

A failed token transfer reverts the whole call with the error of the token: `InsufficientAllowance`
(60002), `InsufficientBalance` (60001), or `CannotTargetSelfUser` (60003) when the sender is on
their own list.

## Things to know before using it

- **Not audited.** Review and test it yourself before putting real funds behind it.
- **It saves signing, not fees.** Measured on the testnet in November 2026, a token send used
  0.2 CSPR of gas plus 1.0 CSPR per recipient, and a CSPR send 4.7 CSPR plus 2.1 CSPR per recipient.
  A plain CSPR transfer costs 0.1 CSPR, so paying a list with separate transfers is cheaper. What
  the contract gives is one signature, one transaction to track, and all-or-nothing.
- **About 50 recipients fit in one transaction.** The arguments of a transaction are limited in
  size: on the testnet 50 recipients went through and 60 were rejected before execution. The web
  app stops at 40.
- **Standard CEP-18 tokens only.** A token that takes a fee on transfer delivers less than the
  amounts on the list.

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

## Deploying to the testnet

```bash
cp .env.sample .env        # then set the path of your secret key in .env
cargo odra build
cargo run --bin multisend_cli -- deploy
```

Deploying `Multisend` cost 282 CSPR on the testnet in November 2026. The addresses are saved to
`resources/casper-test-contracts.toml`, and a second `deploy` reuses them. The file in the
repository already lists a `TestToken`, the one deployed for the [vesting](../vesting/) project, so
`deploy` does not deploy another; remove that entry to deploy your own.

To see it working, send 10 TEST to each of two accounts in one transaction:

```bash
cargo run --bin multisend_cli -- scenario demo \
  --recipient account-hash-<first> --recipient account-hash-<second>
```

Add `--cspr 2500000000` to send 2.5 CSPR to each of them as well, in a second transaction.
`cargo run --bin multisend_cli -- --help` lists every command.

### Deployed on the testnet

| Contract | Package hash |
|---|---|
| `Multisend` | [`hash-52e9f322a88e0b3455113bb56ddffd52035cccfc97d13e76551f30a9d141f2e5`](https://testnet.cspr.live/contract-package/52e9f322a88e0b3455113bb56ddffd52035cccfc97d13e76551f30a9d141f2e5) |
| `TestToken` | [`hash-0fafe6f2e4481d7c2e1b3d031a3634dc37189d2ff9c97d064b6a203d4b47ffe4`](https://testnet.cspr.live/contract-package/0fafe6f2e4481d7c2e1b3d031a3634dc37189d2ff9c97d064b6a203d4b47ffe4) (shared with vesting) |

## The web app

The app in `web/` takes a list pasted as text, one recipient per line (`address, amount`), shows
it as a table to check, and sends it.

- **It reads balances and allowances straight from the node's storage** with
  [odra-storage-reader](https://github.com/odradev/odra/tree/release/2.11.0/odra-storage-reader);
  `web/src/storage.ts` holds all of it. No contract code runs and nothing is signed to read.
- **It sends transactions** through the client `cargo odra generate-client` generates from the
  contracts, signed with [CSPR.click](https://cspr.click) (Casper Wallet or Ledger). A token send
  is two transactions, an approval and the send; a CSPR send is one.

Its look is the Odra web style shared by every project of this repository; see
[`../style/`](../style/).

```bash
# 1. Build the two wasm packages the app depends on. Needs wasm-pack.
cargo odra generate-client   # the transaction client: multisend_client/pkg-web (see the note below)
cd web
npm run reader               # the storage reader: storage_reader/pkg-web

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

Tokens are read with the schema of `TestToken`. Another token is shown with its symbol and decimals
only if it stores them the same way, as tokens built on Odra's `Cep18` module do.
