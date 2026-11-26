//! An over-the-counter swap of two CEP-18 tokens: a maker puts tokens in the contract and names
//! what they want for them; a taker sends that and gets the maker's tokens in the same
//! transaction. There is no pool and no price that moves: the whole offer at its price, or nothing.

// `#[odra::event]` generates a constructor with one argument per field, and `OfferMade` has
// eight; an `allow` on the struct does not reach the generated function.
#![allow(clippy::too_many_arguments)]

use odra::casper_types::U256;
use odra::prelude::*;
use odra::ContractRef;
use odra_modules::cep18_token::Cep18ContractRef;

/// Where an offer stands. Only an `Open` offer holds the maker's tokens.
#[odra::odra_type]
#[derive(Copy)]
pub enum OfferState {
    /// The maker's tokens are in the contract; the offer can be taken until it expires and
    /// cancelled until it is taken.
    Open,
    /// Taken: the maker received the wanted tokens and the taker the maker's.
    Taken,
    /// The maker cancelled it and took the tokens back.
    Cancelled,
}

/// An offer. Times are block times: milliseconds since the Unix epoch.
#[odra::odra_type]
pub struct Offer {
    /// The account that made the offer and put its tokens in the contract.
    pub maker: Address,
    /// The CEP-18 token the maker gives.
    pub give_token: Address,
    /// How much of `give_token` the maker gives; the contract holds it while the offer is open.
    pub give_amount: U256,
    /// The CEP-18 token the maker wants in return.
    pub want_token: Address,
    /// How much of `want_token` the maker wants.
    pub want_amount: U256,
    /// The only account that may take the offer; `None` when anyone may.
    pub taker: Option<Address>,
    /// From this moment on the offer can no longer be taken. The maker can still cancel it.
    pub expiry: u64,
    /// Where the offer stands.
    pub state: OfferState,
    /// The account that took the offer; `None` until it is taken.
    pub taken_by: Option<Address>,
}

/// Errors of the swap contract.
#[odra::odra_error]
pub enum Error {
    /// An amount of a new offer is zero.
    ZeroAmount = 1,
    /// A new offer gives and wants the same token.
    SameToken = 2,
    /// The expiry of a new offer is not in the future.
    ExpiryNotInFuture = 3,
    /// No offer has this id.
    OfferNotFound = 4,
    /// Only the maker of the offer may cancel it.
    NotMaker = 5,
    /// The offer is for another account.
    NotTaker = 6,
    /// The offer has expired: it can no longer be taken.
    OfferExpired = 7,
    /// The offer has been taken or cancelled already.
    OfferClosed = 8,
}

/// A maker put tokens in the contract and named what they want for them.
#[odra::event]
pub struct OfferMade {
    pub offer_id: u64,
    pub maker: Address,
    pub give_token: Address,
    pub give_amount: U256,
    pub want_token: Address,
    pub want_amount: U256,
    /// The only account that may take it; `None` when anyone may.
    pub taker: Option<Address>,
    pub expiry: u64,
}

/// An offer was taken: both sides were paid in the same transaction.
#[odra::event]
pub struct OfferTaken {
    pub offer_id: u64,
    pub maker: Address,
    pub taker: Address,
    /// What the taker received, of the offer's `give_token`.
    pub give_amount: U256,
    /// What the maker received, of the offer's `want_token`.
    pub want_amount: U256,
}

/// The maker cancelled an offer and took the tokens back.
#[odra::event]
pub struct OfferCancelled {
    pub offer_id: u64,
    pub maker: Address,
    /// What went back to the maker, of the offer's `give_token`.
    pub give_amount: U256,
}

/// Holds the tokens of open swap offers and settles each offer in one transaction.
///
/// Anyone can make an offer between any two CEP-18 tokens; the contract has no owner and no fees.
#[odra::module(events = [OfferMade, OfferTaken, OfferCancelled], errors = Error)]
pub struct OtcSwap {
    /// Offers by id.
    offers: Mapping<u64, Offer>,
    /// The number of offers made; also the id of the next one.
    count: Var<u64>,
    /// Ids of the offers an account made.
    by_maker: Mapping<Address, Vec<u64>>,
    /// Ids of the offers made for an account, and of the public offers it took.
    by_taker: Mapping<Address, Vec<u64>>,
    /// Ids of the public offers that are neither taken nor cancelled, expired ones included.
    open_public: Var<Vec<u64>>,
}

#[odra::module]
impl OtcSwap {
    /// Makes an offer with the caller as the maker: `give_amount` of `give_token` for
    /// `want_amount` of `want_token`. Pulls `give_amount` from the caller, who must have approved
    /// this contract for at least that amount. The id of the offer is the value `offers_count`
    /// returned before the call; the `OfferMade` event carries it.
    ///
    /// With `taker` set, only that account may take the offer; with `None`, anyone may, and the
    /// offer is listed among the open public offers. `expiry` is in milliseconds since the Unix
    /// epoch and must be in the future.
    pub fn make_offer(
        &mut self,
        give_token: Address,
        give_amount: U256,
        want_token: Address,
        want_amount: U256,
        taker: Option<Address>,
        expiry: u64,
    ) {
        if give_amount.is_zero() || want_amount.is_zero() {
            self.env().revert(Error::ZeroAmount);
        }
        if give_token == want_token {
            self.env().revert(Error::SameToken);
        }
        if expiry <= self.env().get_block_time() {
            self.env().revert(Error::ExpiryNotInFuture);
        }

        let maker = self.env().caller();
        let offer_id = self.count.get_or_default();
        self.count.set(offer_id + 1);
        self.offers.set(
            &offer_id,
            Offer {
                maker,
                give_token,
                give_amount,
                want_token,
                want_amount,
                taker,
                expiry,
                state: OfferState::Open,
                taken_by: None,
            },
        );
        push_id(&mut self.by_maker, &maker, offer_id);
        match taker {
            Some(taker) => push_id(&mut self.by_taker, &taker, offer_id),
            None => {
                let mut open = self.open_public.get_or_default();
                open.push(offer_id);
                self.open_public.set(open);
            }
        }

        Cep18ContractRef::new(self.env(), give_token).transfer_from(
            &maker,
            &self.env().self_address(),
            &give_amount,
        );

        self.env().emit_event(OfferMade {
            offer_id,
            maker,
            give_token,
            give_amount,
            want_token,
            want_amount,
            taker,
            expiry,
        });
    }

    /// Takes an offer: moves `want_amount` of `want_token` from the caller to the maker, with the
    /// allowance the caller gave this contract, and sends the held `give_amount` of `give_token`
    /// to the caller. Both legs happen in this one transaction, or neither does. A maker taking
    /// its own offer only gets its tokens back.
    ///
    /// Only the named taker may take an offer made for one; anyone may take a public offer. An
    /// offer can be taken only before its expiry.
    pub fn take(&mut self, offer_id: u64) {
        let mut offer = self.open_offer(offer_id);
        let caller = self.env().caller();
        if offer.taker.is_some_and(|taker| taker != caller) {
            self.env().revert(Error::NotTaker);
        }
        if self.env().get_block_time() >= offer.expiry {
            self.env().revert(Error::OfferExpired);
        }

        offer.state = OfferState::Taken;
        offer.taken_by = Some(caller);
        self.offers.set(&offer_id, offer.clone());
        if offer.taker.is_none() {
            self.unlist(offer_id);
            push_id(&mut self.by_taker, &caller, offer_id);
        }

        // The wanted tokens go from the taker straight to the maker. A maker who takes its own
        // offer would pay itself, which CEP-18 refuses; there is nothing to move, so that leg is
        // skipped and the take works like a cancel. That is how the demo runs with one key.
        if caller != offer.maker {
            Cep18ContractRef::new(self.env(), offer.want_token).transfer_from(
                &caller,
                &offer.maker,
                &offer.want_amount,
            );
        }
        Cep18ContractRef::new(self.env(), offer.give_token).transfer(&caller, &offer.give_amount);

        self.env().emit_event(OfferTaken {
            offer_id,
            maker: offer.maker,
            taker: caller,
            give_amount: offer.give_amount,
            want_amount: offer.want_amount,
        });
    }

    /// Cancels an offer and sends the held tokens back to the maker. Only the maker may call it,
    /// at any time until the offer is taken, after its expiry too.
    pub fn cancel(&mut self, offer_id: u64) {
        let mut offer = self.open_offer(offer_id);
        if self.env().caller() != offer.maker {
            self.env().revert(Error::NotMaker);
        }

        offer.state = OfferState::Cancelled;
        self.offers.set(&offer_id, offer.clone());
        if offer.taker.is_none() {
            self.unlist(offer_id);
        }

        Cep18ContractRef::new(self.env(), offer.give_token)
            .transfer(&offer.maker, &offer.give_amount);

        self.env().emit_event(OfferCancelled {
            offer_id,
            maker: offer.maker,
            give_amount: offer.give_amount,
        });
    }

    /// Returns the offer with the given id.
    pub fn offer(&self, offer_id: u64) -> Offer {
        self.get_offer(offer_id)
    }

    /// Returns the number of offers made. Ids run from `0` to `count - 1`.
    pub fn offers_count(&self) -> u64 {
        self.count.get_or_default()
    }

    /// Returns the ids of the offers `account` made.
    pub fn offers_of_maker(&self, account: Address) -> Vec<u64> {
        self.by_maker.get_or_default(&account)
    }

    /// Returns the ids of the offers made for `account`, and of the public offers it took.
    pub fn offers_of_taker(&self, account: Address) -> Vec<u64> {
        self.by_taker.get_or_default(&account)
    }

    /// Returns the ids of the public offers that are neither taken nor cancelled. Expired ones
    /// stay in the list until their makers cancel them.
    pub fn open_public_offers(&self) -> Vec<u64> {
        self.open_public.get_or_default()
    }
}

impl OtcSwap {
    fn get_offer(&self, offer_id: u64) -> Offer {
        self.offers
            .get(&offer_id)
            .unwrap_or_revert_with(self, Error::OfferNotFound)
    }

    /// The offer, if it still holds the maker's tokens.
    fn open_offer(&self, offer_id: u64) -> Offer {
        let offer = self.get_offer(offer_id);
        if offer.state != OfferState::Open {
            self.env().revert(Error::OfferClosed);
        }
        offer
    }

    /// Removes a public offer from the list of open ones.
    fn unlist(&mut self, offer_id: u64) {
        let mut open = self.open_public.get_or_default();
        open.retain(|id| *id != offer_id);
        self.open_public.set(open);
    }
}

fn push_id(index: &mut Mapping<Address, Vec<u64>>, account: &Address, offer_id: u64) {
    let mut ids = index.get_or_default(account);
    ids.push(offer_id);
    index.set(account, ids);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::token::{TestDollar, TestDollarHostRef, TestToken, TestTokenHostRef};
    use odra::host::{Deployer, HostEnv, NoArgs};
    use odra_modules::cep18::errors::Error as Cep18Error;

    const DAY: u64 = 24 * 60 * 60 * 1000;
    /// The maker gives 1000 units of TEST...
    const GIVE: u64 = 1000;
    /// ...for 2500 units of TUSD.
    const WANT: u64 = 2500;

    struct Setup {
        env: HostEnv,
        test: TestTokenHostRef,
        dollar: TestDollarHostRef,
        swap: OtcSwapHostRef,
        maker: Address,
        taker: Address,
        stranger: Address,
    }

    /// Deploys the three contracts. The maker gets TEST, the taker and the stranger get TUSD, and
    /// each approves the swap contract for all of it.
    fn setup() -> Setup {
        let env = odra_test::env();
        let maker = env.get_account(1);
        let taker = env.get_account(2);
        let stranger = env.get_account(3);
        let mut test = TestToken::deploy(&env, NoArgs);
        let mut dollar = TestDollar::deploy(&env, NoArgs);
        let swap = OtcSwap::deploy(&env, NoArgs);

        env.set_caller(maker);
        test.faucet();
        test.approve(&swap.address(), &TestToken::faucet_amount());
        for who in [taker, stranger] {
            env.set_caller(who);
            dollar.faucet();
            dollar.approve(&swap.address(), &TestDollar::faucet_amount());
        }

        Setup {
            env,
            test,
            dollar,
            swap,
            maker,
            taker,
            stranger,
        }
    }

    /// Makes an offer of 1000 TEST units for 2500 TUSD units, expiring in a day.
    fn make(s: &mut Setup, taker: Option<Address>) -> u64 {
        let id = s.swap.offers_count();
        let expiry = s.env.block_time() + DAY;
        s.env.set_caller(s.maker);
        s.swap.make_offer(
            s.test.address(),
            U256::from(GIVE),
            s.dollar.address(),
            U256::from(WANT),
            taker,
            expiry,
        );
        id
    }

    /// Makes the same offer for the taker only.
    fn make_for_taker(s: &mut Setup) -> u64 {
        let taker = s.taker;
        make(s, Some(taker))
    }

    /// TEST and TUSD balances of the maker, the taker and the contract.
    fn balances(s: &Setup) -> [(U256, U256); 3] {
        [s.maker, s.taker, s.swap.address()]
            .map(|who| (s.test.balance_of(&who), s.dollar.balance_of(&who)))
    }

    fn test_start() -> U256 {
        TestToken::faucet_amount()
    }

    fn dollar_start() -> U256 {
        TestDollar::faucet_amount()
    }

    #[test]
    fn making_an_offer_pulls_the_given_tokens() {
        let mut s = setup();
        let expiry = s.env.block_time() + DAY;
        let id = make_for_taker(&mut s);

        assert_eq!(id, 0);
        assert_eq!(s.swap.offers_count(), 1);
        assert_eq!(
            balances(&s),
            [
                (test_start() - GIVE, U256::zero()),
                (U256::zero(), dollar_start()),
                (U256::from(GIVE), U256::zero()),
            ]
        );
        assert_eq!(
            s.swap.offer(id),
            Offer {
                maker: s.maker,
                give_token: s.test.address(),
                give_amount: U256::from(GIVE),
                want_token: s.dollar.address(),
                want_amount: U256::from(WANT),
                taker: Some(s.taker),
                expiry,
                state: OfferState::Open,
                taken_by: None,
            }
        );
        assert_eq!(s.swap.offers_of_maker(s.maker), vec![0]);
        assert_eq!(s.swap.offers_of_taker(s.taker), vec![0]);
        assert!(s.swap.offers_of_taker(s.stranger).is_empty());
        assert!(s.swap.open_public_offers().is_empty());
        assert!(s.env.emitted_event(
            &s.swap,
            OfferMade {
                offer_id: 0,
                maker: s.maker,
                give_token: s.test.address(),
                give_amount: U256::from(GIVE),
                want_token: s.dollar.address(),
                want_amount: U256::from(WANT),
                taker: Some(s.taker),
                expiry,
            }
        ));
    }

    #[test]
    fn a_public_offer_is_listed_as_open() {
        let mut s = setup();
        assert_eq!(make(&mut s, None), 0);
        assert_eq!(make_for_taker(&mut s), 1);
        assert_eq!(make(&mut s, None), 2);

        assert_eq!(s.swap.open_public_offers(), vec![0, 2]);
        assert_eq!(s.swap.offers_of_maker(s.maker), vec![0, 1, 2]);
        assert_eq!(s.swap.offers_of_taker(s.taker), vec![1]);
        assert_eq!(s.swap.offer(0).taker, None);
    }

    #[test]
    fn taking_swaps_both_sides_at_once() {
        let mut s = setup();
        let id = make_for_taker(&mut s);

        s.env.set_caller(s.taker);
        s.swap.take(id);

        assert_eq!(
            balances(&s),
            [
                (test_start() - GIVE, U256::from(WANT)),
                (U256::from(GIVE), dollar_start() - WANT),
                (U256::zero(), U256::zero()),
            ]
        );
        let offer = s.swap.offer(id);
        assert_eq!(offer.state, OfferState::Taken);
        assert_eq!(offer.taken_by, Some(s.taker));
        // A named taker's list does not get the offer twice.
        assert_eq!(s.swap.offers_of_taker(s.taker), vec![id]);
        assert!(s.env.emitted_event(
            &s.swap,
            OfferTaken {
                offer_id: id,
                maker: s.maker,
                taker: s.taker,
                give_amount: U256::from(GIVE),
                want_amount: U256::from(WANT),
            }
        ));
    }

    #[test]
    fn anyone_takes_a_public_offer_and_it_leaves_the_open_list() {
        let mut s = setup();
        let first = make(&mut s, None);
        let second = make(&mut s, None);

        s.env.set_caller(s.stranger);
        s.swap.take(first);

        assert_eq!(s.swap.open_public_offers(), vec![second]);
        assert_eq!(s.swap.offer(first).taken_by, Some(s.stranger));
        assert_eq!(s.swap.offers_of_taker(s.stranger), vec![first]);
        assert_eq!(s.test.balance_of(&s.stranger), U256::from(GIVE));
        assert_eq!(s.dollar.balance_of(&s.maker), U256::from(WANT));
    }

    #[test]
    fn only_the_named_taker_may_take() {
        let mut s = setup();
        let id = make_for_taker(&mut s);

        for who in [s.stranger, s.maker] {
            s.env.set_caller(who);
            assert_eq!(s.swap.try_take(id), Err(Error::NotTaker.into()));
        }
        assert_eq!(s.swap.offer(id).state, OfferState::Open);
    }

    #[test]
    fn an_expired_offer_cannot_be_taken_but_can_be_cancelled() {
        let mut s = setup();
        let id = make(&mut s, None);

        s.env.advance_block_time(DAY - 1);
        s.env.set_caller(s.taker);
        let before = balances(&s);
        s.env.advance_block_time(1);
        assert_eq!(s.swap.try_take(id), Err(Error::OfferExpired.into()));
        assert_eq!(balances(&s), before);

        s.env.set_caller(s.maker);
        s.swap.cancel(id);
        assert_eq!(s.test.balance_of(&s.maker), test_start());
        assert!(s.swap.open_public_offers().is_empty());
    }

    #[test]
    fn the_last_moment_before_expiry_still_takes() {
        let mut s = setup();
        let id = make(&mut s, None);
        s.env.advance_block_time(DAY - 1);
        s.env.set_caller(s.taker);
        s.swap.take(id);
        assert_eq!(s.swap.offer(id).state, OfferState::Taken);
    }

    #[test]
    fn cancelling_returns_the_tokens_to_the_maker() {
        let mut s = setup();
        let named = make_for_taker(&mut s);
        let public = make(&mut s, None);

        s.env.set_caller(s.maker);
        s.swap.cancel(named);
        s.swap.cancel(public);

        assert_eq!(
            balances(&s),
            [
                (test_start(), U256::zero()),
                (U256::zero(), dollar_start()),
                (U256::zero(), U256::zero()),
            ]
        );
        assert_eq!(s.swap.offer(named).state, OfferState::Cancelled);
        assert_eq!(s.swap.offer(public).taken_by, None);
        assert!(s.swap.open_public_offers().is_empty());
        // The lists keep the history.
        assert_eq!(s.swap.offers_of_maker(s.maker), vec![named, public]);
        assert_eq!(s.swap.offers_of_taker(s.taker), vec![named]);
        assert!(s.env.emitted_event(
            &s.swap,
            OfferCancelled {
                offer_id: public,
                maker: s.maker,
                give_amount: U256::from(GIVE),
            }
        ));
    }

    #[test]
    fn only_the_maker_may_cancel() {
        let mut s = setup();
        let id = make_for_taker(&mut s);
        for who in [s.taker, s.stranger] {
            s.env.set_caller(who);
            assert_eq!(s.swap.try_cancel(id), Err(Error::NotMaker.into()));
        }
    }

    #[test]
    fn a_closed_offer_cannot_be_taken_or_cancelled() {
        let mut s = setup();
        let taken = make(&mut s, None);
        let cancelled = make(&mut s, None);
        s.env.set_caller(s.maker);
        s.swap.cancel(cancelled);
        s.env.set_caller(s.taker);
        s.swap.take(taken);

        for id in [taken, cancelled] {
            s.env.set_caller(s.stranger);
            assert_eq!(s.swap.try_take(id), Err(Error::OfferClosed.into()));
            s.env.set_caller(s.maker);
            assert_eq!(s.swap.try_cancel(id), Err(Error::OfferClosed.into()));
        }
    }

    #[test]
    fn a_take_without_enough_wanted_tokens_moves_nothing() {
        let mut s = setup();
        let id = make(&mut s, None);
        let maker = s.maker;
        let poor = s.env.get_account(4);
        s.env.set_caller(poor);
        assert_eq!(
            s.swap.try_take(id),
            Err(Cep18Error::InsufficientAllowance.into())
        );

        s.env.set_caller(s.taker);
        s.dollar.approve(&s.swap.address(), &U256::from(WANT - 1));
        assert_eq!(
            s.swap.try_take(id),
            Err(Cep18Error::InsufficientAllowance.into())
        );
        assert_eq!(s.swap.offer(id).state, OfferState::Open);
        assert_eq!(s.swap.open_public_offers(), vec![id]);
        assert_eq!(s.test.balance_of(&s.swap.address()), U256::from(GIVE));
        assert_eq!(s.dollar.balance_of(&maker), U256::zero());
    }

    #[test]
    fn one_account_may_take_its_own_offer() {
        let mut s = setup();
        let me = s.maker;
        let id = make(&mut s, None);

        // The maker would pay itself: nothing moves but the held tokens, and no TUSD or
        // allowance of it is needed.
        s.env.set_caller(me);
        s.swap.take(id);

        assert_eq!(s.test.balance_of(&me), test_start());
        assert_eq!(s.dollar.balance_of(&me), U256::zero());
        assert_eq!(s.swap.offer(id).state, OfferState::Taken);
        assert_eq!(s.swap.offer(id).taken_by, Some(me));
        assert_eq!(s.swap.offers_of_taker(me), vec![id]);
    }

    #[test]
    fn tokens_of_several_offers_stay_apart() {
        let mut s = setup();
        // A second offer in the other direction: the taker gives TUSD for TEST.
        let first = make(&mut s, None);
        s.env.set_caller(s.taker);
        s.swap.make_offer(
            s.dollar.address(),
            U256::from(WANT),
            s.test.address(),
            U256::from(GIVE),
            Some(s.maker),
            s.env.block_time() + DAY,
        );
        assert_eq!(
            balances(&s)[2],
            (U256::from(GIVE), U256::from(WANT)),
            "the contract holds both deposits"
        );

        s.env.set_caller(s.stranger);
        s.swap.take(first);
        s.env.set_caller(s.taker);
        s.swap.cancel(1);
        assert_eq!(balances(&s)[2], (U256::zero(), U256::zero()));
    }

    #[test]
    fn invalid_offers_are_rejected() {
        let s = setup();
        let mut swap = s.swap;
        let (test, dollar) = (s.test.address(), s.dollar.address());
        let now = s.env.block_time();
        s.env.set_caller(s.maker);
        let one = U256::one();

        assert_eq!(
            swap.try_make_offer(test, U256::zero(), dollar, one, None, now + DAY),
            Err(Error::ZeroAmount.into())
        );
        assert_eq!(
            swap.try_make_offer(test, one, dollar, U256::zero(), None, now + DAY),
            Err(Error::ZeroAmount.into())
        );
        assert_eq!(
            swap.try_make_offer(test, one, test, one, None, now + DAY),
            Err(Error::SameToken.into())
        );
        assert_eq!(
            swap.try_make_offer(test, one, dollar, one, None, now),
            Err(Error::ExpiryNotInFuture.into())
        );
        assert_eq!(
            swap.try_make_offer(test, test_start() + 1, dollar, one, None, now + DAY),
            Err(Cep18Error::InsufficientAllowance.into())
        );
        assert_eq!(swap.offers_count(), 0);
    }

    #[test]
    fn unknown_offers_are_reported() {
        let mut s = setup();
        assert_eq!(s.swap.try_offer(7), Err(Error::OfferNotFound.into()));
        assert_eq!(s.swap.try_take(7), Err(Error::OfferNotFound.into()));
        assert_eq!(s.swap.try_cancel(7), Err(Error::OfferNotFound.into()));
    }
}
