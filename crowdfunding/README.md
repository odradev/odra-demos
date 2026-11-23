# Crowdfunding with a goal

Raises CEP-18 tokens for an idea, all or nothing: backers pledge until a deadline; if the pledges
reach the goal, the creator claims them, and if not, every backer takes their pledge back. Written in
[Odra](https://odra.dev) for [Casper](https://casper.network).

The project has five parts:

- `src/crowdfunding.rs`: the `Crowdfunding` contract and its tests.
- `src/token.rs`: `TestToken`, a CEP-18 token with a public faucet, for trying the contract on a test network.
- `bin/cli.rs`: a command line tool that deploys the contract and runs scenarios.
- `web/`: a web app that lists every campaign and lets you start, back, claim and take back with a Casper wallet.
- `storage_reader/`: builds [odra-storage-reader](https://github.com/odradev/odra/tree/release/2.11.0/odra-storage-reader), which the web app reads contract state with, to wasm.

## How it works

Anyone can start a campaign for any CEP-18 token. The contract has no owner, no fees and no upgrade
key. One deployed contract holds every campaign, of every token.

A campaign has a title, a token, a goal and a deadline. Starting one moves no tokens.

```
pledged
  ^
  |                     *  reached the goal: the creator claims everything
goal - - - - - - - - - /|- - - - -
  |                  /  |
  |              /      |
  |          /     . . .*  fell short: every backer takes their pledge back
  |      /   . . .      |
  |  / . .              |
  +---------------------+------> time
start               deadline
```

- **Before the deadline**, anyone may pledge, as often as they like, also past the goal. A pledge
  cannot be taken back while the campaign runs, so the total only grows and a reached goal stays
  reached. The creator may back their own campaign.
- **From the deadline on**, nobody can pledge. The campaign has one of two outcomes, by the total:
  - The pledges reached the goal (`pledged >= goal`): the creator claims all of them, the part past
    the goal included, in one transaction. Nobody else can, and the creator cannot claim early.
  - They fell short: each backer takes back what they pledged, in a transaction of their own. The
    creator gets nothing.

The deadline is the first moment the campaign is closed: a pledge in a block timed at the deadline
is rejected, a claim in that block is accepted. Times are block times: milliseconds since the Unix
epoch.

Nothing expires: a funded campaign can be claimed and a failed one taken back at any time after the
deadline.

A campaign moves through these states, which the web app shows as chips:

| State | When |
|---|---|
| open | before the deadline |
| funded | after the deadline, the goal reached, not claimed yet |
| failed | after the deadline, the goal missed |
| claimed | the creator has taken the pledges |

## Entry points

| Entry point | Who | What it does |
|---|---|---|
| `create_campaign(token, title, goal, deadline)` | anyone | Starts a campaign. The title has 1 to 64 characters. |
| `pledge(campaign_id, amount)` | anyone | Pulls `amount` of the campaign's token from the caller. Before the deadline only. |
| `claim(campaign_id)` | the creator | Sends every pledge to the creator. After the deadline, with the goal reached. |
| `refund(campaign_id)` | a backer | Gives the caller their pledge back. After the deadline, with the goal missed. |
| `campaign(campaign_id)` | view | The campaign. |
| `campaigns_count()` | view | The number of campaigns. Ids run from `0` to `count - 1`. |
| `campaigns_of_creator(address)` | view | Ids of the campaigns the address started. |
| `campaigns_of_backer(address)` | view | Ids of the campaigns the address pledged to, in the order of its first pledge. |
| `pledge_of(campaign_id, address)` | view | What the address has pledged to the campaign and not taken back. |

The entry points that change state return nothing. The id of a new campaign is the value
`campaigns_count` returned before the call, and the `CampaignCreated` event carries it.

A campaign stores `pledged`, the sum of every pledge. Taking a pledge back does not lower it, so a
failed campaign still shows how far it got; `pledge_of` drops to zero for the backer who took theirs
back.

### Storage

The web app reads storage, not views (see below), so this is what it reads:

| Field | Type | Holds |
|---|---|---|
| `campaigns` | `Mapping<u64, Campaign>` | Campaigns by id. |
| `count` | `Var<u64>` | The number of campaigns. |
| `by_creator` | `Mapping<Address, Vec<u64>>` | Ids of the campaigns an account started. |
| `by_backer` | `Mapping<Address, Vec<u64>>` | Ids of the campaigns an account pledged to. |
| `pledges` | `Mapping<(u64, Address), U256>` | What a backer has pledged to a campaign and not taken back. Read with the key `<id>:<account-hash-…>`. |

A pledge that was never made reads as `null`; one taken back reads as `0`.

### Events

| Event | Fields |
|---|---|
| `CampaignCreated` | `campaign_id`, `creator`, `token`, `title`, `goal`, `deadline` |
| `Pledged` | `campaign_id`, `backer`, `amount`, `pledged` (the campaign's total after it) |
| `Claimed` | `campaign_id`, `creator`, `amount` |
| `Refunded` | `campaign_id`, `backer`, `amount` |

### Errors

| Code | Error | When |
|---|---|---|
| 1 | `ZeroGoal` | The goal is zero. |
| 2 | `DeadlineNotInFuture` | The deadline is not after the current block time. |
| 3 | `InvalidTitle` | The title is empty, only spaces, or longer than 64 characters. |
| 4 | `CampaignNotFound` | No campaign has this id. |
| 5 | `ZeroAmount` | The amount to pledge is zero. |
| 6 | `CampaignEnded` | A pledge at or after the deadline. |
| 7 | `CampaignNotEnded` | A claim or a refund before the deadline. |
| 8 | `NotCreator` | Someone other than the creator tried to claim. |
| 9 | `GoalNotReached` | A claim of a campaign that missed its goal. |
| 10 | `AlreadyClaimed` | The pledges were claimed before. |
| 11 | `GoalReached` | A refund from a campaign that reached its goal. |
| 12 | `NothingToRefund` | The caller has no pledge left in the campaign. |

A failed token transfer reverts with the error of the token, for example `InsufficientAllowance`
(60002) when the backer has not approved enough.

## Things to know before using it

- **Not audited.** Review and test it yourself before putting real funds behind it.
- **Standard CEP-18 tokens only.** The contract records the amount it asked for. A token that takes a
  fee on transfer or changes balances on its own leaves the contract short, and the last backers or
  the creator cannot be paid.
- **The title is the creator's text.** Anyone can write anything in it; show it as text, never as
  markup.
- **A pledge cannot be undone before the deadline.** Backers who change their mind wait for the
  outcome.
- **The list of an account's campaigns is one stored value.** Backing or starting a campaign for an
  account that has thousands of them costs more gas each time. Claiming and taking back do not read
  the lists.

## Running it

You need Rust, the `wasm32-unknown-unknown` target and
[cargo-odra](https://github.com/odradev/cargo-odra). `wasm-opt` and `wasm-strip` are needed to
build wasm files; see the [installation guide](https://odra.dev/docs/getting-started/installation).

```bash
cargo odra test            # tests on OdraVM
cargo odra test -b casper  # builds the wasm files and runs the tests on CasperVM
```

`demo_scenario` replays what the CLI's `demo` scenario sends; on CasperVM,
`cargo odra test -b casper -s demo_scenario -- --nocapture` prints the gas of every transaction
(`-s` keeps the wasm files `cargo odra build` wrote, the ones that are deployed).

The project depends on the `release/2.11.0` branch of Odra, not on a published version: the web
client of the published 2.10 sends transactions the testnet rejects.

## Deploying to the testnet

```bash
cp .env.sample .env        # then set the path of your secret key in .env
cargo odra build
cargo run --bin crowdfunding_cli -- deploy
```

`deploy` deploys `Crowdfunding` only. It reuses the `TestToken` of the vesting project, which
`resources/casper-test-contracts.toml` lists, and stops if the file does not. Deploying cost 303.7
CSPR on the testnet in November 2026: 296.3 CSPR of gas, the same as on CasperVM, under a limit of
326 CSPR, a tenth above it; unused gas is refunded only in part, so a higher limit costs more. The
address is saved to `resources/casper-test-contracts.toml`, and a second `deploy` reuses it.

To see it working, start two campaigns and back both, then run the same scenario again once the
first one has ended to claim it:

```bash
cargo run --bin crowdfunding_cli -- scenario demo   # --minutes 5 for a later deadline
cargo run --bin crowdfunding_cli -- scenario demo   # a minute after the deadline: claims
cargo run --bin crowdfunding_cli -- contract Crowdfunding campaign --campaign_id 0
```

The first run takes test tokens from the faucet if the caller has fewer than 140 TEST, allows the
contract to take 140, starts "A coffee machine for the hackerspace" with a goal of 100 TEST ending
in three minutes and backs it with 100 TEST, then starts "A community garden by the river" with a
goal of 1,000 TEST ending in 14 days and backs it with 40 TEST. The second run looks for a campaign
of the caller that reached its goal and was not claimed. Until a minute after its deadline it says
how long to wait and sends nothing; after that it claims it. A third run starts over.

On CasperVM, `faucet` uses 0.30 CSPR of gas, `approve` 0.36, `create_campaign` 0.90, `pledge` 1.82
and `claim` 1.26 CSPR; the testnet charged the same within 0.3%. The CLI sets limits of 2.5 CSPR,
the smallest the testnet takes for a contract call, and 3 CSPR for `pledge`. The demo on the
testnet, a first run of five transactions (the caller had tokens, so no faucet) and a claim, cost
9.3 CSPR.

`cargo run --bin crowdfunding_cli -- --help` lists every command.

### Deployed on the testnet

| Contract | Package hash |
|---|---|
| `Crowdfunding` | [`hash-c300ec089a732b92504b38b646450f5efa05341cfe3ddf6308a391e5d3571f34`](https://testnet.cspr.live/contract-package/c300ec089a732b92504b38b646450f5efa05341cfe3ddf6308a391e5d3571f34) |
| `TestToken` (of the vesting project) | [`hash-0fafe6f2e4481d7c2e1b3d031a3634dc37189d2ff9c97d064b6a203d4b47ffe4`](https://testnet.cspr.live/contract-package/0fafe6f2e4481d7c2e1b3d031a3634dc37189d2ff9c97d064b6a203d4b47ffe4) |

## The web app

The app in `web/` does two things with the contracts, in two different ways:

- **It reads state straight from the node's storage** with
  [odra-storage-reader](https://github.com/odradev/odra/tree/release/2.11.0/odra-storage-reader).
  The reader takes the schema of a contract (`resources/casper_contract_schemas/`) and says where a
  value is stored; the app fetches it over JSON-RPC and the reader decodes it. No contract code
  runs and nothing is signed, so the page lists every campaign before a wallet is connected.
  `web/src/storage.ts` holds all of it.
- **It sends transactions** through the client `cargo odra generate-client` generates from the
  contracts, signed with [CSPR.click](https://cspr.click) (Casper Wallet or Ledger).

The list of all campaigns runs from `count - 1` down to `0`, ten at a time. "Started by me" and
"Backed by me" read `by_creator` and `by_backer` of the connected account, and every card reads the
account's pledge from `pledges`. The state of a campaign (open, funded, failed, claimed) is worked
out in the browser from the stored campaign and the clock, by the same rules as the contract.
Claiming and taking back are enabled 30 seconds after the deadline, as block time trails the clock.

Tokens are read with the schema of `TestToken`. Another token is shown with its symbol and decimals
only if it stores them the same way, as tokens built on Odra's `Cep18` module do; otherwise the app
shows raw units.

```bash
# 1. Build the two wasm packages the app depends on. Needs wasm-pack.
cargo odra generate-client   # the transaction client: crowdfunding_client/pkg-web (see the note below)
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
