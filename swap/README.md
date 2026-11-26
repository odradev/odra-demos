# OTC swap

Two parties swap two CEP-18 tokens in one transaction, at a price they agreed beforehand: the
maker puts their tokens in the contract and names what they want for them; the taker sends that
and gets the maker's tokens in the same transaction. No pool and no slippage: the whole offer at
its price, or nothing. Written in [Odra](https://odra.dev) for [Casper](https://casper.network).

The project has five parts:

- `src/swap.rs`: the `OtcSwap` contract and its tests.
- `src/token.rs`: two CEP-18 tokens with a public faucet, for trying the contract on a test network. `TestToken` (TEST, 9 decimals) is the token of `vesting/`, deployed once and shared by the demos; `TestDollar` (TUSD, 6 decimals) is the second token a swap needs.
- `src/demo.rs` and `bin/cli.rs`: a command line tool that deploys the contracts and runs the demo scenario, which a CasperVM test runs first.
- `web/`: a web app for making an offer and sending its link, taking an offer from a link, and cancelling one's own offers.
- `storage_reader/`: builds [odra-storage-reader](https://github.com/odradev/odra/tree/release/2.11.0/odra-storage-reader), which the web app reads contract state with, to wasm.

## How it works

Anyone can make an offer between any two CEP-18 tokens. The contract has no owner, no fees and no
upgrade key. One deployed contract holds every offer.

```
             make_offer (maker)                    take (taker, before the expiry)
   tokens ------------------------> Open -------------------------------> Taken
   of the maker are pulled            |      want_amount: taker -> maker
   into the contract                  |      give_amount: contract -> taker
                                      |
                                      |  cancel (maker, any time until taken)
                                      +-------------------------------> Cancelled
                                             give_amount: contract -> maker
```

- `make_offer(give_token, give_amount, want_token, want_amount, taker, expiry)` pulls
  `give_amount` from the maker with `transfer_from`, so the maker approves the contract first. Both
  amounts must be above zero, the tokens must differ and `expiry` must be in the future.
- `taker` is optional. With an account, only that account may take the offer. With `None`, anyone
  may, and the offer is listed among the open public offers.
- `take(offer_id)` moves `want_amount` of `want_token` from the taker to the maker with
  `transfer_from`, so the taker approves the contract first, and sends the held `give_amount` to
  the taker. Both legs run in the one transaction: if either fails, the transaction reverts and
  nothing moves. It reverts from the expiry on, and for an account other than the named taker.
- `cancel(offer_id)` sends the held tokens back to the maker. Only the maker may call it, at any
  time until the offer is taken, also after the expiry: an offer nobody takes never locks the
  tokens.

Times are block times: milliseconds since the Unix epoch.

A maker may take its own offer. CEP-18 refuses a transfer to oneself, and the maker would be paying
itself, so the contract skips that leg: the maker only gets its tokens back, as with a cancel, and
needs no allowance of the wanted token. That is how the demo runs with one key, and how the web
app can be tried with one wallet.

The contract stores everything an app needs to show an offer without calling it:

- `offers`: each offer, with its `state` (`Open`, `Taken`, `Cancelled`) and `taken_by`;
- `by_maker`: for every account, the ids of the offers it made;
- `by_taker`: for every account, the ids of the offers made for it, and of the public offers it
  took;
- `open_public`: the ids of the public offers that are neither taken nor cancelled. An expired
  offer stays in it until its maker cancels it; an app filters expired ones out by their expiry.

## Entry points

| Entry point | Who | What it does |
|---|---|---|
| `make_offer(give_token, give_amount, want_token, want_amount, taker, expiry)` | anyone, as the maker | Makes an offer and pulls `give_amount` of `give_token` from the caller. |
| `take(offer_id)` | the named taker, or anyone for a public offer | Pays the maker `want_amount` from the caller and sends the caller `give_amount`. Before the expiry only. |
| `cancel(offer_id)` | the maker | Sends `give_amount` back to the maker. Any time until the offer is taken. |
| `offer(offer_id)` | view | The offer. |
| `offers_count()` | view | The number of offers. Ids run from `0` to `count - 1`. |
| `offers_of_maker(account)` | view | Ids of the offers the account made. |
| `offers_of_taker(account)` | view | Ids of the offers made for the account and of the public ones it took. |
| `open_public_offers()` | view | Ids of the public offers still open, expired ones included. |

The entry points that change state return nothing. The id of a new offer is the value
`offers_count` returned before the call, and the `OfferMade` event carries it.

### Events

| Event | Fields |
|---|---|
| `OfferMade` | `offer_id`, `maker`, `give_token`, `give_amount`, `want_token`, `want_amount`, `taker`, `expiry` |
| `OfferTaken` | `offer_id`, `maker`, `taker`, `give_amount`, `want_amount` |
| `OfferCancelled` | `offer_id`, `maker`, `give_amount` |

### Errors

| Code | Error | When |
|---|---|---|
| 1 | `ZeroAmount` | An amount of a new offer is zero. |
| 2 | `SameToken` | A new offer gives and wants the same token. |
| 3 | `ExpiryNotInFuture` | The expiry of a new offer is not after the current block time. |
| 4 | `OfferNotFound` | No offer has this id. |
| 5 | `NotMaker` | Someone other than the maker tried to cancel. |
| 6 | `NotTaker` | Someone other than the named taker tried to take. |
| 7 | `OfferExpired` | The offer was taken at or after its expiry. |
| 8 | `OfferClosed` | The offer has been taken or cancelled already. |

A failed token transfer reverts with the error of the token, for example `InsufficientAllowance`
(60002) when the taker has not approved enough.

## Things to know before using it

- **Not audited.** Review and test it yourself before putting real funds behind it.
- **Check the tokens, not only the symbols.** An offer names token contracts. Anyone can deploy a
  token called USDT; the taker should check the contract address of what they get.
- **The price is fixed.** Nothing in the contract compares it with a market. A maker who mistypes
  an amount can cancel, until someone takes the offer.
- **A public link is a public offer.** Anyone who reads the open list or guesses the number can
  take a public offer; name a taker to keep it for one account.
- **Standard CEP-18 tokens only.** The contract records the amount it asked for. A token that
  takes a fee on transfer leaves the contract short, and the last taker of that token cannot be
  paid.
- **The lists are stored values.** Each new offer appends to the maker's list, a named taker's
  list and, for a public offer, the open list, so each costs a little more gas as they grow.
  Taking or cancelling a public offer rewrites the open list.

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

To see what each call consumes, run the demo's test on CasperVM with the wasm files
`cargo odra build` wrote; it prints the gas report:

```bash
cargo odra build
ODRA_BACKEND=casper cargo test --lib the_demo_runs_and_reports_its_gas -- --nocapture
```

## Deploying to the testnet

```bash
cp .env.sample .env        # then set the path of your secret key in .env
cargo odra build
cargo run --bin otc_swap_cli -- deploy
```

`TestToken` is the one the vesting project deployed, listed in
`resources/casper-test-contracts.toml` before the first `deploy`, so it is reused, not deployed.
`TestDollar` and `OtcSwap` are deployed; their addresses are saved to that file, and a second
`deploy` reuses them.

To see it working, the demo offers 100 TEST for 250 TUSD to anyone and takes the offer with the
same account, then offers 50 TEST for 120 TUSD to one account only and cancels it. It takes TEST
from the faucet and approves the contract only if the caller lacks them.

```bash
cargo run --bin otc_swap_cli -- scenario demo
cargo run --bin otc_swap_cli -- contract OtcSwap offer --offer_id 0
```

`--taker` names the account of the second offer; a made-up account by default.

What it cost on the testnet in November 2026, in CSPR, each with its limit, what it consumed and
what was paid after the refund. The consumed gas matched CasperVM to the mote.

| Transaction | Limit | Consumed | Paid |
|---|---|---|---|
| Deploying `TestDollar` | 312 | 291.36 | 296.52 |
| Deploying `OtcSwap` | 310 | 289.64 | 294.73 |
| `approve` | 2.5 | 0.36 | 0.90 |
| `make_offer`, public | 3 | 2.05 | 2.28 |
| `take`, by the maker | 3.5 | 1.64 | 2.10 |
| `make_offer`, for one account | 3 | 2.15 | 2.36 |
| `cancel` | 2.5 | 1.28 | 1.59 |

On CasperVM a `take` by another account, with its two transfers, consumed 2.62 CSPR, and `faucet`
0.30. A transaction that fails is charged its whole limit, with no refund.

`cargo run --bin otc_swap_cli -- --help` lists every command.

### Deployed on the testnet

| Contract | Package hash |
|---|---|
| `OtcSwap` | [`hash-02f41a155d7caf0074ca6be0057c03a7d11e9010ebc055923dbb56bc230cfe8d`](https://testnet.cspr.live/contract-package/02f41a155d7caf0074ca6be0057c03a7d11e9010ebc055923dbb56bc230cfe8d) |
| `TestDollar` | [`hash-329d7b1f578c945dbd603ed7b7f2a3a0351024c82e4c5b2304fab94c58b30b13`](https://testnet.cspr.live/contract-package/329d7b1f578c945dbd603ed7b7f2a3a0351024c82e4c5b2304fab94c58b30b13) |
| `TestToken` | [`hash-0fafe6f2e4481d7c2e1b3d031a3634dc37189d2ff9c97d064b6a203d4b47ffe4`](https://testnet.cspr.live/contract-package/0fafe6f2e4481d7c2e1b3d031a3634dc37189d2ff9c97d064b6a203d4b47ffe4) |

## The web app

The app in `web/` does two things with the contracts, in two different ways:

- **It reads state straight from the node's storage** with
  [odra-storage-reader](https://github.com/odradev/odra/tree/release/2.11.0/odra-storage-reader).
  The reader takes the schema of a contract (`resources/casper_contract_schemas/`) and says where a
  value is stored; the app fetches it over JSON-RPC and the reader decodes it. No contract code
  runs and nothing is signed, so the page shows offers before a wallet is connected.
  `web/src/storage.ts` holds all of it.
- **It sends transactions** through the client `cargo odra generate-client` generates from the
  contracts, signed with [CSPR.click](https://cspr.click) (Casper Wallet or Ledger).

The maker fills in what they give, what they want, who may take it and until when, and gets a link
(`#offer=<id>`) to send. Whoever opens the link sees the offer from their side, "you give" and
"you get", and takes it with one button: the app approves the contract for the wanted tokens if
the allowance is short, then sends `take`. "Your offers" lists the offers the account made, with a
cancel button on the open ones, and those made for it. "Open offers" lists the public offers that
can still be taken. The app keeps 15 seconds away from an expiry, by the local clock, before it
offers a take: the contract compares the expiry with the time of the block, and a refused
transaction costs its whole limit.

The id of a new offer is read back as the last entry of the maker's list, not guessed from the
count before the call, which another maker's offer could change.

Tokens are read with the schema of `TestToken`; `TestDollar` stores its state the same way.
Another token is shown with its symbol and decimals only if it stores them the same way, as tokens
built on Odra's `Cep18` module do; otherwise the app shows raw units.

```bash
# 1. Build the two wasm packages the app depends on. Needs wasm-pack.
cargo odra build                               # writes the schemas the app reads with
env -u WASM_CLIENT_SK cargo odra generate-client   # the transaction client: otc_swap_client/pkg-web
cd web
npm run reader                                 # the storage reader: storage_reader/pkg-web

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
