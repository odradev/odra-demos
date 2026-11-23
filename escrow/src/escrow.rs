//! Escrow with an arbiter: a buyer's CEP-18 deposit waits in the contract until the buyer releases
//! it to the seller, the seller sends it back, or the arbiter both chose decides a dispute.

use odra::casper_types::U256;
use odra::prelude::*;
use odra::ContractRef;
use odra_modules::cep18_token::Cep18ContractRef;

/// Where a deal stands. `Funded` and `Disputed` are open: the deposit is in the contract. The
/// other four are closed, and say where the deposit went.
#[odra::odra_type]
#[derive(Copy)]
pub enum DealState {
    /// The deposit is held; the buyer may release it, the seller may send it back.
    Funded,
    /// The buyer or the seller opened a dispute; the arbiter decides it.
    Disputed,
    /// The buyer released the deposit to the seller.
    Released,
    /// The seller sent the deposit back to the buyer.
    Refunded,
    /// The arbiter decided the dispute; `seller_share` says how the deposit was split.
    Resolved,
    /// The deadline passed with no dispute open, and the buyer took the deposit back.
    Reclaimed,
}

/// A deal. Times are block times: milliseconds since the Unix epoch.
#[odra::odra_type]
pub struct Deal {
    /// The account that deposited the tokens.
    pub buyer: Address,
    /// The account the tokens are for.
    pub seller: Address,
    /// The account that decides a dispute.
    pub arbiter: Address,
    /// The CEP-18 token deposited.
    pub token: Address,
    /// The amount deposited.
    pub amount: U256,
    /// From this moment on, the buyer may take back a deposit nobody disputes, and no dispute can
    /// be opened.
    pub deadline: u64,
    /// Where the deal stands.
    pub state: DealState,
    /// What the seller received when the deal closed; the buyer received the rest. Zero while the
    /// deal is open.
    pub seller_share: U256,
}

/// Errors of the escrow contract.
#[odra::odra_error]
pub enum Error {
    /// The amount of a new deal is zero.
    ZeroAmount = 1,
    /// The deadline of a new deal is not in the future.
    DeadlineNotInFuture = 2,
    /// No deal has this id.
    DealNotFound = 3,
    /// Only the buyer of the deal may do this.
    NotBuyer = 4,
    /// Only the seller of the deal may do this.
    NotSeller = 5,
    /// Only the buyer or the seller of the deal may do this.
    NotParty = 6,
    /// Only the arbiter of the deal may do this.
    NotArbiter = 7,
    /// The deal is closed: its deposit has been paid out.
    DealClosed = 8,
    /// A dispute is open already.
    AlreadyDisputed = 9,
    /// The arbiter can decide only a deal with a dispute open.
    NotDisputed = 10,
    /// The deadline has passed: a dispute can no longer be opened.
    DeadlinePassed = 11,
    /// The buyer can take the deposit back only from the deadline on.
    DeadlineNotReached = 12,
    /// A dispute is open: only the arbiter's decision, a release or a refund closes the deal.
    DisputeOpen = 13,
    /// The seller's share is more than the deposit.
    ShareTooLarge = 14,
}

/// A buyer deposited tokens for a seller.
#[odra::event]
pub struct DealCreated {
    pub deal_id: u64,
    pub buyer: Address,
    pub seller: Address,
    pub arbiter: Address,
    pub token: Address,
    pub amount: U256,
    pub deadline: u64,
}

/// The buyer or the seller opened a dispute.
#[odra::event]
pub struct DisputeOpened {
    pub deal_id: u64,
    /// The account that opened it.
    pub by: Address,
}

/// A deal closed and its deposit was paid out.
#[odra::event]
pub struct DealClosed {
    pub deal_id: u64,
    /// How it closed: `Released`, `Refunded`, `Resolved` or `Reclaimed`.
    pub state: DealState,
    /// What the seller received.
    pub to_seller: U256,
    /// What the buyer received.
    pub to_buyer: U256,
}

/// Holds CEP-18 deposits of buyers until the deal between a buyer and a seller is settled.
///
/// Anyone can open a deal in any CEP-18 token; the contract has no owner and no fees.
#[odra::module(events = [DealCreated, DisputeOpened, DealClosed], errors = Error)]
pub struct Escrow {
    /// Deals by id.
    deals: Mapping<u64, Deal>,
    /// The number of deals created; also the id of the next one.
    count: Var<u64>,
    /// Ids of the deals of an account as the buyer.
    by_buyer: Mapping<Address, Vec<u64>>,
    /// Ids of the deals of an account as the seller.
    by_seller: Mapping<Address, Vec<u64>>,
    /// Ids of the deals of an account as the arbiter.
    by_arbiter: Mapping<Address, Vec<u64>>,
}

#[odra::module]
impl Escrow {
    /// Opens a deal with the caller as the buyer and pulls `amount` of `token` from the caller,
    /// who must have approved this contract for at least that amount. The id of the deal is the
    /// value `deals_count` returned before the call; the `DealCreated` event carries it.
    ///
    /// `deadline` is in milliseconds since the Unix epoch and must be in the future. Any account
    /// may hold more than one role, the caller included.
    pub fn create_deal(
        &mut self,
        seller: Address,
        arbiter: Address,
        token: Address,
        amount: U256,
        deadline: u64,
    ) {
        if amount.is_zero() {
            self.env().revert(Error::ZeroAmount);
        }
        if deadline <= self.env().get_block_time() {
            self.env().revert(Error::DeadlineNotInFuture);
        }

        let buyer = self.env().caller();
        let deal_id = self.count.get_or_default();
        self.count.set(deal_id + 1);
        self.deals.set(
            &deal_id,
            Deal {
                buyer,
                seller,
                arbiter,
                token,
                amount,
                deadline,
                state: DealState::Funded,
                seller_share: U256::zero(),
            },
        );
        push_id(&mut self.by_buyer, &buyer, deal_id);
        push_id(&mut self.by_seller, &seller, deal_id);
        push_id(&mut self.by_arbiter, &arbiter, deal_id);

        Cep18ContractRef::new(self.env(), token).transfer_from(
            &buyer,
            &self.env().self_address(),
            &amount,
        );

        self.env().emit_event(DealCreated {
            deal_id,
            buyer,
            seller,
            arbiter,
            token,
            amount,
            deadline,
        });
    }

    /// Pays the whole deposit to the seller. Only the buyer may call it, while the deal is open,
    /// with or without a dispute.
    pub fn release(&mut self, deal_id: u64) {
        let deal = self.open_deal(deal_id);
        if self.env().caller() != deal.buyer {
            self.env().revert(Error::NotBuyer);
        }
        let amount = deal.amount;
        self.close(deal_id, deal, DealState::Released, amount);
    }

    /// Sends the whole deposit back to the buyer. Only the seller may call it, while the deal is
    /// open, with or without a dispute.
    pub fn refund(&mut self, deal_id: u64) {
        let deal = self.open_deal(deal_id);
        if self.env().caller() != deal.seller {
            self.env().revert(Error::NotSeller);
        }
        self.close(deal_id, deal, DealState::Refunded, U256::zero());
    }

    /// Hands the deal to the arbiter. Only the buyer or the seller may call it, before the
    /// deadline.
    pub fn open_dispute(&mut self, deal_id: u64) {
        let mut deal = self.open_deal(deal_id);
        let caller = self.env().caller();
        if caller != deal.buyer && caller != deal.seller {
            self.env().revert(Error::NotParty);
        }
        if deal.state == DealState::Disputed {
            self.env().revert(Error::AlreadyDisputed);
        }
        if self.env().get_block_time() >= deal.deadline {
            self.env().revert(Error::DeadlinePassed);
        }
        deal.state = DealState::Disputed;
        self.deals.set(&deal_id, deal);
        self.env().emit_event(DisputeOpened {
            deal_id,
            by: caller,
        });
    }

    /// Decides a dispute: `seller_share` of the deposit goes to the seller, the rest to the
    /// buyer. Zero decides for the buyer, the whole amount for the seller. Only the arbiter may
    /// call it, and only while a dispute is open.
    pub fn resolve(&mut self, deal_id: u64, seller_share: U256) {
        let deal = self.open_deal(deal_id);
        if self.env().caller() != deal.arbiter {
            self.env().revert(Error::NotArbiter);
        }
        if deal.state != DealState::Disputed {
            self.env().revert(Error::NotDisputed);
        }
        if seller_share > deal.amount {
            self.env().revert(Error::ShareTooLarge);
        }
        self.close(deal_id, deal, DealState::Resolved, seller_share);
    }

    /// Gives the deposit back to the buyer once the deadline has passed with no dispute open.
    /// Only the buyer may call it.
    pub fn reclaim(&mut self, deal_id: u64) {
        let deal = self.open_deal(deal_id);
        if self.env().caller() != deal.buyer {
            self.env().revert(Error::NotBuyer);
        }
        if deal.state == DealState::Disputed {
            self.env().revert(Error::DisputeOpen);
        }
        if self.env().get_block_time() < deal.deadline {
            self.env().revert(Error::DeadlineNotReached);
        }
        self.close(deal_id, deal, DealState::Reclaimed, U256::zero());
    }

    /// Returns the deal with the given id.
    pub fn deal(&self, deal_id: u64) -> Deal {
        self.get_deal(deal_id)
    }

    /// Returns the number of deals created. Ids run from `0` to `count - 1`.
    pub fn deals_count(&self) -> u64 {
        self.count.get_or_default()
    }

    /// Returns the ids of the deals of `account` as the buyer.
    pub fn deals_of_buyer(&self, account: Address) -> Vec<u64> {
        self.by_buyer.get_or_default(&account)
    }

    /// Returns the ids of the deals of `account` as the seller.
    pub fn deals_of_seller(&self, account: Address) -> Vec<u64> {
        self.by_seller.get_or_default(&account)
    }

    /// Returns the ids of the deals of `account` as the arbiter.
    pub fn deals_of_arbiter(&self, account: Address) -> Vec<u64> {
        self.by_arbiter.get_or_default(&account)
    }
}

impl Escrow {
    fn get_deal(&self, deal_id: u64) -> Deal {
        self.deals
            .get(&deal_id)
            .unwrap_or_revert_with(self, Error::DealNotFound)
    }

    /// The deal, if its deposit is still in the contract.
    fn open_deal(&self, deal_id: u64) -> Deal {
        let deal = self.get_deal(deal_id);
        if !matches!(deal.state, DealState::Funded | DealState::Disputed) {
            self.env().revert(Error::DealClosed);
        }
        deal
    }

    /// Closes the deal: `to_seller` goes to the seller, the rest of the deposit to the buyer.
    fn close(&mut self, deal_id: u64, mut deal: Deal, state: DealState, to_seller: U256) {
        let to_buyer = deal.amount - to_seller;
        deal.state = state;
        deal.seller_share = to_seller;
        self.deals.set(&deal_id, deal.clone());

        let mut token = Cep18ContractRef::new(self.env(), deal.token);
        if !to_seller.is_zero() {
            token.transfer(&deal.seller, &to_seller);
        }
        if !to_buyer.is_zero() {
            token.transfer(&deal.buyer, &to_buyer);
        }

        self.env().emit_event(DealClosed {
            deal_id,
            state,
            to_seller,
            to_buyer,
        });
    }
}

fn push_id(index: &mut Mapping<Address, Vec<u64>>, account: &Address, deal_id: u64) {
    let mut ids = index.get_or_default(account);
    ids.push(deal_id);
    index.set(account, ids);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::token::{TestToken, TestTokenHostRef};
    use odra::host::{Deployer, HostEnv, NoArgs};
    use odra_modules::cep18::errors::Error as Cep18Error;

    const DAY: u64 = 24 * 60 * 60 * 1000;
    const AMOUNT: u64 = 1000;

    struct Setup {
        env: HostEnv,
        token: TestTokenHostRef,
        escrow: EscrowHostRef,
        buyer: Address,
        seller: Address,
        arbiter: Address,
        stranger: Address,
    }

    /// Deploys both contracts and gives the buyer tokens and an allowance for all of them.
    fn setup() -> Setup {
        let env = odra_test::env();
        let buyer = env.get_account(1);
        let seller = env.get_account(2);
        let arbiter = env.get_account(3);
        let stranger = env.get_account(4);
        let mut token = TestToken::deploy(&env, NoArgs);
        let escrow = Escrow::deploy(&env, NoArgs);

        env.set_caller(buyer);
        token.faucet();
        token.approve(&escrow.address(), &TestToken::faucet_amount());

        Setup {
            env,
            token,
            escrow,
            buyer,
            seller,
            arbiter,
            stranger,
        }
    }

    /// Opens a deal of 1000 units with a deadline in 10 days.
    fn create(s: &mut Setup) -> u64 {
        let id = s.escrow.deals_count();
        let deadline = s.env.block_time() + 10 * DAY;
        s.env.set_caller(s.buyer);
        s.escrow.create_deal(
            s.seller,
            s.arbiter,
            s.token.address(),
            U256::from(AMOUNT),
            deadline,
        );
        id
    }

    fn balances(s: &Setup) -> (U256, U256, U256) {
        (
            s.token.balance_of(&s.buyer),
            s.token.balance_of(&s.seller),
            s.token.balance_of(&s.escrow.address()),
        )
    }

    fn start() -> U256 {
        TestToken::faucet_amount()
    }

    #[test]
    fn creating_a_deal_pulls_the_deposit() {
        let mut s = setup();
        let deadline = s.env.block_time() + 10 * DAY;
        let id = create(&mut s);

        assert_eq!(id, 0);
        assert_eq!(s.escrow.deals_count(), 1);
        assert_eq!(
            balances(&s),
            (start() - AMOUNT, U256::zero(), U256::from(AMOUNT))
        );
        assert_eq!(
            s.escrow.deal(id),
            Deal {
                buyer: s.buyer,
                seller: s.seller,
                arbiter: s.arbiter,
                token: s.token.address(),
                amount: U256::from(AMOUNT),
                deadline,
                state: DealState::Funded,
                seller_share: U256::zero(),
            }
        );
        assert_eq!(s.escrow.deals_of_buyer(s.buyer), vec![0]);
        assert_eq!(s.escrow.deals_of_seller(s.seller), vec![0]);
        assert_eq!(s.escrow.deals_of_arbiter(s.arbiter), vec![0]);
        assert!(s.escrow.deals_of_buyer(s.seller).is_empty());
        assert!(s.env.emitted_event(
            &s.escrow,
            DealCreated {
                deal_id: 0,
                buyer: s.buyer,
                seller: s.seller,
                arbiter: s.arbiter,
                token: s.token.address(),
                amount: U256::from(AMOUNT),
                deadline,
            }
        ));
    }

    #[test]
    fn deals_get_consecutive_ids() {
        let mut s = setup();
        assert_eq!(create(&mut s), 0);
        assert_eq!(create(&mut s), 1);
        assert_eq!(s.escrow.deals_count(), 2);
        assert_eq!(s.escrow.deals_of_buyer(s.buyer), vec![0, 1]);
        assert_eq!(s.escrow.deals_of_seller(s.seller), vec![0, 1]);
        assert_eq!(s.escrow.deals_of_arbiter(s.arbiter), vec![0, 1]);
    }

    #[test]
    fn release_pays_the_seller() {
        let mut s = setup();
        let id = create(&mut s);
        s.escrow.release(id);

        assert_eq!(
            balances(&s),
            (start() - AMOUNT, U256::from(AMOUNT), U256::zero())
        );
        let deal = s.escrow.deal(id);
        assert_eq!(deal.state, DealState::Released);
        assert_eq!(deal.seller_share, U256::from(AMOUNT));
        assert!(s.env.emitted_event(
            &s.escrow,
            DealClosed {
                deal_id: id,
                state: DealState::Released,
                to_seller: U256::from(AMOUNT),
                to_buyer: U256::zero(),
            }
        ));
    }

    #[test]
    fn refund_pays_the_buyer_back() {
        let mut s = setup();
        let id = create(&mut s);
        s.env.set_caller(s.seller);
        s.escrow.refund(id);

        assert_eq!(balances(&s), (start(), U256::zero(), U256::zero()));
        assert_eq!(s.escrow.deal(id).state, DealState::Refunded);
        assert!(s.env.emitted_event(
            &s.escrow,
            DealClosed {
                deal_id: id,
                state: DealState::Refunded,
                to_seller: U256::zero(),
                to_buyer: U256::from(AMOUNT),
            }
        ));
    }

    #[test]
    fn release_and_refund_are_guarded() {
        let mut s = setup();
        let id = create(&mut s);

        for who in [s.seller, s.arbiter, s.stranger] {
            s.env.set_caller(who);
            assert_eq!(s.escrow.try_release(id), Err(Error::NotBuyer.into()));
        }
        for who in [s.buyer, s.arbiter, s.stranger] {
            s.env.set_caller(who);
            assert_eq!(s.escrow.try_refund(id), Err(Error::NotSeller.into()));
        }
    }

    #[test]
    fn either_party_opens_a_dispute_and_the_arbiter_splits_the_deposit() {
        let mut s = setup();
        let id = create(&mut s);

        s.env.set_caller(s.seller);
        s.escrow.open_dispute(id);
        assert_eq!(s.escrow.deal(id).state, DealState::Disputed);
        assert!(s.env.emitted_event(
            &s.escrow,
            DisputeOpened {
                deal_id: id,
                by: s.seller
            }
        ));

        s.env.set_caller(s.arbiter);
        s.escrow.resolve(id, U256::from(300));
        assert_eq!(balances(&s), (start() - 300, U256::from(300), U256::zero()));
        let deal = s.escrow.deal(id);
        assert_eq!(deal.state, DealState::Resolved);
        assert_eq!(deal.seller_share, U256::from(300));
        assert!(s.env.emitted_event(
            &s.escrow,
            DealClosed {
                deal_id: id,
                state: DealState::Resolved,
                to_seller: U256::from(300),
                to_buyer: U256::from(700),
            }
        ));

        let second = create(&mut s);
        s.escrow.open_dispute(second);
        assert!(s.env.emitted_event(
            &s.escrow,
            DisputeOpened {
                deal_id: second,
                by: s.buyer
            }
        ));
    }

    #[test]
    fn the_arbiter_decides_for_either_side() {
        let mut s = setup();
        let for_buyer = create(&mut s);
        let for_seller = create(&mut s);
        s.escrow.open_dispute(for_buyer);
        s.escrow.open_dispute(for_seller);

        s.env.set_caller(s.arbiter);
        s.escrow.resolve(for_buyer, U256::zero());
        s.escrow.resolve(for_seller, U256::from(AMOUNT));
        assert_eq!(
            balances(&s),
            (start() - AMOUNT, U256::from(AMOUNT), U256::zero())
        );
    }

    #[test]
    fn resolve_is_guarded() {
        let mut s = setup();
        let id = create(&mut s);

        s.env.set_caller(s.arbiter);
        assert_eq!(
            s.escrow.try_resolve(id, U256::zero()),
            Err(Error::NotDisputed.into())
        );

        s.env.set_caller(s.buyer);
        s.escrow.open_dispute(id);
        for who in [s.buyer, s.seller, s.stranger] {
            s.env.set_caller(who);
            assert_eq!(
                s.escrow.try_resolve(id, U256::zero()),
                Err(Error::NotArbiter.into())
            );
        }
        s.env.set_caller(s.arbiter);
        assert_eq!(
            s.escrow.try_resolve(id, U256::from(AMOUNT + 1)),
            Err(Error::ShareTooLarge.into())
        );
    }

    #[test]
    fn open_dispute_is_guarded() {
        let mut s = setup();
        let id = create(&mut s);

        for who in [s.arbiter, s.stranger] {
            s.env.set_caller(who);
            assert_eq!(s.escrow.try_open_dispute(id), Err(Error::NotParty.into()));
        }
        s.env.set_caller(s.buyer);
        s.escrow.open_dispute(id);
        s.env.set_caller(s.seller);
        assert_eq!(
            s.escrow.try_open_dispute(id),
            Err(Error::AlreadyDisputed.into())
        );

        let late = create(&mut s);
        s.env.advance_block_time(10 * DAY);
        assert_eq!(
            s.escrow.try_open_dispute(late),
            Err(Error::DeadlinePassed.into())
        );
    }

    #[test]
    fn a_party_may_give_in_during_a_dispute() {
        let mut s = setup();
        let released = create(&mut s);
        let refunded = create(&mut s);
        s.escrow.open_dispute(released);
        s.escrow.open_dispute(refunded);

        s.escrow.release(released);
        s.env.set_caller(s.seller);
        s.escrow.refund(refunded);
        assert_eq!(
            balances(&s),
            (start() - AMOUNT, U256::from(AMOUNT), U256::zero())
        );
        assert_eq!(s.escrow.deal(released).state, DealState::Released);
        assert_eq!(s.escrow.deal(refunded).state, DealState::Refunded);
    }

    #[test]
    fn the_buyer_takes_back_an_undisputed_deposit_after_the_deadline() {
        let mut s = setup();
        let id = create(&mut s);

        s.env.advance_block_time(10 * DAY - 1);
        assert_eq!(
            s.escrow.try_reclaim(id),
            Err(Error::DeadlineNotReached.into())
        );
        s.env.advance_block_time(1);
        s.env.set_caller(s.seller);
        assert_eq!(s.escrow.try_reclaim(id), Err(Error::NotBuyer.into()));
        s.env.set_caller(s.buyer);
        s.escrow.reclaim(id);

        assert_eq!(balances(&s), (start(), U256::zero(), U256::zero()));
        assert_eq!(s.escrow.deal(id).state, DealState::Reclaimed);
        assert!(s.env.emitted_event(
            &s.escrow,
            DealClosed {
                deal_id: id,
                state: DealState::Reclaimed,
                to_seller: U256::zero(),
                to_buyer: U256::from(AMOUNT),
            }
        ));
    }

    #[test]
    fn a_dispute_holds_the_deposit_past_the_deadline() {
        let mut s = setup();
        let id = create(&mut s);
        s.escrow.open_dispute(id);

        s.env.advance_block_time(100 * DAY);
        assert_eq!(s.escrow.try_reclaim(id), Err(Error::DisputeOpen.into()));
        s.env.set_caller(s.arbiter);
        s.escrow.resolve(id, U256::from(AMOUNT));
        assert_eq!(s.token.balance_of(&s.seller), U256::from(AMOUNT));
    }

    #[test]
    fn a_closed_deal_cannot_be_settled_again() {
        let mut s = setup();
        let id = create(&mut s);
        s.escrow.release(id);

        assert_eq!(s.escrow.try_release(id), Err(Error::DealClosed.into()));
        assert_eq!(s.escrow.try_open_dispute(id), Err(Error::DealClosed.into()));
        s.env.advance_block_time(10 * DAY);
        assert_eq!(s.escrow.try_reclaim(id), Err(Error::DealClosed.into()));
        s.env.set_caller(s.seller);
        assert_eq!(s.escrow.try_refund(id), Err(Error::DealClosed.into()));
        s.env.set_caller(s.arbiter);
        assert_eq!(
            s.escrow.try_resolve(id, U256::zero()),
            Err(Error::DealClosed.into())
        );
    }

    #[test]
    fn one_account_may_hold_every_role() {
        let mut s = setup();
        let me = s.buyer;
        let deadline = s.env.block_time() + DAY;
        s.env.set_caller(me);
        let token = s.token.address();
        s.escrow
            .create_deal(me, me, token, U256::from(AMOUNT), deadline);
        s.escrow
            .create_deal(me, me, token, U256::from(AMOUNT), deadline);

        s.escrow.release(0);
        s.escrow.open_dispute(1);
        s.escrow.resolve(1, U256::from(400));

        assert_eq!(s.token.balance_of(&me), start());
        assert_eq!(s.token.balance_of(&s.escrow.address()), U256::zero());
        assert_eq!(s.escrow.deals_of_buyer(me), vec![0, 1]);
        assert_eq!(s.escrow.deals_of_seller(me), vec![0, 1]);
        assert_eq!(s.escrow.deals_of_arbiter(me), vec![0, 1]);
    }

    /// The sequence of `scenario demo` in `bin/cli.rs`, with one account in every role. Run it on
    /// CasperVM to measure the gas of each call:
    /// `cargo odra test -b casper -- demo_scenario --nocapture`.
    #[test]
    fn demo_scenario() {
        let env = odra_test::env();
        let me = env.get_account(0);
        let mut token = TestToken::deploy(&env, NoArgs);
        let mut escrow = Escrow::deploy(&env, NoArgs);
        let amount = U256::from(100_000_000_000u64);
        let deadline = env.block_time() + DAY;
        env.set_caller(me);

        token.faucet();
        token.approve(&escrow.address(), &(amount * 2));
        let start = token.balance_of(&me);

        escrow.create_deal(me, me, token.address(), amount, deadline);
        escrow.release(0);
        escrow.create_deal(me, me, token.address(), amount, deadline);
        escrow.open_dispute(1);
        escrow.resolve(1, amount / 2);

        assert_eq!(token.balance_of(&me), start);
        assert_eq!(escrow.deal(0).state, DealState::Released);
        assert_eq!(escrow.deal(1).state, DealState::Resolved);
        assert_eq!(escrow.deal(1).seller_share, amount / 2);

        // The calls the demo does not make, for the limits of the web app.
        token.approve(&escrow.address(), &(amount * 2));
        escrow.create_deal(me, me, token.address(), amount, deadline);
        escrow.refund(2);
        escrow.create_deal(me, me, token.address(), amount, deadline);
        env.advance_block_time(DAY);
        escrow.reclaim(3);
        assert_eq!(token.balance_of(&me), start);

        println!("{}", env.gas_report());
    }

    #[test]
    fn invalid_deals_are_rejected() {
        let s = setup();
        let mut escrow = s.escrow;
        let token = s.token.address();
        let now = s.env.block_time();
        s.env.set_caller(s.buyer);

        let mut try_create = |amount: U256, deadline: u64| {
            escrow.try_create_deal(s.seller, s.arbiter, token, amount, deadline)
        };

        assert_eq!(
            try_create(U256::zero(), now + DAY),
            Err(Error::ZeroAmount.into())
        );
        assert_eq!(
            try_create(U256::one(), now),
            Err(Error::DeadlineNotInFuture.into())
        );
        assert_eq!(
            try_create(start() + 1, now + DAY),
            Err(Cep18Error::InsufficientAllowance.into())
        );
    }

    #[test]
    fn unknown_deals_are_reported() {
        let mut s = setup();
        assert_eq!(s.escrow.try_deal(7), Err(Error::DealNotFound.into()));
        assert_eq!(s.escrow.try_release(7), Err(Error::DealNotFound.into()));
        assert_eq!(s.escrow.try_refund(7), Err(Error::DealNotFound.into()));
        assert_eq!(
            s.escrow.try_open_dispute(7),
            Err(Error::DealNotFound.into())
        );
        assert_eq!(
            s.escrow.try_resolve(7, U256::zero()),
            Err(Error::DealNotFound.into())
        );
        assert_eq!(s.escrow.try_reclaim(7), Err(Error::DealNotFound.into()));
    }
}
