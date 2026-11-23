# Governor

Lets the holders of a token vote on a change and hands a change that wins to a timelock, which runs
it after a public delay. Here the change is a new fee. Written in [Odra](https://odra.dev) for
[Casper](https://casper.network).

The project has five parts:

- `src/governor.rs`: the `Governor` contract and its tests.
- `src/timelock.rs`, `src/fee_config.rs`, `src/token.rs`: copies of the `Timelock` and `FeeConfig`
  of [timelock](../timelock/) and the `TestToken` of [vesting](../vesting/). The governor works with
  the ones deployed on the testnet; the copies give it typed references to them, the tests deploy
  them, and the web app reads their storage with their schemas.
- `bin/cli.rs`: a command line tool that deploys the governor and runs the demo.
- `web/`: a web app for proposing a fee, voting, queueing and executing with a Casper wallet.
- `storage_reader/`: builds [odra-storage-reader](https://github.com/odradev/odra/tree/release/2.11.0/odra-storage-reader), which the web app reads contract state with, to wasm.

## How it works

The fee belongs to `FeeConfig`, whose owner is a timelock. The governor puts a vote in front of
the timelock:

```
  proposed           vote ends  queued                executed
     o-------------------o--------o---------------------●------> time
     |<-- voting period -->|      |<-- timelock delay -->|
      holders deposit tokens        public: anyone can see
      for or against                what will change and when
```

1. **Propose.** Anyone holding at least the proposal threshold proposes a fee, in basis points.
   Voting starts at once. Proposing locks no tokens.
2. **Vote.** A voter deposits tokens for or against the proposal: the governor takes them with
   `transfer_from`, so the voter approves it first. The deposit is the vote. A voter may add to it,
   on the side chosen first.
3. **Count.** When the voting period ends, the proposal has **passed** if at least `quorum` tokens
   are for it and more are for it than against; otherwise it has **failed**.
4. **Queue.** Anyone hands a passed proposal to the timelock: the governor calls the timelock's
   `schedule` with a call of `set_fee(fee_bps)` on `FeeConfig` and the timelock's minimum delay.
5. **Execute.** Once the delay has passed, anyone calls `execute` of the governor, which has the
   timelock run the operation: the timelock calls `set_fee` as the owner of `FeeConfig`.
6. **Withdraw.** Once voting has ended, whatever the result, each voter takes the deposit back.

### Why deposits

Voting power is the tokens a voter deposits on a proposal, held by the governor until voting on it
ends. The same tokens cannot vote twice on one proposal: they cannot leave the governor before the
vote is over, and after that no vote is accepted. This needs no snapshot of balances and no change
to the token, so it works with any CEP-18 token, the `TestToken` already deployed among them. A
deposit on one proposal is not available for another until it is withdrawn.

The price is that votes are locked: a voter cannot move the tokens until the vote ends. A
production governor counts balances at a past moment instead, which needs a token that records
them.

### The call the timelock makes

The governor builds the arguments of `set_fee` itself, as `RuntimeArgs` in their bytesrepr
serialization, the form the timelock's `schedule` takes: one argument, `fee_bps`, a `u32`. The fee
is checked when it is proposed (at most 10,000 basis points), so a passed proposal does not fail in
the fee contract.

The id of the timelock operation is the value of the timelock's `operations_count` read just before
the call to `schedule`; it is stored with the proposal.

Times and periods are in milliseconds; times are block times, milliseconds since the Unix epoch.

## Entry points

| Entry point | Who | What it does |
|---|---|---|
| `init(token, timelock, fee_config, voting_period, quorum, proposal_threshold)` | constructor | Sets the token votes are counted in, the timelock, the fee contract and the rules of voting. |
| `propose(fee_bps)` | a holder of `proposal_threshold` tokens | Proposes a fee; voting runs for `voting_period` from now. |
| `vote(proposal_id, support, amount)` | anyone, while voting is open | Deposits `amount` tokens for (`true`) or against the proposal. |
| `withdraw(proposal_id)` | a voter, once voting has ended | Gives the deposit back. |
| `queue(proposal_id)` | anyone | Schedules the fee change of a passed proposal in the timelock, with the timelock's minimum delay. |
| `execute(proposal_id)` | anyone, once the delay has passed | Has the timelock run the operation: the fee is set. |
| `proposal(proposal_id)` | view | The proposal: `proposer`, `fee_bps`, `created_at`, `vote_end`, `votes_for`, `votes_against`, `queued`, `operation_id`, `ready_at`, `executed`. |
| `state(proposal_id)` | view | `Voting`, `Defeated`, `Succeeded`, `Queued` or `Executed`, by the time of the last block. |
| `proposals_count()` | view | The number of proposals. Ids run from `0` to `count - 1`. |
| `ballot(proposal_id, voter)` | view | What the voter deposited: `support`, `amount`, `withdrawn`; nothing if no vote. |

The entry points that change state return nothing. The id of a new proposal is the value
`proposals_count` returned before the call, and the `ProposalCreated` event carries it.

The voting period, the quorum and the threshold have no views, to keep the contract, and its
deploy, smaller. They are stored as `voting_period`, `quorum` and `proposal_threshold`, which the
web app reads from storage.

### Events

| Event | Fields |
|---|---|
| `ProposalCreated` | `proposal_id`, `proposer`, `fee_bps`, `vote_end` |
| `VoteCast` | `proposal_id`, `voter`, `support`, `amount` |
| `ProposalQueued` | `proposal_id`, `operation_id`, `ready_at` |
| `ProposalExecuted` | `proposal_id`, `executor` |
| `VoteWithdrawn` | `proposal_id`, `voter`, `amount` |

### Errors

The governor's codes start at 200, so they do not overlap those of the timelock (1–12), the fee
contract (100, 101) and the token (60001 and up), whose errors can come out of the same call.

| Code | Error | When |
|---|---|---|
| 200 | `BelowProposalThreshold` | The proposer holds fewer tokens than the threshold. |
| 201 | `FeeTooHigh` | The fee is above 10,000 basis points. |
| 202 | `ProposalNotFound` | No proposal has this id. |
| 203 | `VotingClosed` | A vote came after voting ended. |
| 204 | `ZeroAmount` | A vote of zero tokens. |
| 205 | `OtherSide` | The voter voted the other way on this proposal already. |
| 206 | `VotingNotOver` | `withdraw` or `queue` before voting ended. |
| 207 | `NothingToWithdraw` | The caller has no deposit on the proposal, or took it back already. |
| 208 | `NotPassed` | `queue` of a proposal that failed. |
| 209 | `AlreadyQueued` | `queue` of a proposal queued before. |
| 210 | `NotQueued` | `execute` of a proposal that has not been queued. |
| 211 | `NotReady` | `execute` before the timelock's delay passed. |
| 212 | `AlreadyExecuted` | `execute` of a proposal executed before. |
| 213 | `InvalidVotingPeriod` | The constructor got a voting period of zero. |

A vote with more tokens than the voter holds or has approved reverts with the error of the token,
for example `InsufficientAllowance` (60002). `execute` of an operation someone ran in the timelock
directly reverts with the timelock's `AlreadyExecuted` (10).

## Things to know before using it

- **Not audited.** Review and test it yourself before putting anything of value behind it.
- **The demo timelock is open.** The timelock of [timelock](../timelock/) lets anyone propose and
  execute, so the fee can also be changed there without a vote, and a proposal the governor queued
  can be executed there directly. In a real deployment the governor is the timelock's only
  proposer; then nothing reaches the fee contract without a vote.
- **The proposal threshold is checked once,** when proposing, against the proposer's balance; the
  tokens stay free. It keeps out spam, not a determined holder.
- **One kind of proposal.** The governor proposes `set_fee` on one contract and nothing else.
  Arbitrary calls would need a proposal to carry the target, the entry point and the arguments, as
  the operations of the timelock do.
- **No cancel.** A queued proposal can be cancelled only in the timelock, by its cancellers (the
  deployer of the demo) or by its proposer, which is the governor and has no entry point for it.
- **The block time decides.** It can lag the clock of your computer by a few seconds, so a
  transaction sent right at the end of the vote or of the delay may revert.

## Running it

You need Rust, the `wasm32-unknown-unknown` target and
[cargo-odra](https://github.com/odradev/cargo-odra). `wasm-opt` and `wasm-strip` are needed to
build wasm files; see the [installation guide](https://odra.dev/docs/getting-started/installation).

```bash
cargo odra test            # tests on OdraVM
cargo odra test -b casper  # builds the wasm files and runs the tests on CasperVM
```

On CasperVM the contracts run as real wasm, so the tests show the governor calling the token and
the timelock, and the timelock calling the fee contract, on the Casper execution engine.
`a_fee_that_wins_the_vote_is_set_through_the_timelock` makes the transactions of the demo in its
order and prints the gas of each.

The project depends on the `release/2.11.0` branch of Odra, not on a published version: the web
client of the published 2.10 sends transactions the testnet rejects.

## Deploying to the testnet

```bash
cp .env.sample .env        # then set the path of your secret key in .env
cargo odra build
cargo run --bin governor_cli -- deploy
```

`deploy` deploys only the governor, with three minutes of voting, a quorum of 500 TEST and a
proposal threshold of 100 TEST, over the `Timelock`, `FeeConfig` and `TestToken` listed in
`resources/casper-test-contracts.toml`. The script never deploys those three; to use your own,
deploy them with [timelock](../timelock/) and [vesting](../vesting/) and put their package hashes
in that file first. The deploy uses 309.8 CSPR on CasperVM; with the limit in `bin/cli.rs`, 341
CSPR, it cost 317.6 CSPR on the testnet in November 2026. Unused gas is refunded only in part, so a
higher limit costs more.

To see it working, propose a fee of 3% and vote for it with 1,000 TEST, run the same scenario again
after the vote to queue it, and once more after the timelock's minute to execute it and take the
tokens back:

```bash
cargo run --bin governor_cli -- scenario demo --fee_bps 300   # faucet if needed, approve, propose, vote
cargo run --bin governor_cli -- scenario demo                 # 3 minutes later: queue
cargo run --bin governor_cli -- scenario demo                 # a minute later: execute, withdraw
cargo run --bin governor_cli -- contract FeeConfig fee_bps
```

Each run says how long to wait for the next. It acts 20 seconds after the moment by the local
clock, so that the block time has passed it too.

`cargo run --bin governor_cli -- --help` lists every command.

On CasperVM, `propose` uses 0.90 CSPR of gas, `vote` 1.58, `queue` 2.11, `execute` 1.81,
`withdraw` 1.12, `approve` 0.36 and `faucet` 0.30. The CLI sets limits of 2.5 to 3.5 CSPR, and the
web app 5 or 6 CSPR.
The demo on the testnet, six transactions (approve, propose, vote, queue, execute,
withdraw; the account held TEST already, so no faucet), cost 10.2 CSPR and set the fee from 2.5% to
3%.

### Deployed on the testnet

| Contract | Package hash |
|---|---|
| `Governor` | [`hash-cc5d0ab12e6b67ccda360f296a45915bd43860026482c6ca6b1e454650f0cab5`](https://testnet.cspr.live/contract-package/cc5d0ab12e6b67ccda360f296a45915bd43860026482c6ca6b1e454650f0cab5) |
| `Timelock` (of [timelock](../timelock/)) | [`hash-49a1c722fe262dd39ca052ac88fabf0e221c5a1726bace7a90b944a1e2c1feef`](https://testnet.cspr.live/contract-package/49a1c722fe262dd39ca052ac88fabf0e221c5a1726bace7a90b944a1e2c1feef) |
| `FeeConfig` (of [timelock](../timelock/)) | [`hash-065e07774e20253c58a274a4876a0b3f13573553696b37c348d1c4ddefb83525`](https://testnet.cspr.live/contract-package/065e07774e20253c58a274a4876a0b3f13573553696b37c348d1c4ddefb83525) |
| `TestToken` (of [vesting](../vesting/)) | [`hash-0fafe6f2e4481d7c2e1b3d031a3634dc37189d2ff9c97d064b6a203d4b47ffe4`](https://testnet.cspr.live/contract-package/0fafe6f2e4481d7c2e1b3d031a3634dc37189d2ff9c97d064b6a203d4b47ffe4) |

## The web app

The app in `web/` shows the fee, the timelock's delay and the rules of voting, gives TEST from the
faucet, lets you propose a fee, and lists the proposals, newest first: where each stands (voting,
passed, failed, queued, executable in so many seconds, executed), the tokens for and against on a
bar with the quorum marked, and the buttons of its next step: vote for or against with an amount,
queue, execute, take your tokens back.

It works with the contracts in two different ways:

- **It reads state straight from the node's storage** with
  [odra-storage-reader](https://github.com/odradev/odra/tree/release/2.11.0/odra-storage-reader);
  `web/src/storage.ts` holds all of it. No contract code runs and nothing is signed to read, so
  the page shows the proposals before a wallet is connected. Where a proposal stands, and the
  countdowns, are computed in the browser from the stored proposal and the clock, with the rule of
  the contract. For a queued proposal the app also reads the timelock's operation, which anyone may
  run, and the deployer cancel, in the timelock directly.
- **It sends transactions** through the client `cargo odra generate-client` generates from the
  contracts, signed with [CSPR.click](https://cspr.click) (Casper Wallet or Ledger). A vote takes
  two when the governor may not take the tokens yet: `approve` on the token, then `vote`.

Its look is the Odra web style shared by every project of this repository; see
[`../style/`](../style/).

```bash
# 1. Build the two wasm packages the app depends on. Needs wasm-pack.
cargo odra build             # writes the schemas the app reads storage with
cargo odra generate-client   # the transaction client: governor_client/pkg-web (see the note below)
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
