# Token vesting

Locks CEP-18 tokens for a beneficiary and releases them over time: nothing before the cliff, then
linearly until the end date. Written in [Odra](https://odra.dev) for [Casper](https://casper.network).

The project has five parts:

- `src/vesting.rs`: the `Vesting` contract and its tests.
- `src/token.rs`: `TestToken`, a CEP-18 token with a public faucet, for trying the contract on a test network.
- `bin/cli.rs`: a command line tool that deploys both and runs scenarios.
- `web/`: a web app for creating, releasing and revoking schedules with a Casper wallet.
- `storage_reader/`: builds [odra-storage-reader](https://github.com/odradev/odra/tree/release/2.11.0/odra-storage-reader), which the web app reads contract state with, to wasm.

## How it works

Anyone can create a schedule for any CEP-18 token. The contract has no owner, no fees and no upgrade
key. One deployed contract holds every schedule, of every token.

A schedule has a total amount and three moments: `start`, `cliff` and `end`.

```
vested
  ^
  |                        ___________  total
  |                      /
  |                    /
  |                  /
  |                |
  |________________|                     0
  +----+-----------+-----+-----------> time
     start       cliff  end
```

- Before `cliff`, nothing is vested.
- Between `cliff` and `end`, the vested amount is `total * (now - start) / (end - start)`, rounded
  down. The line is counted from `start`, so at the cliff the amount jumps to the share of the time
  that has already passed.
- From `end` on, everything is vested.

Times are block times: milliseconds since the Unix epoch. They must satisfy `start <= cliff <= end`
and `start < end`. A `start` in the past is allowed. With `cliff == end` the schedule is a plain
timelock: everything unlocks at once.

The creator funds the schedule when creating it: the contract pulls the tokens with
`transfer_from`, so the creator approves the contract first.

If the schedule was created as revocable, the creator can revoke it. The tokens that have not
vested go back to the creator. The tokens that have vested stay in the contract for the
beneficiary, and nothing more vests afterwards.

## Entry points

| Entry point | Who | What it does |
|---|---|---|
| `create_schedule(beneficiary, token, amount, start, cliff, end, revocable)` | anyone | Creates a schedule and pulls `amount` of `token` from the caller. |
| `release(schedule_id)` | anyone | Sends everything vested and not yet released to the beneficiary. |
| `revoke(schedule_id)` | the creator | Stops a revocable schedule and refunds the unvested tokens. |
| `schedule(schedule_id)` | view | The schedule. |
| `vested(schedule_id)` | view | The amount vested so far, including what was released. |
| `releasable(schedule_id)` | view | The amount `release` would send now. |
| `schedules_count()` | view | The number of schedules. Ids run from `0` to `count - 1`. |
| `schedules_of_beneficiary(address)` | view | Ids of the schedules the address receives tokens from. |
| `schedules_of_creator(address)` | view | Ids of the schedules the address created. |

The entry points that change state return nothing. The id of a new schedule is the value
`schedules_count` returned before the call, and the `ScheduleCreated` event carries it.

### Events

| Event | Fields |
|---|---|
| `ScheduleCreated` | `schedule_id`, `creator`, `beneficiary`, `token`, `amount`, `start`, `cliff`, `end`, `revocable` |
| `TokensReleased` | `schedule_id`, `beneficiary`, `amount` |
| `ScheduleRevoked` | `schedule_id`, `creator`, `refunded` |

### Errors

| Code | Error | When |
|---|---|---|
| 1 | `ZeroAmount` | The amount to vest is zero. |
| 2 | `InvalidTimes` | The times are not in order, or `start == end`. |
| 3 | `AmountTooLarge` | `amount * (end - start)` does not fit in a `U256`. |
| 4 | `ScheduleNotFound` | No schedule has this id. |
| 5 | `NothingToRelease` | Nothing has vested since the last release. |
| 6 | `NotCreator` | Someone other than the creator tried to revoke. |
| 7 | `NotRevocable` | The schedule was created as not revocable. |
| 8 | `AlreadyRevoked` | The schedule was revoked before. |

A failed token transfer reverts with the error of the token, for example `InsufficientAllowance`
(60002) when the creator has not approved enough.

## Things to know before using it

- **Not audited.** Review and test it yourself before putting real funds behind it.
- **Standard CEP-18 tokens only.** The contract records the amount it asked for. A token that takes a
  fee on transfer or changes balances on its own leaves the contract short, and the last
  beneficiaries cannot release.
- **Anyone can release.** The tokens always go to the beneficiary, so a third party can only pay
  the gas for them.
- **The beneficiary cannot be changed** after the schedule is created.
- **The list of an account's schedules is one stored value.** Creating a schedule for an account
  that has thousands of them costs more gas each time. Releasing and revoking do not read the list.

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
cargo run --bin vesting_cli -- deploy
```

Deploying both contracts cost 632.5 CSPR on the testnet in November 2026; the gas limit in
`bin/cli.rs` is 400 CSPR per contract. The addresses are saved to
`resources/casper-test-contracts.toml`, and a second `deploy` reuses them.

To see it working, vest 100 TEST to yourself over 10 minutes and release once the cliff, two
minutes in, has passed:

```bash
cargo run --bin vesting_cli -- scenario demo
cargo run --bin vesting_cli -- contract Vesting releasable --schedule_id 0
cargo run --bin vesting_cli -- contract Vesting release --schedule_id 0 --gas 6000000000
cargo run --bin vesting_cli -- contract Vesting schedule --schedule_id 0
```

`cargo run --bin vesting_cli -- --help` lists every command.

### Deployed on the testnet

| Contract | Package hash |
|---|---|
| `Vesting` | [`hash-8276541bdd93b4673be019b88a21624d93d2a61acb6acc8069a36e2e34fd54e4`](https://testnet.cspr.live/contract-package/8276541bdd93b4673be019b88a21624d93d2a61acb6acc8069a36e2e34fd54e4) |
| `TestToken` | [`hash-0fafe6f2e4481d7c2e1b3d031a3634dc37189d2ff9c97d064b6a203d4b47ffe4`](https://testnet.cspr.live/contract-package/0fafe6f2e4481d7c2e1b3d031a3634dc37189d2ff9c97d064b6a203d4b47ffe4) |

## The web app

The app in `web/` does two things with the contracts, in two different ways:

- **It reads state straight from the node's storage** with
  [odra-storage-reader](https://github.com/odradev/odra/tree/release/2.11.0/odra-storage-reader).
  The reader takes the schema of a contract (`resources/casper_contract_schemas/`) and says where a
  value is stored; the app fetches it over JSON-RPC and the reader decodes it. No contract code
  runs and nothing is signed, so the page shows schedules before a wallet is connected.
  `web/src/storage.ts` holds all of it.
- **It sends transactions** through the client `cargo odra generate-client` generates from the
  contracts, signed with [CSPR.click](https://cspr.click) (Casper Wallet or Ledger).

The vested amount of a schedule is computed in the browser from the stored schedule and the clock,
with the same formula as the contract.

Tokens are read with the schema of `TestToken`. Another token is shown with its symbol and decimals
only if it stores them the same way, as tokens built on Odra's `Cep18` module do; otherwise the app
shows raw units.

```bash
# 1. Build the two wasm packages the app depends on. Needs wasm-pack.
cargo odra generate-client   # the transaction client: vesting_client/pkg-web (see the note below)
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
