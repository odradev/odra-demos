//! English auctions of CEP-95 NFTs for CSPR: the seller deposits an NFT, bidders outbid each other
//! until the end, an outbid bidder takes their CSPR back, and settling sends the NFT to the winner
//! and the CSPR to the seller.

use odra::casper_types::{U256, U512};
use odra::prelude::*;
use odra::ContractRef;
use odra_modules::cep95::{CEP95Interface, Cep95ContractRef};

/// A bid must beat the highest bid by at least this many percent.
pub const MIN_STEP_PERCENT: u64 = 5;
/// A bid closer than this to the end moves the end to this long after the bid, in milliseconds,
/// so nobody can win by bidding in the last second.
pub const EXTENSION: u64 = 5 * 60 * 1000;
/// The longest an auction may run, in milliseconds: 30 days.
pub const MAX_DURATION: u64 = 30 * 24 * 60 * 60 * 1000;

/// An auction of one NFT. All times are block times: milliseconds since the Unix epoch.
#[odra::odra_type]
pub struct Lot {
    /// The account that put the NFT up for auction and receives the winning bid.
    pub seller: Address,
    /// The CEP-95 contract of the NFT.
    pub nft: Address,
    /// The id of the NFT in its contract.
    pub token_id: U256,
    /// The lowest first bid, in motes.
    pub min_bid: U512,
    /// The moment the auction was created.
    pub start: u64,
    /// Bids are accepted until this moment, not at it. A late bid moves it later.
    pub end: u64,
    /// The highest bid so far, in motes; zero before the first bid.
    pub highest_bid: U512,
    /// The account that placed the highest bid; none before the first bid.
    pub highest_bidder: Option<Address>,
    /// The number of bids placed.
    pub bids: u32,
    /// Whether the auction was settled: the NFT and the CSPR have gone where they belong.
    pub settled: bool,
}

/// Errors of the auction contract.
#[odra::odra_error]
pub enum Error {
    /// The minimum bid is zero.
    ZeroMinBid = 1,
    /// The end is not in the future.
    EndNotInFuture = 2,
    /// The end is more than `MAX_DURATION` away.
    DurationTooLong = 3,
    /// The NFT contract did not hand the NFT over to the auction.
    NftNotReceived = 4,
    /// No auction has this id.
    AuctionNotFound = 5,
    /// The auction has ended: it takes no more bids.
    AuctionEnded = 6,
    /// The bid is lower than the minimum bid, or does not beat the highest bid by enough.
    BidTooLow = 7,
    /// The auction has not ended yet.
    AuctionNotEnded = 8,
    /// The auction was settled already.
    AlreadySettled = 9,
    /// The caller has no outbid stake to take back in this auction.
    NothingToWithdraw = 10,
}

/// An NFT was put up for auction.
#[odra::event]
pub struct AuctionCreated {
    pub auction_id: u64,
    pub seller: Address,
    pub nft: Address,
    pub token_id: U256,
    pub min_bid: U512,
    pub end: u64,
}

/// A bid became the highest bid of an auction.
#[odra::event]
pub struct BidPlaced {
    pub auction_id: u64,
    pub bidder: Address,
    pub amount: U512,
    /// The end of the auction after the bid; later than before if the bid came late.
    pub end: u64,
}

/// An outbid bidder took their stake back.
#[odra::event]
pub struct Withdrawn {
    pub auction_id: u64,
    pub bidder: Address,
    pub amount: U512,
}

/// An auction was settled.
#[odra::event]
pub struct AuctionSettled {
    pub auction_id: u64,
    pub seller: Address,
    /// The account that received the NFT; none if nobody bid and the NFT went back to the seller.
    pub winner: Option<Address>,
    /// What the seller received, in motes; zero if nobody bid.
    pub price: U512,
}

/// English auctions of CEP-95 NFTs for CSPR.
///
/// Anyone can auction an NFT of any CEP-95 contract; the contract has no owner and no fees. The
/// contract holds the NFT and every bid until they are settled or taken back.
#[odra::module(
    events = [AuctionCreated, BidPlaced, Withdrawn, AuctionSettled],
    errors = Error
)]
pub struct Auction {
    /// Auctions by id.
    auctions: Mapping<u64, Lot>,
    /// The number of auctions created; also the id of the next one.
    count: Var<u64>,
    /// Ids of the auctions an account created.
    by_seller: Mapping<Address, Vec<u64>>,
    /// Ids of the auctions an account bid in, in the order of their first bid.
    by_bidder: Mapping<Address, Vec<u64>>,
    /// CSPR of outbid bids that a bidder has not taken back yet, by (auction id, bidder).
    pending_returns: Mapping<(u64, Address), U512>,
}

#[odra::module]
impl Auction {
    /// Puts the NFT `token_id` of the CEP-95 contract `nft` up for auction, with bids from
    /// `min_bid` motes until `end`, in milliseconds since the Unix epoch. The NFT is pulled from
    /// the caller, who must have approved this contract for it. The caller is the seller. The id of
    /// the auction is the value `auctions_count` returned before the call; the `AuctionCreated`
    /// event carries it.
    pub fn create_auction(&mut self, nft: Address, token_id: U256, min_bid: U512, end: u64) {
        if min_bid.is_zero() {
            self.env().revert(Error::ZeroMinBid);
        }
        let now = self.env().get_block_time();
        if end <= now {
            self.env().revert(Error::EndNotInFuture);
        }
        if end - now > MAX_DURATION {
            self.env().revert(Error::DurationTooLong);
        }

        let seller = self.env().caller();
        let auction_id = self.count.get_or_default();
        self.count.set(auction_id + 1);
        self.auctions.set(
            &auction_id,
            Lot {
                seller,
                nft,
                token_id,
                min_bid,
                start: now,
                end,
                highest_bid: U512::zero(),
                highest_bidder: None,
                bids: 0,
                settled: false,
            },
        );
        push_id(&mut self.by_seller, &seller, auction_id);

        let this = self.env().self_address();
        let mut token = Cep95ContractRef::new(self.env(), nft);
        token.transfer_from(seller, this, token_id);
        if token.owner_of(token_id) != Some(this) {
            self.env().revert(Error::NftNotReceived);
        }

        self.env().emit_event(AuctionCreated {
            auction_id,
            seller,
            nft,
            token_id,
            min_bid,
            end,
        });
    }

    /// Bids the CSPR attached to the call. The bid must be at least the minimum bid and beat the
    /// highest bid by `MIN_STEP_PERCENT` (`min_next_bid` says how much that is). The bid it beats
    /// becomes the stake of its bidder, who takes it back with `withdraw`. A bid less than
    /// `EXTENSION` before the end moves the end to `EXTENSION` after the bid.
    #[odra(payable)]
    pub fn bid(&mut self, auction_id: u64) {
        let mut lot = self.get_lot(auction_id);
        let now = self.env().get_block_time();
        if lot.settled || now >= lot.end {
            self.env().revert(Error::AuctionEnded);
        }
        let amount = self.env().attached_value();
        if amount < min_next_bid(&lot) {
            self.env().revert(Error::BidTooLow);
        }

        let bidder = self.env().caller();
        if let Some(previous) = lot.highest_bidder {
            let key = (auction_id, previous);
            let pending = self.pending_returns.get_or_default(&key);
            self.pending_returns.set(&key, pending + lot.highest_bid);
        }
        let mut ids = self.by_bidder.get_or_default(&bidder);
        if !ids.contains(&auction_id) {
            ids.push(auction_id);
            self.by_bidder.set(&bidder, ids);
        }

        lot.highest_bid = amount;
        lot.highest_bidder = Some(bidder);
        lot.bids += 1;
        if lot.end - now < EXTENSION {
            lot.end = now + EXTENSION;
        }
        let end = lot.end;
        self.auctions.set(&auction_id, lot);

        self.env().emit_event(BidPlaced {
            auction_id,
            bidder,
            amount,
            end,
        });
    }

    /// Sends the caller every outbid bid of theirs in the auction. Allowed at any time.
    pub fn withdraw(&mut self, auction_id: u64) {
        self.get_lot(auction_id);
        let bidder = self.env().caller();
        let key = (auction_id, bidder);
        let amount = self.pending_returns.get_or_default(&key);
        if amount.is_zero() {
            self.env().revert(Error::NothingToWithdraw);
        }

        self.pending_returns.set(&key, U512::zero());
        self.env().transfer_tokens(&bidder, &amount);

        self.env().emit_event(Withdrawn {
            auction_id,
            bidder,
            amount,
        });
    }

    /// Ends the auction once its end has passed: the NFT goes to the highest bidder and the
    /// highest bid to the seller, or the NFT back to the seller if nobody bid. Anyone may call it.
    pub fn settle(&mut self, auction_id: u64) {
        let mut lot = self.get_lot(auction_id);
        if lot.settled {
            self.env().revert(Error::AlreadySettled);
        }
        if self.env().get_block_time() < lot.end {
            self.env().revert(Error::AuctionNotEnded);
        }

        lot.settled = true;
        self.auctions.set(&auction_id, lot.clone());

        let this = self.env().self_address();
        let receiver = lot.highest_bidder.unwrap_or(lot.seller);
        Cep95ContractRef::new(self.env(), lot.nft).transfer_from(this, receiver, lot.token_id);
        if lot.highest_bidder.is_some() {
            self.env().transfer_tokens(&lot.seller, &lot.highest_bid);
        }

        self.env().emit_event(AuctionSettled {
            auction_id,
            seller: lot.seller,
            winner: lot.highest_bidder,
            price: lot.highest_bid,
        });
    }

    /// Returns the auction with the given id.
    pub fn auction(&self, auction_id: u64) -> Lot {
        self.get_lot(auction_id)
    }

    /// Returns the lowest bid the auction accepts now, in motes.
    pub fn min_next_bid(&self, auction_id: u64) -> U512 {
        min_next_bid(&self.get_lot(auction_id))
    }

    /// Returns the number of auctions created. Ids run from `0` to `count - 1`.
    pub fn auctions_count(&self) -> u64 {
        self.count.get_or_default()
    }

    /// Returns the ids of the auctions `seller` created.
    pub fn auctions_of_seller(&self, seller: Address) -> Vec<u64> {
        self.by_seller.get_or_default(&seller)
    }

    /// Returns the ids of the auctions `bidder` bid in.
    pub fn auctions_of_bidder(&self, bidder: Address) -> Vec<u64> {
        self.by_bidder.get_or_default(&bidder)
    }

    /// Returns the outbid CSPR `bidder` can take back from the auction, in motes.
    pub fn withdrawable(&self, auction_id: u64, bidder: Address) -> U512 {
        self.pending_returns.get_or_default(&(auction_id, bidder))
    }
}

impl Auction {
    fn get_lot(&self, auction_id: u64) -> Lot {
        self.auctions
            .get(&auction_id)
            .unwrap_or_revert_with(self, Error::AuctionNotFound)
    }
}

/// The lowest bid the auction accepts: the minimum bid before the first bid, then the highest bid
/// and `MIN_STEP_PERCENT` of it, rounded down, but at least one mote more.
pub fn min_next_bid(lot: &Lot) -> U512 {
    if lot.highest_bidder.is_none() {
        return lot.min_bid;
    }
    let step = lot.highest_bid * U512::from(MIN_STEP_PERCENT) / U512::from(100);
    lot.highest_bid + step.max(U512::one())
}

fn push_id(index: &mut Mapping<Address, Vec<u64>>, account: &Address, auction_id: u64) {
    let mut ids = index.get_or_default(account);
    ids.push(auction_id);
    index.set(account, ids);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nft::{TestNft, TestNftHostRef};
    use odra::host::{Deployer, HostEnv, HostRef, NoArgs};
    use odra_modules::cep95::Error as Cep95Error;

    const CSPR: u64 = 1_000_000_000;
    const MINUTE: u64 = 60 * 1000;
    const HOUR: u64 = 60 * MINUTE;

    fn cspr(amount: u64) -> U512 {
        U512::from(amount) * U512::from(CSPR)
    }

    struct Setup {
        env: HostEnv,
        nft: TestNftHostRef,
        auction: AuctionHostRef,
        seller: Address,
        alice: Address,
        bob: Address,
        carol: Address,
    }

    /// Deploys both contracts; the seller mints NFT 0 and approves the auction for it.
    fn setup() -> Setup {
        let env = odra_test::env();
        let seller = env.get_account(1);
        let alice = env.get_account(2);
        let bob = env.get_account(3);
        let carol = env.get_account(4);
        let mut nft = TestNft::deploy(&env, NoArgs);
        let auction = Auction::deploy(&env, NoArgs);

        env.set_caller(seller);
        nft.mint(String::from("Sunrise over the Odra"));
        nft.approve(auction.address(), U256::zero());

        Setup {
            env,
            nft,
            auction,
            seller,
            alice,
            bob,
            carol,
        }
    }

    impl Setup {
        /// Auctions NFT 0 with a minimum bid of 10 CSPR, ending in an hour.
        fn create(&mut self) -> u64 {
            let id = self.auction.auctions_count();
            let end = self.env.block_time() + HOUR;
            self.env.set_caller(self.seller);
            self.auction
                .create_auction(self.nft.address(), U256::zero(), cspr(10), end);
            id
        }

        fn bid(&mut self, bidder: Address, id: u64, amount: U512) -> OdraResult<()> {
            self.env.set_caller(bidder);
            self.auction.with_tokens(amount).try_bid(id)
        }

        fn held(&self) -> U512 {
            self.env.balance_of(&self.auction)
        }
    }

    #[test]
    fn creating_an_auction_takes_the_nft() {
        let mut s = setup();
        let now = s.env.block_time();
        let id = s.create();

        assert_eq!(id, 0);
        assert_eq!(s.auction.auctions_count(), 1);
        assert_eq!(
            s.auction.auction(id),
            Lot {
                seller: s.seller,
                nft: s.nft.address(),
                token_id: U256::zero(),
                min_bid: cspr(10),
                start: now,
                end: now + HOUR,
                highest_bid: U512::zero(),
                highest_bidder: None,
                bids: 0,
                settled: false,
            }
        );
        assert_eq!(s.nft.owner_of(U256::zero()), Some(s.auction.address()));
        assert_eq!(s.auction.auctions_of_seller(s.seller), vec![0]);
        assert_eq!(s.auction.min_next_bid(id), cspr(10));
        assert!(s.env.emitted_event(
            &s.auction,
            AuctionCreated {
                auction_id: 0,
                seller: s.seller,
                nft: s.nft.address(),
                token_id: U256::zero(),
                min_bid: cspr(10),
                end: now + HOUR,
            }
        ));
    }

    #[test]
    fn an_auction_needs_the_nft_approved_and_sensible_terms() {
        let s = setup();
        let mut nft = s.nft;
        let mut auction = s.auction;
        let env = s.env;
        let now = env.block_time();

        // Alice mints NFT 1 but does not approve the auction.
        env.set_caller(s.alice);
        nft.mint(String::from("Harbour"));
        let one = U256::one();
        assert_eq!(
            auction.try_create_auction(nft.address(), one, cspr(1), now + HOUR),
            Err(Cep95Error::NotAnOwnerOrApproved.into())
        );
        // Nor can she auction the seller's NFT 0, which the auction is approved for.
        assert_eq!(
            auction.try_create_auction(nft.address(), U256::zero(), cspr(1), now + HOUR),
            Err(Cep95Error::NotAnOwnerOrApproved.into())
        );
        assert_eq!(
            auction.try_create_auction(nft.address(), U256::from(9), cspr(1), now + HOUR),
            Err(Cep95Error::InvalidTokenId.into())
        );

        nft.approve(auction.address(), one);
        assert_eq!(
            auction.try_create_auction(nft.address(), one, U512::zero(), now + HOUR),
            Err(Error::ZeroMinBid.into())
        );
        assert_eq!(
            auction.try_create_auction(nft.address(), one, cspr(1), now),
            Err(Error::EndNotInFuture.into())
        );
        assert_eq!(
            auction.try_create_auction(nft.address(), one, cspr(1), now + MAX_DURATION + 1),
            Err(Error::DurationTooLong.into())
        );
        assert_eq!(auction.auctions_count(), 0);
        assert_eq!(
            auction.try_create_auction(nft.address(), one, cspr(1), now + MAX_DURATION),
            Ok(())
        );
        assert_eq!(auction.auctions_of_seller(s.alice), vec![0]);
    }

    #[test]
    fn each_bid_must_beat_the_last_by_five_percent() {
        let mut s = setup();
        let id = s.create();

        assert_eq!(
            s.bid(s.alice, id, cspr(10) - 1),
            Err(Error::BidTooLow.into())
        );
        assert_eq!(s.bid(s.alice, id, cspr(10)), Ok(()));
        assert_eq!(s.auction.min_next_bid(id), U512::from(10_500_000_000u64));
        assert_eq!(
            s.bid(s.bob, id, U512::from(10_499_999_999u64)),
            Err(Error::BidTooLow.into())
        );
        assert_eq!(s.bid(s.bob, id, cspr(20)), Ok(()));

        let lot = s.auction.auction(id);
        assert_eq!(lot.highest_bid, cspr(20));
        assert_eq!(lot.highest_bidder, Some(s.bob));
        assert_eq!(lot.bids, 2);
        assert_eq!(s.auction.min_next_bid(id), cspr(21));
        assert_eq!(s.held(), cspr(30));
        // The outbid stake waits for Alice; Bob's bid is not his to take back.
        assert_eq!(s.auction.withdrawable(id, s.alice), cspr(10));
        assert_eq!(s.auction.withdrawable(id, s.bob), U512::zero());
        assert!(s.env.emitted_event(
            &s.auction,
            BidPlaced {
                auction_id: id,
                bidder: s.bob,
                amount: cspr(20),
                end: lot.end,
            }
        ));
    }

    #[test]
    fn a_tiny_bid_is_beaten_by_at_least_one_mote() {
        let mut s = setup();
        let end = s.env.block_time() + HOUR;
        s.env.set_caller(s.seller);
        s.auction
            .create_auction(s.nft.address(), U256::zero(), U512::from(3), end);

        s.bid(s.alice, 0, U512::from(3)).unwrap();
        assert_eq!(s.auction.min_next_bid(0), U512::from(4));
        s.bid(s.bob, 0, U512::from(4)).unwrap();
        assert_eq!(s.auction.min_next_bid(0), U512::from(5));
    }

    #[test]
    fn outbid_bidders_take_their_stakes_back_at_any_time() {
        let mut s = setup();
        let id = s.create();
        s.bid(s.alice, id, cspr(10)).unwrap();
        s.bid(s.bob, id, cspr(11)).unwrap();
        s.bid(s.alice, id, cspr(12)).unwrap();
        s.bid(s.bob, id, cspr(13)).unwrap();

        // Both of Alice's bids add up; she takes them back before the end.
        assert_eq!(s.auction.withdrawable(id, s.alice), cspr(22));
        assert_eq!(s.auction.withdrawable(id, s.bob), cspr(11));
        s.env.set_caller(s.alice);
        s.auction.withdraw(id);
        assert_eq!(s.auction.withdrawable(id, s.alice), U512::zero());
        assert_eq!(s.held(), cspr(24));
        assert!(s.env.emitted_event(
            &s.auction,
            Withdrawn {
                auction_id: id,
                bidder: s.alice,
                amount: cspr(22),
            }
        ));
        assert_eq!(
            s.auction.try_withdraw(id),
            Err(Error::NothingToWithdraw.into())
        );
        // A bidder is listed once per auction, however often they bid.
        assert_eq!(s.auction.auctions_of_bidder(s.alice), vec![id]);
        assert!(s.auction.auctions_of_bidder(s.carol).is_empty());

        // The highest bidder cannot take the leading bid back.
        s.env.set_caller(s.bob);
        s.auction.withdraw(id);
        assert_eq!(
            s.auction.try_withdraw(id),
            Err(Error::NothingToWithdraw.into())
        );
        assert_eq!(s.held(), cspr(13));
    }

    #[test]
    fn a_late_bid_moves_the_end() {
        let mut s = setup();
        let id = s.create();
        let end = s.auction.auction(id).end;

        // Ten minutes before the end: the end stays.
        s.env.advance_block_time(HOUR - 10 * MINUTE);
        s.bid(s.alice, id, cspr(10)).unwrap();
        assert_eq!(s.auction.auction(id).end, end);

        // A minute before the end: the end moves to five minutes after the bid.
        s.env.advance_block_time(9 * MINUTE);
        s.bid(s.bob, id, cspr(11)).unwrap();
        let moved = s.env.block_time() + EXTENSION;
        assert_eq!(s.auction.auction(id).end, moved);
        assert!(s.env.emitted_event(
            &s.auction,
            BidPlaced {
                auction_id: id,
                bidder: s.bob,
                amount: cspr(11),
                end: moved,
            }
        ));

        // The original end has passed, the auction goes on.
        s.env.advance_block_time(2 * MINUTE);
        s.env.set_caller(s.carol);
        assert_eq!(s.auction.try_settle(id), Err(Error::AuctionNotEnded.into()));
        s.bid(s.alice, id, cspr(12)).unwrap();

        s.env.advance_block_time(EXTENSION);
        assert_eq!(s.bid(s.bob, id, cspr(13)), Err(Error::AuctionEnded.into()));
    }

    #[test]
    fn settling_sends_the_nft_to_the_winner_and_the_cspr_to_the_seller() {
        let mut s = setup();
        let id = s.create();
        s.bid(s.alice, id, cspr(10)).unwrap();
        s.bid(s.bob, id, cspr(15)).unwrap();

        s.env.set_caller(s.carol);
        assert_eq!(s.auction.try_settle(id), Err(Error::AuctionNotEnded.into()));

        s.env.advance_block_time(HOUR);
        assert_eq!(
            s.bid(s.alice, id, cspr(20)),
            Err(Error::AuctionEnded.into())
        );
        let before = s.env.balance_of(&s.seller);
        // Anyone may settle; Carol pays the gas.
        s.env.set_caller(s.carol);
        s.auction.settle(id);

        assert_eq!(s.nft.owner_of(U256::zero()), Some(s.bob));
        assert_eq!(s.env.balance_of(&s.seller), before + cspr(15));
        assert_eq!(s.held(), cspr(10));
        assert!(s.auction.auction(id).settled);
        assert!(s.env.emitted_event(
            &s.auction,
            AuctionSettled {
                auction_id: id,
                seller: s.seller,
                winner: Some(s.bob),
                price: cspr(15),
            }
        ));
        assert_eq!(s.auction.try_settle(id), Err(Error::AlreadySettled.into()));
        assert_eq!(
            s.bid(s.alice, id, cspr(20)),
            Err(Error::AuctionEnded.into())
        );

        // The outbid stake is still there after the end.
        s.env.set_caller(s.alice);
        s.auction.withdraw(id);
        assert_eq!(s.held(), U512::zero());
    }

    #[test]
    fn an_auction_nobody_bid_in_returns_the_nft() {
        let mut s = setup();
        let id = s.create();
        s.env.advance_block_time(HOUR);
        let before = s.env.balance_of(&s.seller);

        s.env.set_caller(s.carol);
        s.auction.settle(id);

        assert_eq!(s.nft.owner_of(U256::zero()), Some(s.seller));
        assert_eq!(s.env.balance_of(&s.seller), before);
        assert!(s.env.emitted_event(
            &s.auction,
            AuctionSettled {
                auction_id: id,
                seller: s.seller,
                winner: None,
                price: U512::zero(),
            }
        ));

        // The seller can auction it again.
        s.env.set_caller(s.seller);
        s.nft.approve(s.auction.address(), U256::zero());
        assert_eq!(s.create(), 1);
        assert_eq!(s.auction.auctions_of_seller(s.seller), vec![0, 1]);
    }

    #[test]
    fn auctions_keep_their_bids_apart() {
        let mut s = setup();
        let first = s.create();
        s.env.set_caller(s.alice);
        s.nft.mint(String::from("Harbour"));
        s.nft.approve(s.auction.address(), U256::one());
        let end = s.env.block_time() + 2 * HOUR;
        s.auction
            .create_auction(s.nft.address(), U256::one(), cspr(1), end);
        let second = 1;

        s.bid(s.bob, first, cspr(10)).unwrap();
        s.bid(s.bob, second, cspr(1)).unwrap();
        s.bid(s.carol, second, cspr(2)).unwrap();
        assert_eq!(s.auction.withdrawable(first, s.bob), U512::zero());
        assert_eq!(s.auction.withdrawable(second, s.bob), cspr(1));
        assert_eq!(s.auction.auctions_of_bidder(s.bob), vec![first, second]);

        s.env.advance_block_time(HOUR);
        s.auction.settle(first);
        assert_eq!(s.nft.owner_of(U256::zero()), Some(s.bob));
        assert_eq!(
            s.auction.try_settle(second),
            Err(Error::AuctionNotEnded.into())
        );
        assert_eq!(s.nft.owner_of(U256::one()), Some(s.auction.address()));
    }

    #[test]
    fn unknown_auctions_are_rejected() {
        let mut s = setup();
        assert_eq!(
            s.bid(s.alice, 7, cspr(1)),
            Err(Error::AuctionNotFound.into())
        );
        assert_eq!(
            s.auction.try_withdraw(7),
            Err(Error::AuctionNotFound.into())
        );
        assert_eq!(s.auction.try_settle(7), Err(Error::AuctionNotFound.into()));
        assert_eq!(s.auction.try_auction(7), Err(Error::AuctionNotFound.into()));
    }

    /// The sequence of the CLI's `demo` scenario, sent by one account. On CasperVM
    /// (`cargo odra test -b casper -s -- --nocapture`) it prints the gas of every transaction.
    #[test]
    fn the_demo_runs_and_reports_its_gas() {
        let env = odra_test::env();
        env.set_caller(env.get_account(0));
        let mut nft = TestNft::deploy(&env, NoArgs);
        let mut auction = Auction::deploy(&env, NoArgs);

        let outcome =
            crate::demo::run(&mut nft, &mut auction, crate::demo::Options::default()).unwrap();

        assert_eq!(
            outcome.price,
            crate::demo::Options::default().min_bid * 105 / 100
        );
        assert_eq!(outcome.withdrawn, crate::demo::Options::default().min_bid);
        assert_eq!(nft.owner_of(outcome.token_id), Some(env.caller()));
        assert!(auction.auction(outcome.auction_id).settled);
        assert_eq!(env.balance_of(&auction), U512::zero());
        println!("{}", env.gas_report());
    }
}
