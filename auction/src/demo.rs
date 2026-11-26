//! The demo scenario, as a sequence of calls a host runs: the command line tool runs it on a
//! network, and a test runs the same sequence on CasperVM before it touches one.

use crate::auction::AuctionHostRef;
use crate::nft::TestNftHostRef;
use odra::casper_types::{U256, U512};
use odra::host::HostRef;
use odra::prelude::*;

const CSPR: u64 = 1_000_000_000;

/// Gas limits of the deploys and the calls of the demo, in motes: what each used on CasperVM
/// (`the_demo_runs_and_reports_its_gas` in `src/auction.rs` prints it, on the wasm files
/// `cargo odra build` writes) and a margin. The network refunds three quarters of what a
/// transaction leaves unused, and lane limits make 2.5 CSPR the practical minimum of a call.
pub mod gas {
    use super::CSPR;
    /// Deploying `Auction`: 307.7 CSPR used, and 10% more.
    pub const DEPLOY_AUCTION: u64 = 339 * CSPR;
    /// Deploying `TestNft`: 348.3 CSPR used, and 10% more.
    pub const DEPLOY_NFT: u64 = 383 * CSPR;
    /// 0.80 CSPR used.
    pub const MINT: u64 = 2_500_000_000;
    /// 0.31 CSPR used.
    pub const APPROVE: u64 = 2_500_000_000;
    /// 2.14 CSPR used.
    pub const CREATE: u64 = 3 * CSPR;
    /// The first CSPR the contract ever receives: 6.7 CSPR used. A later first bid of an
    /// account used 4.2 CSPR, a later bid of the same account 1.2 CSPR.
    pub const BID: u64 = 8 * CSPR;
    /// 2.84 CSPR used.
    pub const WITHDRAW: u64 = 4 * CSPR;
    /// With a winner: 3.99 CSPR used; with no bids, 1.39 CSPR.
    pub const SETTLE: u64 = 5 * CSPR;
}

/// How long the demo waits after the end before settling, in milliseconds: block times lag the
/// clock, and a block must carry a time past the end.
pub const SETTLE_MARGIN: u64 = 60 * 1000;

/// What the demo auctions and for how much.
pub struct Options {
    /// The name of the test NFT it mints.
    pub name: String,
    /// The minimum bid, in motes; also the first bid.
    pub min_bid: U512,
    /// How long the auction runs before any bid moves its end, in milliseconds.
    pub duration: u64,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            name: String::from("Demo lot"),
            min_bid: U512::from(CSPR),
            duration: 3 * 60 * 1000,
        }
    }
}

/// What the demo did.
pub struct Outcome {
    pub token_id: U256,
    pub auction_id: u64,
    /// The end the auction was created with.
    pub first_end: u64,
    /// The end after the bids.
    pub end: u64,
    /// The first bid, outbid by the second and taken back.
    pub withdrawn: U512,
    /// The winning bid, which went to the seller.
    pub price: U512,
}

/// Mints a test NFT to the caller, auctions it, bids the minimum, outbids that bid, takes the
/// outbid stake back, waits for the end and settles. The caller is the seller and the bidder, so
/// the NFT and the CSPR come back to it; only the gas is spent.
pub fn run(
    nft: &mut TestNftHostRef,
    auction: &mut AuctionHostRef,
    options: Options,
) -> OdraResult<Outcome> {
    let env = nft.env().clone();

    let token_id = U256::from(nft.try_minted_count()?);
    env.set_gas(gas::MINT);
    nft.try_mint(options.name)?;
    env.set_gas(gas::APPROVE);
    nft.try_approve(auction.address(), token_id)?;

    let auction_id = auction.try_auctions_count()?;
    let first_end = env.block_time() + options.duration;
    env.set_gas(gas::CREATE);
    auction.try_create_auction(nft.address(), token_id, options.min_bid, first_end)?;

    env.set_gas(gas::BID);
    auction.with_tokens(options.min_bid).try_bid(auction_id)?;
    let second = auction.try_min_next_bid(auction_id)?;
    env.set_gas(gas::BID);
    auction.with_tokens(second).try_bid(auction_id)?;

    let withdrawn = auction.try_withdrawable(auction_id, env.caller())?;
    env.set_gas(gas::WITHDRAW);
    auction.try_withdraw(auction_id)?;

    let lot = auction.try_auction(auction_id)?;
    // On a network this sleeps until the end; on CasperVM it moves the block time.
    env.advance_block_time(lot.end.saturating_sub(env.block_time()) + SETTLE_MARGIN);
    env.set_gas(gas::SETTLE);
    auction.try_settle(auction_id)?;

    Ok(Outcome {
        token_id,
        auction_id,
        first_end,
        end: lot.end,
        withdrawn,
        price: lot.highest_bid,
    })
}
