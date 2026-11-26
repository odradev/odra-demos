# NFT auction

English auctions of CEP-95 NFTs for CSPR: the seller deposits an NFT, bidders outbid each other until
the end, an outbid bidder takes their CSPR back, and at the end the winner gets the NFT and the
seller the CSPR. Written in [Odra](https://odra.dev) for [Casper](https://casper.network).

The project has six parts:

- `src/auction.rs`: the `Auction` contract and its tests.
- `src/nft.rs`: `TestNft`, a CEP-95 collection anyone can mint into, for trying the contract on a test network.
- `src/demo.rs`: the demo scenario, which the command line tool sends to a network and a test runs on CasperVM.
- `bin/cli.rs`: a command line tool that deploys both contracts and runs the scenario.
- `web/`: a web app for minting a test NFT, auctioning it, bidding, taking outbid CSPR back and settling, with a Casper wallet.
- `storage_reader/`: builds [odra-storage-reader](https://github.com/odradev/odra/tree/release/2.11.0/odra-storage-reader), which the web app reads contract state with, to wasm.

## How it works

Anyone can auction an NFT of any CEP-95 contract. The contract has no owner, no fees and no upgrade
key. One deployed contract holds every auction.

```
highest bid
  ^                                   ___________  wins
  |                         ________|
  |               _________|
  |     _________|
  |    |  min bid
  +----+---------------------------+-----+-----> time
     start                        end   moved end
```

- **Creating.** The seller approves the contract for the NFT, then calls `create_auction` with the
  lowest first bid and the end. The contract pulls the NFT with `transfer_from` and checks that it
  owns it afterwards.
- **Bidding.** `bid` takes the CSPR attached to the call. The first bid must be at least the
  minimum bid; every later bid must beat the highest bid by 5% (`MIN_STEP_PERCENT`), rounded down,
  but at least by one mote. The account may be the one that already leads.
- **Late bids.** A bid less than 5 minutes (`EXTENSION`) before the end moves the end to 5 minutes
  after the bid, so nobody can win by bidding in the last second.
- **Outbid.** The bid that was beaten stays in the contract as the stake of its bidder, who takes it
  back with `withdraw` at any time, also after the end. Refunds are never pushed from `bid`: a
  bidder that cannot receive CSPR cannot block the auction.
- **Settling.** Once the end has passed, anyone may call `settle`: the NFT goes to the highest
  bidder and the highest bid to the seller. If nobody bid, the NFT goes back to the seller.

Times are block times: milliseconds since the Unix epoch. An auction may run for at most 30 days
(`MAX_DURATION`). Amounts are in motes (1 CSPR = 10^9 motes).

## Entry points

| Entry point | Who | What it does |
|---|---|---|
| `create_auction(nft, token_id, min_bid, end)` | the NFT's owner | Pulls the NFT and starts an auction. |
| `bid(auction_id)` | anyone, with CSPR attached | Places the attached CSPR as the highest bid. |
| `withdraw(auction_id)` | an outbid bidder | Sends the caller every outbid bid of theirs in the auction. |
| `settle(auction_id)` | anyone, after the end | NFT to the winner, CSPR to the seller; NFT back with no bids. |
| `auction(auction_id)` | view | The auction (`Lot`). |
| `min_next_bid(auction_id)` | view | The lowest bid the auction takes now. |
| `auctions_count()` | view | The number of auctions. Ids run from `0` to `count - 1`. |
| `auctions_of_seller(address)` | view | Ids of the auctions the address created. |
| `auctions_of_bidder(address)` | view | Ids of the auctions the address bid in. |
| `withdrawable(auction_id, address)` | view | The outbid CSPR the address can take back. |

The entry points that change state return nothing. The id of a new auction is the value
`auctions_count` returned before the call, and the `AuctionCreated` event carries it.

A `Lot` holds everything a page shows: `seller`, `nft`, `token_id`, `min_bid`, `start`, `end`,
`highest_bid`, `highest_bidder`, `bids` (the number of bids) and `settled`. The stored fields are
`auctions` (by id), `count`, `by_seller` and `by_bidder` (lists of ids per account) and
`pending_returns` (by auction id and bidder), so all of it can be read straight from storage.

### Events

| Event | Fields |
|---|---|
| `AuctionCreated` | `auction_id`, `seller`, `nft`, `token_id`, `min_bid`, `end` |
| `BidPlaced` | `auction_id`, `bidder`, `amount`, `end` (after the bid) |
| `Withdrawn` | `auction_id`, `bidder`, `amount` |
| `AuctionSettled` | `auction_id`, `seller`, `winner` (none if nobody bid), `price` |

### Errors

| Code | Error | When |
|---|---|---|
| 1 | `ZeroMinBid` | The minimum bid is zero. |
| 2 | `EndNotInFuture` | The end is not in the future. |
| 3 | `DurationTooLong` | The end is more than 30 days away. |
| 4 | `NftNotReceived` | The NFT contract did not hand the NFT over. |
| 5 | `AuctionNotFound` | No auction has this id. |
| 6 | `AuctionEnded` | The end has passed, or the auction was settled. |
| 7 | `BidTooLow` | Below the minimum bid, or not 5% above the highest bid. |
| 8 | `AuctionNotEnded` | Settling before the end. |
| 9 | `AlreadySettled` | Settling twice. |
| 10 | `NothingToWithdraw` | The caller has no outbid stake in the auction. |

A failed NFT transfer reverts with the error of the NFT contract, for example
`NotAnOwnerOrApproved` (40002) when the seller has not approved the auction for the NFT. `TestNft`
starts its own errors at 100 (`InvalidName`, a name that is empty or longer than 40 characters).

### The test NFT

`TestNft` is Odra's `Cep95` module with an open `mint(name)`: anyone mints the next token id to
themselves, with one metadata entry, `name`. `minted_count()` is the number of tokens and
`minted_by(address)` the ids an account minted, so a page can find the token it just minted.

## Things to know before using it

- **Not audited.** Review and test it yourself before putting real value behind it.
- **The NFT contract is the seller's choice.** The contract checks that it owns the NFT after
  pulling it, but a contract that only pretends to be CEP-95 can still show a fake NFT. Look at the
  NFT contract before bidding.
- **No reserve price and no cancelling.** Once an auction has started, the seller cannot stop it:
  with bids, the highest one wins, however low; with none, the NFT comes back only at the end.
- **Raising your own bid costs the old one until you take it back.** A leading bidder who bids
  again gets the earlier bid as a stake to withdraw, like any outbid bid.
- **The lists of an account's auctions are one stored value each.** An account with thousands of
  auctions pays more gas for each new one. Bids, withdrawals and settling do not read the seller's
  list.

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
cargo run --bin auction_cli -- deploy
```

Deploying both contracts cost 672.5 CSPR on the testnet in November 2026: 315.5 for `Auction`
(307.7 consumed) and 357.0 for `TestNft` (348.3 consumed). The gas limits in `src/demo.rs` are
what CasperVM measured and 10% more; the testnet consumed exactly as much. The addresses are saved
to `resources/casper-test-contracts.toml`, and a second `deploy` reuses them.

To see it working, run the demo. It mints a test NFT, auctions it for 3 minutes with a minimum bid
of 1 CSPR, bids 1 CSPR, outbids that with 1.05 CSPR, takes the outbid 1 CSPR back, waits for the
end (the late bids move it to 5 minutes after the second bid) and settles. One account does all of
it, so the NFT and the CSPR come back to it and only the gas is spent.

```bash
cargo run --bin auction_cli -- scenario demo
cargo run --bin auction_cli -- contract Auction auction --auction_id 0
```

The demo's seven transactions cost 19.6 CSPR in gas on the testnet: mint 1.2, approve 0.9, create
2.3, the two bids 4.9 and 2.9, take back 3.1 and settle 4.2. The first bid consumed 3.9 CSPR there,
less than the 6.6 CasperVM measured for the first CSPR a contract receives; the others consumed
what CasperVM measured.

`cargo run --bin auction_cli -- --help` lists every command.

### Deployed on the testnet

| Contract | Package hash |
|---|---|
| `Auction` | [`hash-1d5a7032efbdaabcfde3558168f8e2ae46c098376fef084f77df65d0419c8b0f`](https://testnet.cspr.live/contract-package/1d5a7032efbdaabcfde3558168f8e2ae46c098376fef084f77df65d0419c8b0f) |
| `TestNft` | [`hash-9d7da7ab0c344d6882115cf03ffc39c63058b19614cd4ec1f310152c988b7626`](https://testnet.cspr.live/contract-package/9d7da7ab0c344d6882115cf03ffc39c63058b19614cd4ec1f310152c988b7626) |

## The web app

The app in `web/` does two things with the contracts, in two different ways:

- **It reads state straight from the node's storage** with
  [odra-storage-reader](https://github.com/odradev/odra/tree/release/2.11.0/odra-storage-reader).
  The reader takes the schema of a contract (`resources/casper_contract_schemas/`) and says where a
  value is stored; the app fetches it over JSON-RPC and the reader decodes it. No contract code
  runs and nothing is signed, so the page lists auctions before a wallet is connected.
  `web/src/storage.ts` holds all of it.
- **It sends transactions** through the client `cargo odra generate-client` generates from the
  contracts, signed with [CSPR.click](https://cspr.click) (Casper Wallet or Ledger).

The lowest next bid, the countdown and whether an auction can be settled are computed in the
browser from the stored auction and the clock, with the same rules as the contract. The page reads
the open auctions again every 30 seconds, so other people's bids show up.

NFTs are read with the schema of `TestNft`. CEP-95 names the dictionaries an NFT contract keeps its
owners, approvals and metadata in, so the app also shows the owner and the `name` of an NFT of
another CEP-95 collection.

```bash
# 1. Build the two wasm packages the app depends on. Needs wasm-pack.
env -u WASM_CLIENT_SK cargo odra generate-client   # the transaction client: auction_client/pkg-web
cd web
npm run reader               # the storage reader: storage_reader/pkg-web

# 2. Give the app the contract addresses and start it.
npm install
npm run contracts            # writes src/contracts.json from ../resources/casper-test-contracts.toml
npm run dev
```

`env -u WASM_CLIENT_SK` keeps a key that is set in the shell out of the client's wasm: the app
needs no key, it only sends transactions the wallet signs.

`npm run build` writes a static site to `web/dist`.

`web/src/contracts.json` in the repository holds the testnet addresses above, so `npm run
contracts` is needed only after deploying your own.

Run `cargo odra generate-client` again whenever an entry point, an event or an error of a contract
changes. The storage reader needs no rebuild: it reads the schema files, which `cargo odra build`
rewrites.
