# Payment streaming

Pays a recipient continuously: the sender deposits CEP-18 tokens, and the recipient can withdraw the
share that has accrued up to the current block time. Written in [Odra](https://odra.dev) for
[Casper](https://casper.network).

The project has five parts:

- `src/streaming.rs`: the `Streaming` contract and its tests.
- `src/token.rs`: `TestToken`, a CEP-18 token with a public faucet, for trying the contract on a test network.
- `bin/cli.rs`: a command line tool that deploys both and runs scenarios.
- `web/`: a web app for starting, withdrawing from and stopping streams with a Casper wallet.
- `storage_reader/`: builds [odra-storage-reader](https://github.com/odradev/odra/tree/release/2.11.0/odra-storage-reader), which the web app reads contract state with, to wasm.

## How it works

Anyone can stream any CEP-18 token to anyone. The contract has no owner, no fees and no upgrade key.
One deployed contract holds every stream, of every token.

A stream has a deposit and two moments: `start` and `stop`.

```
accrued
  ^
  |                        ___________  deposit
  |                      /
  |                    /
  |                  /
  |                /
  |              /
  |____________/                         0
  +-----------+------------+---------> time
            start         stop
```

- Before `start`, nothing has accrued.
- Between `start` and `stop`, the accrued amount is `deposit * (now - start) / (stop - start)`,
  rounded down.
- From `stop` on, the whole deposit has accrued.

Times are block times: milliseconds since the Unix epoch, with `start < stop`. A `start` in the past
is allowed; the part of the deposit for the time already passed is accrued at once.

The sender funds the stream when creating it: the contract pulls the deposit with `transfer_from`,
so the sender approves the contract first.

The recipient withdraws any amount up to what has accrued and was not withdrawn yet, as often as
they like.

The sender can cancel the stream at any time. What has accrued and was not withdrawn goes to the
recipient, the rest of the deposit back to the sender, both in the same transaction. Nothing is left
in the contract and nothing accrues afterwards.

## Entry points

| Entry point | Who | What it does |
|---|---|---|
| `create_stream(recipient, token, deposit, start, stop)` | anyone | Creates a stream and pulls `deposit` of `token` from the caller. |
| `withdraw(stream_id, amount)` | the recipient | Sends `amount` of what has accrued to the recipient. |
| `cancel(stream_id)` | the sender | Pays the recipient what has accrued and refunds the rest to the sender. |
| `stream(stream_id)` | view | The stream. |
| `balance_of(stream_id, who)` | view | What `who` would get now: for the recipient, the accrued and not withdrawn part; for the sender, the part not accrued yet; zero for anyone else. |
| `streams_count()` | view | The number of streams. Ids run from `0` to `count - 1`. |
| `streams_of_sender(address)` | view | Ids of the streams the address sends. |
| `streams_of_recipient(address)` | view | Ids of the streams the address receives. |

The entry points that change state return nothing. The id of a new stream is the value
`streams_count` returned before the call, and the `StreamCreated` event carries it.

A stream keeps `withdrawn`, the amount paid to the recipient so far, so what the recipient can
withdraw is `accrued - withdrawn`. Cancelling sets `withdrawn` to what had accrued, `refunded` to
what went back and `cancelled` to `true`.

### Events

| Event | Fields |
|---|---|
| `StreamCreated` | `stream_id`, `sender`, `recipient`, `token`, `deposit`, `start`, `stop` |
| `Withdrawn` | `stream_id`, `recipient`, `amount` |
| `StreamCancelled` | `stream_id`, `sender`, `recipient`, `paid`, `refunded` |

### Errors

| Code | Error | When |
|---|---|---|
| 1 | `ZeroAmount` | The deposit or the amount to withdraw is zero. |
| 2 | `InvalidTimes` | `start` is not before `stop`. |
| 3 | `AmountTooLarge` | `deposit * (stop - start)` does not fit in a `U256`. |
| 4 | `StreamNotFound` | No stream has this id. |
| 5 | `NotRecipient` | Someone other than the recipient tried to withdraw. |
| 6 | `NotSender` | Someone other than the sender tried to cancel. |
| 7 | `AmountExceedsBalance` | The amount is more than has accrued and was not withdrawn. |
| 8 | `AlreadyCancelled` | The stream was cancelled before. |

A failed token transfer reverts with the error of the token, for example `InsufficientAllowance`
(60002) when the sender has not approved enough.

## Things to know before using it

- **Not audited.** Review and test it yourself before putting real funds behind it.
- **Standard CEP-18 tokens only.** The contract records the amount it asked for. A token that takes a
  fee on transfer or changes balances on its own leaves the contract short, and the last
  recipients cannot withdraw.
- **Accrual follows block time.** A block's time is when it was proposed, so a transaction sees the
  amount accrued at its block, not at the moment it was signed. Asking for exactly what a clock
  says has accrued fails with `AmountExceedsBalance` if that clock runs ahead of the network; the
  web app counts "withdraw all" 15 seconds back.
- **`balance_of` adds up both sides when the sender streams to themselves.** It returns the
  recipient's part plus the sender's, which is the whole deposit left. Compute what can be
  withdrawn from `stream` and the time instead, as the CLI and the web app do.
- **Only the recipient can withdraw**, and the recipient cannot be changed after the stream is
  created. Only the sender can cancel; there is no way to create a stream that cannot be cancelled.
- **The list of an account's streams is one stored value.** Creating a stream for an account that
  has thousands of them costs more gas each time. Withdrawing and cancelling do not read the list.

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
cargo run --bin streaming_cli -- deploy
```

Deploying `Streaming` cost 314 CSPR on the testnet in November 2026 (285.3 CSPR consumed of the
400 CSPR limit in `bin/cli.rs`; 75% of the unused part comes back). `TestToken` is the one the
vesting project deployed, listed in `resources/casper-test-contracts.toml` before the first
`deploy`, so it was reused. The addresses are saved to that file, and a second `deploy` reuses them.

To see it working, stream 100 TEST to yourself over 10 minutes and withdraw half of what has accrued
by the time the stream is created:

```bash
cargo run --bin streaming_cli -- scenario demo
cargo run --bin streaming_cli -- contract Streaming stream --stream_id 0
cargo run --bin streaming_cli -- contract Streaming withdraw --stream_id 0 --amount 10000000000 --gas 6000000000
cargo run --bin streaming_cli -- contract Streaming cancel --stream_id 0 --gas 8000000000
```

On the testnet, creating a stream consumed 2.06 CSPR, `faucet` 0.30 CSPR and `approve` 0.36 CSPR.
The gas limits of the scenario and of the web app (5 to 10 CSPR a call) are estimates with room to
spare. A transaction that fails is charged its whole limit, with no refund.

`cargo run --bin streaming_cli -- --help` lists every command.

### Deployed on the testnet

| Contract | Package hash |
|---|---|
| `Streaming` | [`hash-b0626afd8620f08db0e7c6a9a8b68a5269babfc5545a24ee06c271dc0c9bc1c6`](https://testnet.cspr.live/contract-package/b0626afd8620f08db0e7c6a9a8b68a5269babfc5545a24ee06c271dc0c9bc1c6) |
| `TestToken` | [`hash-0fafe6f2e4481d7c2e1b3d031a3634dc37189d2ff9c97d064b6a203d4b47ffe4`](https://testnet.cspr.live/contract-package/0fafe6f2e4481d7c2e1b3d031a3634dc37189d2ff9c97d064b6a203d4b47ffe4) |

## The web app

The app in `web/` does two things with the contracts, in two different ways:

- **It reads state straight from the node's storage** with
  [odra-storage-reader](https://github.com/odradev/odra/tree/release/2.11.0/odra-storage-reader).
  The reader takes the schema of a contract (`resources/casper_contract_schemas/`) and says where a
  value is stored; the app fetches it over JSON-RPC and the reader decodes it. No contract code
  runs and nothing is signed, so the page shows streams before a wallet is connected.
  `web/src/storage.ts` holds all of it.
- **It sends transactions** through the client `cargo odra generate-client` generates from the
  contracts, signed with [CSPR.click](https://cspr.click) (Casper Wallet or Ledger).

The accrued amount of a stream is computed in the browser from the stored stream and the clock,
with the same formula as the contract, and repainted every second.

Tokens are read with the schema of `TestToken`. Another token is shown with its symbol and decimals
only if it stores them the same way, as tokens built on Odra's `Cep18` module do; otherwise the app
shows raw units.

```bash
# 1. Build the two wasm packages the app depends on. Needs wasm-pack.
cargo odra build             # writes the schemas the app reads with
cargo odra generate-client   # the transaction client: streaming_client/pkg-web
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

Run `cargo odra generate-client` again whenever an entry point, an event or an error of a contract
changes. The storage reader needs no rebuild: it reads the schema files, which `cargo odra build`
rewrites.
