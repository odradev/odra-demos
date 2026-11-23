# Timelock controller

Holds the admin rights of other contracts and makes every change wait a public delay before it can
run, so users see each change coming and have time to leave. Written in [Odra](https://odra.dev) for
[Casper](https://casper.network).

The project has five parts:

- `src/timelock.rs`: the `Timelock` contract and its tests.
- `src/fee_config.rs`: `FeeConfig`, a contract with one setting, a fee, for the timelock to govern
  in the demo.
- `bin/cli.rs`: a command line tool that deploys both and runs scenarios.
- `web/`: a web app for proposing a new fee, watching it wait and executing it with a Casper wallet.
- `storage_reader/`: builds [odra-storage-reader](https://github.com/odradev/odra/tree/release/2.11.0/odra-storage-reader), which the web app reads contract state with, to wasm.

## How it works

Casper contracts can be upgraded and reconfigured by whoever holds their admin key. Make the
timelock that admin, and every change goes through three steps:

```
  proposed               ready             executed
     o---------------------o-------------------●------> time
     |<----- the delay ---->|
      public: anyone can read
      what will change and when
```

1. A **proposer** schedules an operation: a call of one entry point of one contract, with its
   arguments, and a delay of at least the timelock's minimum delay.
2. The operation waits. It is stored in the timelock, so anyone can read it and the moment it
   becomes executable.
3. Once the delay has passed, an **executor** executes it: the timelock makes the call. Until then a
   **canceller**, or the proposer of the operation, can cancel it.

The target sees the timelock as the caller, so a contract owned by the timelock accepts the call.

The arguments of an operation are stored as `RuntimeArgs` in their bytesrepr serialization
(`Bytes`); the timelock checks that they decode when the operation is scheduled. Whatever the called
entry point returns is ignored. If the call fails, the whole transaction fails and the operation
stays ready to execute. Each operation runs once: it is marked executed before the call is made.

Operations get consecutive ids from 0, like the schedules of [vesting](../vesting/), rather than a
hash of their content: the same call can be proposed twice, and the web app lists operations by id.

### Roles

There are three roles, numbered for the entry points that take one: `1` proposer, `2` executor,
`3` canceller. The constructor sets their first holders. After that, roles change only through the
timelock itself: `grant_role` and `revoke_role` accept no caller but the timelock, so a change of
roles is an operation like any other and waits the same delay. A holder can give up its own role
with `renounce_role`.

`account-hash-0000000000000000000000000000000000000000000000000000000000000000` stands for anyone:
granted a role, it opens the role to every account. Opening the executor role is common, since an
executor can only run what was proposed and has waited; the demo deployment opens the proposer role
too, so visitors can try it.

### The minimum delay

`update_delay` changes the minimum delay, and like the roles it accepts only the timelock as the
caller: to change it, schedule an operation that calls `update_delay` on the timelock. No delay,
neither the minimum nor that of one operation, may exceed 30 days, so a mistaken or hostile change
cannot lock the timelock for good.

Times and delays are in milliseconds; times are block times, milliseconds since the Unix epoch.

## Entry points

### `Timelock`

| Entry point | Who | What it does |
|---|---|---|
| `init(min_delay, proposers, executors, cancellers)` | constructor | Sets the minimum delay and the first holders of each role. |
| `schedule(target, entry_point, args, delay)` | proposer | Proposes a call of `entry_point` of `target` with `args`, executable `delay` ms from now. |
| `execute(operation_id)` | executor | Makes the call of an operation whose delay has passed. |
| `cancel(operation_id)` | canceller, or the proposer of the operation | Cancels an operation that has not been executed. |
| `update_delay(new_delay)` | the timelock itself | Changes the minimum delay. |
| `grant_role(role, account)` | the timelock itself | Gives `account` a role. |
| `revoke_role(role, account)` | the timelock itself | Takes a role from `account`. |
| `renounce_role(role)` | a holder | Gives up a role the caller holds. |
| `operation(operation_id)` | view | The operation: `proposer`, `target`, `entry_point`, `args`, `proposed_at`, `ready_at`, `executed`, `cancelled`. |
| `operations_count()` | view | The number of operations. Ids run from `0` to `count - 1`. |
| `min_delay()` | view | The minimum delay, in ms. |
| `has_role(role, account)` | view | Whether `account` itself holds `role`. A role opened to anyone is reported for the zero address only. |

An operation is **pending** until `ready_at`, then **ready**; `executed` and `cancelled` say that
it is over. Pending and ready are not stored: they follow from `ready_at` and the clock.

The entry points that change state return nothing. The id of a new operation is the value
`operations_count` returned before the call, and the `OperationScheduled` event carries it.

### `FeeConfig`

| Entry point | Who | What it does |
|---|---|---|
| `init(owner, fee_bps)` | constructor | Sets the owner and the first fee. |
| `set_fee(fee_bps)` | the owner | Changes the fee, in basis points (`250` is 2.5%), at most 10,000. |
| `transfer_ownership(new_owner)` | the owner | Hands the contract to a new owner. |
| `fee_bps()` | view | The fee. |
| `owner()` | view | The owner. |

### Events

| Event | Fields |
|---|---|
| `OperationScheduled` | `operation_id`, `proposer`, `target`, `entry_point`, `args`, `ready_at` |
| `OperationExecuted` | `operation_id`, `executor` |
| `OperationCancelled` | `operation_id`, `canceller` |
| `MinDelayChanged` | `old_delay`, `new_delay` (the constructor emits it with `old_delay` 0) |
| `RoleGranted` | `role`, `account` |
| `RoleRevoked` | `role`, `account` |
| `FeeChanged` (`FeeConfig`) | `old_fee_bps`, `new_fee_bps` |
| `OwnershipTransferred` (`FeeConfig`) | `previous_owner`, `new_owner` |

### Errors

| Code | Error | When |
|---|---|---|
| 1 | `MissingRole` | The caller does not hold the role the entry point needs. |
| 2 | `NotTimelock` | Someone other than the timelock called `update_delay`, `grant_role` or `revoke_role`. |
| 3 | `DelayTooShort` | The delay is shorter than the minimum delay. |
| 4 | `DelayTooLong` | A delay is longer than 30 days. |
| 5 | `TargetNotContract` | The target is an account. |
| 6 | `EmptyEntryPoint` | The entry point name is empty. |
| 7 | `InvalidArgs` | `args` are not serialized `RuntimeArgs`. |
| 8 | `OperationNotFound` | No operation has this id. |
| 9 | `NotReady` | The delay of the operation has not passed. |
| 10 | `AlreadyExecuted` | The operation was executed before. |
| 11 | `AlreadyCancelled` | The operation was cancelled. |
| 12 | `UnknownRole` | The role is not 1, 2 or 3. |
| 100 | `NotOwner` (`FeeConfig`) | Someone other than the owner tried to change the fee or the owner. |
| 101 | `FeeTooHigh` (`FeeConfig`) | The fee is above 10,000 basis points. |

A call that fails inside `execute` reverts with the error of the target, for example `FeeTooHigh`
(101).

## Things to know before using it

- **Not audited.** Review and test it yourself before putting anything of value behind it.
- **A timelock protects only what it owns.** Hand it every admin right of a contract, its upgrade
  key included; a right kept elsewhere skips the delay.
- **The demo deployment is open.** Anyone may propose and execute on it, including a change of the
  minimum delay (up to 30 days) or of the roles, and anyone can take the fee contract by proposing
  `transfer_ownership`. Every such change is visible for a minute first, and the deployer may
  cancel. A real deployment lists its proposers.
- **A ready operation does not expire.** It stays ready until someone executes or cancels it.
- **The block time decides readiness.** It can lag the clock of your computer by a few seconds, so
  an `execute` sent right at `ready_at` may revert with `NotReady`.
- **No CSPR is attached** to the calls the timelock makes, so it cannot govern payable entry points.

## Running it

You need Rust, the `wasm32-unknown-unknown` target and
[cargo-odra](https://github.com/odradev/cargo-odra). `wasm-opt` and `wasm-strip` are needed to
build wasm files; see the [installation guide](https://odra.dev/docs/getting-started/installation).

```bash
cargo odra test            # tests on OdraVM
cargo odra test -b casper  # builds the wasm files and runs the tests on CasperVM
```

On CasperVM the contracts run as real wasm, so the tests show that the timelock calls another
contract, and itself (`update_delay`, `grant_role`), on the Casper execution engine.

The project depends on the `release/2.11.0` branch of Odra, not on a published version: the web
client of the published 2.10 sends transactions the testnet rejects.

## Deploying to the testnet

```bash
cp .env.sample .env        # then set the path of your secret key in .env
cargo odra build
cargo run --bin timelock_cli -- deploy
```

`deploy` deploys the timelock with a minimum delay of one minute, anyone as proposer and executor,
and the deployer as canceller; then `FeeConfig` with a fee of 1% and the timelock as its owner.
Deploying both cost 545.3 CSPR on the testnet in November 2026. The gas limits in `bin/cli.rs`,
345 CSPR for `Timelock` and 275 CSPR for `FeeConfig`, are a fifth above what the deploys use on
CasperVM (290.6 and 229.9 CSPR); unused gas is refunded only in part, so a higher limit costs more.
The addresses are saved to `resources/casper-test-contracts.toml`, and a second `deploy` reuses
them.

To see it working, propose a fee of 2.5%, then run the same scenario again a minute later to
execute it:

```bash
cargo run --bin timelock_cli -- scenario demo      # proposes; --fee_bps 300 for another fee
cargo run --bin timelock_cli -- scenario demo      # a minute later: executes
cargo run --bin timelock_cli -- contract FeeConfig fee_bps
```

Any other operation goes through the `propose` scenario, which takes the arguments of the call as
`name:type=value` (types `bool`, `u8`, `u32`, `u64`, `u128`, `u256`, `u512`, `i32`, `i64`, `string`,
`key`, `public_key`). For example, a minimum delay of two minutes:

```bash
cargo run --bin timelock_cli -- scenario propose \
  --target hash-<timelock> --entry_point update_delay --arg new_delay:u64=120000
cargo run --bin timelock_cli -- contract Timelock execute --operation_id <id> --gas 10000000000
cargo run --bin timelock_cli -- contract Timelock cancel --operation_id <id> --gas 5000000000
```

`cargo run --bin timelock_cli -- --help` lists every command.

On CasperVM, `schedule` uses 0.74 CSPR of gas, `execute` of a fee change 1.08 CSPR and `cancel`
0.47 CSPR. The limits the CLI and the web app set, 5 CSPR and 10 CSPR for `execute`, are estimates
with room to spare; the demo on the testnet, one `schedule` and one `execute`, cost 5.1 CSPR.

### Deployed on the testnet

| Contract | Package hash |
|---|---|
| `Timelock` | [`hash-49a1c722fe262dd39ca052ac88fabf0e221c5a1726bace7a90b944a1e2c1feef`](https://testnet.cspr.live/contract-package/49a1c722fe262dd39ca052ac88fabf0e221c5a1726bace7a90b944a1e2c1feef) |
| `FeeConfig` | [`hash-065e07774e20253c58a274a4876a0b3f13573553696b37c348d1c4ddefb83525`](https://testnet.cspr.live/contract-package/065e07774e20253c58a274a4876a0b3f13573553696b37c348d1c4ddefb83525) |

## The web app

The app in `web/` shows the fee and the timelock's minimum delay, lets you propose a new fee, and
lists the proposals, newest first, with their state and a countdown to the moment each can be
executed.

What it covers, and what only the CLI does:

- **In the app:** proposing a new fee (`set_fee` on `FeeConfig`), executing and cancelling any
  proposal, and reading every proposal. A proposal of another kind is described in words when the
  app knows it (a new minimum delay, a role, a new owner of the fee contract), and as its entry
  point and arguments otherwise.
- **Only in the CLI:** proposing anything else: a new minimum delay, a role change, a call of
  another contract. Writing arbitrary arguments in a browser is out of scope, and the app leaves out
  a change of the delay on purpose: on this open demo, one click could make every visitor wait 30
  days.

It works with the contracts in two different ways:

- **It reads state straight from the node's storage** with
  [odra-storage-reader](https://github.com/odradev/odra/tree/release/2.11.0/odra-storage-reader);
  `web/src/storage.ts` holds all of it. No contract code runs and nothing is signed to read, so
  the page shows the proposals before a wallet is connected. The countdowns are computed in the
  browser from the stored `ready_at` and the clock.
- **It sends transactions** through the client `cargo odra generate-client` generates from the
  contracts, signed with [CSPR.click](https://cspr.click) (Casper Wallet or Ledger). The client
  takes the `args` of `schedule` as bytes; the app writes the `RuntimeArgs` of `set_fee` itself, a
  few lines in `web/src/main.ts` whose output a test of the contract pins
  (`arguments_are_serialized_as_the_web_app_writes_them`).

Its look is the Odra web style shared by every project of this repository; see
[`../style/`](../style/).

```bash
# 1. Build the two wasm packages the app depends on. Needs wasm-pack.
cargo odra build             # writes the schemas the app reads storage with
cargo odra generate-client   # the transaction client: timelock_client/pkg-web (see the note below)
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
