# Liquidity locker

Locks CEP-18 tokens, typically the liquidity-pool tokens of a DEX pair, until a set date, so anyone
can check on chain that a project cannot pull its liquidity before it. Written in
[Odra](https://odra.dev) for [Casper](https://casper.network).

The project has five parts:

- `src/locker.rs`: the `Locker` contract and its tests.
- `src/token.rs`: `TestToken`, a CEP-18 token with a public faucet, for trying the contract on a test network. It is the token of `vesting/`, deployed once and shared by the demos.
- `bin/cli.rs`: a command line tool that deploys the contract and runs a scenario.
- `web/`: a web app for locking tokens with a Casper wallet, and for looking up what is locked for any token without one.
- `storage_reader/`: builds [odra-storage-reader](https://github.com/odradev/odra/tree/release/2.11.0/odra-storage-reader), which the web app reads contract state with, to wasm.

## How it works

Anyone can lock any CEP-18 token. The contract has no owner, no fees and no upgrade key. One
deployed contract holds every lock, of every token.

A lock has an owner, a token, an amount and an unlock time.

```
 locked                       unlock time      extended
   |                               |               |
   |===============================|- - - - - - - -|------------> time
   |   nobody can take the tokens     only later       the owner may withdraw
```

- `lock` pulls the tokens from the caller with `transfer_from`, so the caller approves the contract
  first. The caller owns the lock. The unlock time must be in the future.
- Before the unlock time, nothing can take the tokens out: not the owner, not anyone else.
- `extend` moves the unlock time later, never earlier. It works on an expired lock too, as long as
  its tokens have not been withdrawn: a project can renew a lock without unlocking it.
- `transfer_ownership` hands the lock to another account, which from then on is the only one that
  can extend, hand over or withdraw it.
- From the unlock time on, the owner can `withdraw`: the whole amount goes to the owner, and the lock
  is marked as withdrawn. There are no partial withdrawals.

Times are block times: milliseconds since the Unix epoch.

The contract keeps what a third party needs to check a token: the ids of every lock of a token
(withdrawn ones included, so the history stays visible) and the amount of the token the contract
holds, which drops when a lock is withdrawn.

## Entry points

| Entry point | Who | What it does |
|---|---|---|
| `lock(token, amount, unlock_time)` | anyone | Locks `amount` of `token` until `unlock_time` and pulls it from the caller, who owns the lock. |
| `extend(lock_id, new_unlock_time)` | the owner | Moves the unlock time later. |
| `transfer_ownership(lock_id, new_owner)` | the owner | Hands the lock over to `new_owner`. |
| `withdraw(lock_id)` | the owner | Sends the tokens to the owner, at or after the unlock time. |
| `get_lock(lock_id)` | view | The lock. |
| `locks_count()` | view | The number of locks. Ids run from `0` to `count - 1`. |
| `locks_of(owner)` | view | Ids of the locks the address owns now, withdrawn ones included. |
| `locks_of_token(token)` | view | Ids of every lock of the token, withdrawn ones included. |
| `locked_amount(token)` | view | The amount of the token the contract holds: locks not withdrawn yet, expired ones included. |

The entry points that change state return nothing. The id of a new lock is the value `locks_count`
returned before the call, and the `Locked` event carries it.

`extend`, `transfer_ownership` and `withdraw` refuse a lock whose tokens have been withdrawn.

### Events

| Event | Fields |
|---|---|
| `Locked` | `lock_id`, `owner`, `token`, `amount`, `unlock_time` |
| `LockExtended` | `lock_id`, `previous_unlock_time`, `unlock_time` |
| `OwnershipTransferred` | `lock_id`, `previous_owner`, `new_owner` |
| `Withdrawn` | `lock_id`, `owner`, `token`, `amount` |

### Errors

| Code | Error | When |
|---|---|---|
| 1 | `ZeroAmount` | The amount to lock is zero. |
| 2 | `UnlockTimeNotInFuture` | The unlock time is now or in the past. |
| 3 | `LockNotFound` | No lock has this id. |
| 4 | `NotOwner` | Someone other than the owner tried to extend, hand over or withdraw. |
| 5 | `StillLocked` | `withdraw` before the unlock time. |
| 6 | `AlreadyWithdrawn` | The tokens of the lock were withdrawn before. |
| 7 | `NotLater` | The new unlock time is not later than the current one. |
| 8 | `AlreadyOwner` | `transfer_ownership` to the current owner. |

A failed token transfer reverts with the error of the token, for example `InsufficientAllowance`
(60002) when the caller has not approved enough.

## Things to know before using it

- **Not audited.** Review and test it yourself before putting real funds behind it.
- **Handing a lock over does not unlock it.** The tokens stay locked until the same date; only who
  withdraws them afterwards changes. Check the owner of a lock, not only its date.
- **What a lock says about a pool.** A lock shows that some pool tokens cannot move. Whether that
  protects the liquidity depends on the share of the pool tokens locked and on who holds the rest:
  compare the locked amount with the token's supply.
- **Standard CEP-18 tokens only.** The contract records the amount it asked for. A token that takes a
  fee on transfer or changes balances on its own leaves the contract short, and the last owner to
  withdraw cannot.
- **The lists are stored values.** The ids of the locks of a token, or of an owner, are one stored
  list each. Adding a lock to a list with thousands of entries costs more gas each time, and handing
  a lock over rewrites the list of the previous owner.

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
cargo run --bin locker_cli -- deploy
```

`resources/casper-test-contracts.toml` lists the `TestToken` of `vesting/`, so `deploy` deploys only
`Locker`; delete that entry to deploy a token of your own as well. A second `deploy` reuses what is
listed. Deploying `Locker` cost 310.3 CSPR on the testnet in November 2026: 280.4 CSPR of gas
consumed against the 400 CSPR limit in `bin/cli.rs`, plus the quarter of the unused gas that is
not refunded.

To see it working, lock 100 TEST for 10 minutes, then withdraw them once the lock expires:

```bash
cargo run --bin locker_cli -- scenario demo
cargo run --bin locker_cli -- contract Locker get_lock --lock_id 0
cargo run --bin locker_cli -- contract Locker locked_amount --token hash-0fafe6f2e4481d7c2e1b3d031a3634dc37189d2ff9c97d064b6a203d4b47ffe4
cargo run --bin locker_cli -- contract Locker withdraw --lock_id 0 --gas 8000000000
```

The demo cost 7.1 CSPR on the testnet: about 1.5 CSPR each for the faucet and the approval, and
4.1 CSPR for the lock (2.1 CSPR of gas consumed against a 10 CSPR limit). The gas limits in
`bin/cli.rs` and in the web app are estimates with a margin.

`cargo run --bin locker_cli -- --help` lists every command.

### Deployed on the testnet

| Contract | Package hash |
|---|---|
| `Locker` | [`hash-7677cedb46c36e2ca04eb8cde0252c2f38777b1cee20ddf4833ac8eff686166e`](https://testnet.cspr.live/contract-package/7677cedb46c36e2ca04eb8cde0252c2f38777b1cee20ddf4833ac8eff686166e) |
| `TestToken` | [`hash-0fafe6f2e4481d7c2e1b3d031a3634dc37189d2ff9c97d064b6a203d4b47ffe4`](https://testnet.cspr.live/contract-package/0fafe6f2e4481d7c2e1b3d031a3634dc37189d2ff9c97d064b6a203d4b47ffe4) |

## The web app

The app in `web/` serves two readers. A project locks its tokens, extends a lock, hands it over
and withdraws it with a Casper wallet. A visitor pastes the address of a token and sees, without a
wallet, how much of it is locked, what share of the supply that is, when the next lock opens, and
every lock with its owner and unlock date. The token shown is part of the page address
(`#token=hash-…`), so a project can link to the view of its own token.

It works with the contracts in two different ways:

- **It reads state straight from the node's storage** with
  [odra-storage-reader](https://github.com/odradev/odra/tree/release/2.11.0/odra-storage-reader).
  The reader takes the schema of a contract (`resources/casper_contract_schemas/`) and says where a
  value is stored; the app fetches it over JSON-RPC and the reader decodes it. No contract code
  runs and nothing is signed, so the page shows locks before a wallet is connected.
  `web/src/storage.ts` holds all of it.
- **It sends transactions** through the client `cargo odra generate-client` generates from the
  contracts, signed with [CSPR.click](https://cspr.click) (Casper Wallet or Ledger).

Whether a lock is still locked is decided in the browser from its stored unlock time and the
clock, as the contract decides it from the block time.

Tokens are read with the schema of `TestToken`. Another token is shown with its symbol, decimals
and supply only if it stores them the same way, as tokens built on Odra's `Cep18` module do;
otherwise the app shows raw units and no share of the supply.

```bash
# 1. Build the two wasm packages the app depends on. Needs wasm-pack.
cargo odra build             # writes the contract schemas the app imports
cargo odra generate-client   # the transaction client: locker_client/pkg-web (see the note below)
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
