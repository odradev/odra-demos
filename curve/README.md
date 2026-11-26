# Bonding curve token

A CEP-18 token that sells itself: pay CSPR and the contract mints tokens to you at a price that rises
with every token in existence; sell them back and it burns them and pays you out of the CSPR buyers
paid in. Written in [Odra](https://odra.dev) for [Casper](https://casper.network).

The project has five parts:

- `src/curve.rs`: the `Curve` contract and its tests.
- `src/math.rs`: the arithmetic of the curve, in integers, and its tests.
- `src/demo.rs` and `bin/cli.rs`: a command line tool that deploys the contract and runs a demo scenario.
- `web/`: a web app that draws the curve, shows the reserve and your balance, and buys and sells with a Casper wallet.
- `storage_reader/`: builds [odra-storage-reader](https://github.com/odradev/odra/tree/release/2.11.0/odra-storage-reader), which the web app reads contract state with, to wasm.

## How it works

The contract is the token: it composes Odra's `Cep18` module, so CURVE moves like any CEP-18 token,
and it is the only issuer of it. Nothing is minted up front. It has no owner, no fee and no upgrade
key; the only way to take CSPR out of it is to sell tokens back.

The price of one whole token is a straight line in the supply:

```
price(supply) = base_price + slope * supply
```

```
price
  ^                              /
  |                          /
  |                  * now /
  |              /|░░░░░/          a purchase pays the area under the line
  |          /░░░░|░░░░░|          from the supply before it to the supply after it;
  |      /░░░░░░░░|░░░░░|          a sale is paid the area it takes away.
  |  /░░ reserve ░|░░░░░|
  +---------------+-----+-------> supply
                 now   after a purchase
```

- **Buying** (`buy`, payable): the contract finds the most tokens the attached CSPR buys, mints them to
  the caller and sends back what is left of the CSPR. A purchase pays the area under the line between
  the supply before and after it, so a large purchase pays the rising price for every part of itself
  and buying in parts costs the same as at once, give or take a mote of rounding per part.
- **Selling** (`sell`): the contract burns the tokens and pays the area under the line between the
  supply after and before the sale.
- **The reserve** is the CSPR the contract holds: the sum of what purchases paid, less what sales paid
  out. It is always at least the area under the line up to the supply, so every holder can sell.

`base_price` is in motes per whole token, `slope` in motes per whole token for each whole token of
supply. In the smallest units of the token, with `unit = 10^decimals`:

```
price(s)    = base_price + slope * s / unit                                   (rounded down)
area(s, a)  = (2 * base_price * unit * a + slope * (2 * s * a + a^2)) / (2 * unit^2)
cost(s, a)  = area(s, a), rounded up                       what buying a tokens at supply s costs
proceeds(s, a) = area(s - a, a), rounded down              what selling a tokens at supply s pays
tokens_for(s, c) = the largest a with cost(s, a) <= c      what c motes buy
```

`tokens_for` solves the quadratic with an integer square root and then steps to the exact answer.
The arithmetic runs in 512-bit integers; the token may have at most 18 decimals, which leaves room
for a billion tokens and a price of a million CSPR.

**Rounding is in the contract's favour.** Buying an amount and selling it back pays out the same area
rounded down that the purchase paid rounded up: never more than was paid in, and at most a mote less.
The tests check it for random curves and amounts, and that every holder can sell out in any order,
leaving a few motes of rounding in the reserve.

Each call carries a minimum: `buy(min_tokens)` reverts if the CSPR buys fewer tokens, and
`sell(amount, min_cspr)` reverts if the tokens pay less. Someone else's trade between the quote and the
transaction moves the price; the minimum keeps that from filling at a price the caller did not accept.

## Entry points

| Entry point | Who | What it does |
|---|---|---|
| `init(name, symbol, decimals, base_price, slope)` | deployer | Creates the token with no supply. |
| `buy(min_tokens)` | anyone, payable | Mints what the attached CSPR buys to the caller and sends back the rest of the CSPR. |
| `sell(amount, min_cspr)` | a holder | Burns `amount` of the caller's tokens and pays the caller for them. |
| `price()` | view | The price of a whole token now, in motes. |
| `tokens_for(cspr)` | view | What `cspr` motes would buy now. |
| `cost_of(amount)` | view | What buying `amount` would cost now. |
| `proceeds_of(amount)` | view | What selling `amount` would pay now. |
| `reserve()`, `base_price()`, `slope()` | view | The stored values. |
| `name`, `symbol`, `decimals`, `total_supply`, `balance_of`, `allowance`, `approve`, `increase_allowance`, `decrease_allowance`, `transfer`, `transfer_from` | CEP-18 | As in any CEP-18 token. |

The entry points that change state return nothing; the `Bought` and `Sold` events carry the results.

### Storage

The web app reads storage, not views (see below), so this is what it reads:

| Field | Type | Holds |
|---|---|---|
| `base_price` | `Var<U512>` | The price of a whole token at zero supply, in motes. |
| `slope` | `Var<U512>` | How much the price of a whole token rises with each whole token of supply, in motes. |
| `reserve` | `Var<U512>` | The CSPR held to buy tokens back, in motes. |
| `token.total_supply` | `U256` | The supply, in the smallest unit. |
| `token.balances` | `Mapping<Address, U256>` | Balances. Read with the key `account-hash-…`. |
| `token.decimals`, `token.symbol`, `token.name` | | The token's metadata. |

### Events

| Event | Fields |
|---|---|
| `Bought` | `buyer`, `tokens`, `cost` (motes kept; the rest went back), `supply` and `reserve` after it |
| `Sold` | `seller`, `tokens`, `proceeds`, `supply` and `reserve` after it |

The CEP-18 module adds its own `Mint` and `Burn` events.

### Errors

| Code | Error | When |
|---|---|---|
| 1 | `FreeCurve` | `init` with a base price and a slope of zero. |
| 2 | `TooManyDecimals` | `init` with more than 18 decimals. |
| 3 | `ZeroAmount` | A purchase with no CSPR attached, or a sale of nothing. |
| 4 | `NothingBought` | The attached CSPR does not buy one smallest unit of the token. |
| 5 | `TooFewTokens` | The CSPR buys fewer than `min_tokens`. |
| 6 | `TooLittleCspr` | The sale pays less than `min_cspr`. |
| 7 | `Overflow` | A value does not fit in the arithmetic; also `proceeds_of` more than the supply. |
| 60001 | `InsufficientBalance` | A sale of more tokens than the caller holds (the CEP-18 module's error). |

## Things to know before using it

- **Not audited.** Review and test it yourself before putting real funds behind it.
- **The price is the line, nothing else.** There is no market behind it: the first buyers pay least, and
  whoever sells first gets the higher price. That is the point of a bonding curve, and its risk.
- **A trade can move the price before yours lands.** Set the minimum; the web app sets it 1% below the
  quote.
- **The curve cannot be changed.** The base price and the slope are fixed at deploy.

## Running it

You need Rust, the `wasm32-unknown-unknown` target and
[cargo-odra](https://github.com/odradev/cargo-odra). `wasm-opt` and `wasm-strip` are needed to
build wasm files; see the [installation guide](https://odra.dev/docs/getting-started/installation).

```bash
cargo odra test            # tests on OdraVM
cargo odra test -b casper  # builds the wasm file and runs the tests on CasperVM

# The gas of the deploy and of every call of the demo, on the wasm file `cargo odra build` wrote:
cargo odra build
cargo odra test -b casper -s the_demo -- --nocapture
```

The project depends on the `release/2.11.0` branch of Odra, not on a published version: the web
client of the published 2.10 sends transactions the testnet rejects.

## Deploying to the testnet

```bash
cp .env.sample .env        # then set the path of your secret key in .env
cargo odra build
cargo run --bin curve_cli -- deploy
```

`deploy` creates CURVE, a token of 9 decimals that costs 0.1 CSPR at the start and 0.001 CSPR more
for each token in existence (`src/demo.rs`): the hundredth token costs 0.2 CSPR, the thousandth 1.1.
It cost 392.3 CSPR on the testnet in November 2026: 382.7 CSPR of gas, the same as on CasperVM,
under a limit of 421 CSPR, a tenth above it. The wasm is larger than the other demos' (359 KB): the
512-bit arithmetic of the curve. The address is saved to `resources/casper-test-contracts.toml`, and a
second `deploy` reuses it.

To see it working, buy CURVE for 10 CSPR and sell half of it back:

```bash
cargo run --bin curve_cli -- scenario demo   # --cspr <n> to spend another amount
cargo run --bin curve_cli -- contract Curve price
```

On the testnet the first run bought 73.2050 CURVE for 10 CSPR and sold 36.6025 back for 5.6698 CSPR,
leaving 4.3301 CSPR in the reserve and the price at 0.1366 CSPR.

| Transaction | Gas used, testnet | Gas used, CasperVM | Limit |
|---|---|---|---|
| Deploying `Curve` | 382.7 CSPR | 382.7 CSPR | 421 CSPR |
| `buy`, the account's first | 3.92 CSPR | 6.60 CSPR | 8 CSPR |
| `sell` | 3.18 CSPR | 3.18 CSPR | 4 CSPR |

A purchase is a payable call: it runs through Odra's proxy session code, which carries the CSPR to
the contract, and CasperVM charges that much more than the testnet does. A purchase that sends change
back makes one more transfer, about 2.5 CSPR on CasperVM; with this curve that happens only once a
token costs more than 1 CSPR, as below that one mote buys more than a smallest unit and the CSPR is
spent exactly. The demo's two transactions cost 8.3 CSPR in fees on the testnet.

`cargo run --bin curve_cli -- --help` lists every command.

### Deployed on the testnet

| Contract | Package hash |
|---|---|
| `Curve` | [`hash-6ad107591383e6ac2906df5d989b0b5444dc0b340009216a1d4446533640490b`](https://testnet.cspr.live/contract-package/6ad107591383e6ac2906df5d989b0b5444dc0b340009216a1d4446533640490b) |

## The web app

The app in `web/` does two things with the contract, in two different ways:

- **It reads state straight from the node's storage** with
  [odra-storage-reader](https://github.com/odradev/odra/tree/release/2.11.0/odra-storage-reader):
  the curve's parameters, the supply, the reserve and the connected account's balance. Nothing is
  executed and nothing is signed, so the curve shows before a wallet is connected.
  `web/src/storage.ts` holds all of it.
- **It sends transactions** through the client `cargo odra generate-client` generates from the
  contract, signed with [CSPR.click](https://cspr.click) (Casper Wallet or Ledger).

Quotes are worked out in the browser by `web/src/curve.ts`, the arithmetic of `src/math.rs` in
BigInt; it gives the same numbers to the mote. The chart draws the line, the reserve as the area
under it up to the supply, the point where the supply is now, and the stretch a purchase or a sale in
the form would add or take away. The payment limits are 5 CSPR for a purchase (8 when it may send
change back) and 4 for a sale.

```bash
# 1. Build the two wasm packages the app depends on. Needs wasm-pack.
cargo odra build                                 # writes the schema the app reads with
env -u WASM_CLIENT_SK cargo odra generate-client  # the transaction client: curve_client/pkg-web
cd web
npm run reader               # the storage reader: storage_reader/pkg-web

# 2. Give the app the contract address and start it.
npm install
npm run contracts            # writes src/contracts.json from ../resources/casper-test-contracts.toml
npm run dev
```

`npm run build` writes a static site to `web/dist`. `web/src/contracts.json` in the repository holds
the testnet address above, so `npm run contracts` is needed only after deploying your own.
