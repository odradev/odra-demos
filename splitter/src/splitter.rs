//! Payment splitter: CEP-18 income divided among payees by fixed shares, withdrawn by each payee.

use odra::casper_types::U256;
use odra::prelude::*;
use odra::ContractRef;
use odra_modules::cep18_token::Cep18ContractRef;

/// The most payees a split may have. The arguments of a transaction may take about 2 KB on the
/// testnet: 40 payees with their shares take about 1.7 KB.
pub const MAX_PAYEES: u32 = 40;

/// A payee of a split and their share of everything the split receives.
#[odra::odra_type]
pub struct Payee {
    pub account: Address,
    pub share: u64,
}

/// A split: who receives what part of every payment. Fixed once created.
#[odra::odra_type]
pub struct Split {
    /// The account that created the split. It has no rights over it.
    pub creator: Address,
    /// The sum of the shares of all payees.
    pub total_shares: u64,
    /// The payees in the order they were listed.
    pub payees: Vec<Payee>,
}

/// Errors of the splitter contract.
#[odra::odra_error]
pub enum Error {
    /// The list of payees is empty.
    NoPayees = 1,
    /// The list has more than `MAX_PAYEES` payees.
    TooManyPayees = 2,
    /// There is not exactly one share for every payee.
    LengthMismatch = 3,
    /// One of the shares is zero.
    ZeroShare = 4,
    /// An account is listed twice.
    DuplicatePayee = 5,
    /// The shares add up to more than fits in a `u64`.
    SharesOverflow = 6,
    /// The splitter contract itself is listed as a payee.
    SplitterAsPayee = 7,
    /// No split has this id.
    SplitNotFound = 8,
    /// The amount to pay in is zero.
    ZeroAmount = 9,
    /// The split would receive more of the token than the contract can divide.
    AmountTooLarge = 10,
    /// The caller is not a payee of the split.
    NotPayee = 11,
    /// The caller has nothing to withdraw from the split in this token.
    NothingToWithdraw = 12,
}

/// A split was created.
#[odra::event]
pub struct SplitCreated {
    pub split_id: u64,
    pub creator: Address,
    pub payees: u32,
    pub total_shares: u64,
}

/// Tokens were paid into a split.
#[odra::event]
pub struct PaymentReceived {
    pub split_id: u64,
    pub token: Address,
    pub payer: Address,
    pub amount: U256,
}

/// A payee withdrew their part of what a split received in a token.
#[odra::event]
pub struct PaymentWithdrawn {
    pub split_id: u64,
    pub token: Address,
    pub payee: Address,
    pub amount: U256,
}

/// Divides CEP-18 tokens among the payees of a split by fixed shares.
///
/// One contract holds every split, of every token. Anyone can create a split and anyone can pay
/// into one; each payee withdraws their part. The contract has no owner and no fees.
///
/// Of everything a split has received in a token, a payee is due
/// `received * share / total_shares`, rounded down, less what they withdrew before.
#[odra::module(
    events = [SplitCreated, PaymentReceived, PaymentWithdrawn],
    errors = Error
)]
pub struct Splitter {
    /// Splits by id.
    splits: Mapping<u64, Split>,
    /// The number of splits created; also the id of the next one.
    count: Var<u64>,
    /// Ids of the splits an account created.
    by_creator: Mapping<Address, Vec<u64>>,
    /// Ids of the splits an account is a payee of.
    by_payee: Mapping<Address, Vec<u64>>,
    /// The tokens paid into a split, in the order of their first payment.
    tokens: Mapping<u64, Vec<Address>>,
    /// What a split has received in a token, in total: `(split, token)`.
    received: Mapping<(u64, Address), U256>,
    /// What the payees of a split have withdrawn in a token, together: `(split, token)`.
    paid_out: Mapping<(u64, Address), U256>,
    /// What a payee has withdrawn from a split in a token: `(split, token, payee)`.
    released: Mapping<(u64, Address, Address), U256>,
}

#[odra::module]
impl Splitter {
    /// Creates a split: `payees[i]` receives `shares[i]` parts of every payment. The id of the
    /// split is the value `splits_count` returned before the call; the `SplitCreated` event
    /// carries it.
    ///
    /// At most `MAX_PAYEES` payees, each listed once, each with a share above zero.
    pub fn create_split(&mut self, payees: Vec<Address>, shares: Vec<u64>) {
        if payees.is_empty() {
            self.env().revert(Error::NoPayees);
        }
        if payees.len() > MAX_PAYEES as usize {
            self.env().revert(Error::TooManyPayees);
        }
        if payees.len() != shares.len() {
            self.env().revert(Error::LengthMismatch);
        }
        let this = self.env().self_address();
        let mut total_shares = 0u64;
        let mut list = Vec::with_capacity(payees.len());
        for (index, (account, share)) in payees.iter().zip(&shares).enumerate() {
            if *share == 0 {
                self.env().revert(Error::ZeroShare);
            }
            if *account == this {
                self.env().revert(Error::SplitterAsPayee);
            }
            if payees[..index].contains(account) {
                self.env().revert(Error::DuplicatePayee);
            }
            total_shares = total_shares
                .checked_add(*share)
                .unwrap_or_revert_with(self, Error::SharesOverflow);
            list.push(Payee {
                account: *account,
                share: *share,
            });
        }

        let creator = self.env().caller();
        let split_id = self.count.get_or_default();
        self.count.set(split_id + 1);
        self.splits.set(
            &split_id,
            Split {
                creator,
                total_shares,
                payees: list,
            },
        );
        push_id(&mut self.by_creator, &creator, split_id);
        for account in &payees {
            push_id(&mut self.by_payee, account, split_id);
        }

        self.env().emit_event(SplitCreated {
            split_id,
            creator,
            payees: payees.len() as u32,
            total_shares,
        });
    }

    /// Pays `amount` of the CEP-18 `token` into a split: the contract pulls it from the caller,
    /// who must have approved this contract for at least that amount.
    ///
    /// Only tokens paid in this way count. A plain transfer to the contract does not say which
    /// split it is for, so it belongs to no split and stays in the contract for good.
    pub fn pay(&mut self, split_id: u64, token: Address, amount: U256) {
        let split = self.get_split(split_id);
        if amount.is_zero() {
            self.env().revert(Error::ZeroAmount);
        }
        let key = (split_id, token);
        let received = self.received.get_or_default(&key);
        // A payee's part is `received * share / total_shares`: the product must fit in a U256.
        let after = received
            .checked_add(amount)
            .filter(|after| after.checked_mul(U256::from(split.total_shares)).is_some())
            .unwrap_or_revert_with(self, Error::AmountTooLarge);
        if received.is_zero() {
            // The first payment of this token into the split.
            let mut tokens = self.tokens.get_or_default(&split_id);
            tokens.push(token);
            self.tokens.set(&split_id, tokens);
        }
        self.received.set(&key, after);

        let payer = self.env().caller();
        Cep18ContractRef::new(self.env(), token).transfer_from(
            &payer,
            &self.env().self_address(),
            &amount,
        );

        self.env().emit_event(PaymentReceived {
            split_id,
            token,
            payer,
            amount,
        });
    }

    /// Sends the caller everything they are due from a split in `token` and have not withdrawn.
    pub fn withdraw(&mut self, split_id: u64, token: Address) {
        let split = self.get_split(split_id);
        let payee = self.env().caller();
        let share = share_of(&split, &payee).unwrap_or_revert_with(self, Error::NotPayee);
        let key = (split_id, token, payee);
        let released = self.released.get_or_default(&key);
        let amount = self.due(split_id, &split, share, &token) - released;
        if amount.is_zero() {
            self.env().revert(Error::NothingToWithdraw);
        }

        self.released.set(&key, released + amount);
        let total_key = (split_id, token);
        let paid_out = self.paid_out.get_or_default(&total_key);
        self.paid_out.set(&total_key, paid_out + amount);

        Cep18ContractRef::new(self.env(), token).transfer(&payee, &amount);

        self.env().emit_event(PaymentWithdrawn {
            split_id,
            token,
            payee,
            amount,
        });
    }

    /// Returns the split with the given id.
    pub fn split(&self, split_id: u64) -> Split {
        self.get_split(split_id)
    }

    /// Returns the number of splits created. Ids run from `0` to `count - 1`.
    pub fn splits_count(&self) -> u64 {
        self.count.get_or_default()
    }

    /// Returns the ids of the splits `creator` created.
    pub fn splits_of_creator(&self, creator: Address) -> Vec<u64> {
        self.by_creator.get_or_default(&creator)
    }

    /// Returns the ids of the splits `payee` is a payee of.
    pub fn splits_of_payee(&self, payee: Address) -> Vec<u64> {
        self.by_payee.get_or_default(&payee)
    }

    /// Returns the tokens paid into a split, in the order of their first payment.
    pub fn tokens_of(&self, split_id: u64) -> Vec<Address> {
        self.tokens.get_or_default(&split_id)
    }

    /// Returns what a split has received in `token`, in total.
    pub fn received(&self, split_id: u64, token: Address) -> U256 {
        self.received.get_or_default(&(split_id, token))
    }

    /// Returns what the payees of a split have withdrawn in `token`, together.
    pub fn paid_out(&self, split_id: u64, token: Address) -> U256 {
        self.paid_out.get_or_default(&(split_id, token))
    }

    /// Returns what `payee` has withdrawn from a split in `token`.
    pub fn released(&self, split_id: u64, token: Address, payee: Address) -> U256 {
        self.released.get_or_default(&(split_id, token, payee))
    }

    /// Returns what `withdraw` would send `payee` now; zero for an account that is not a payee.
    pub fn withdrawable(&self, split_id: u64, token: Address, payee: Address) -> U256 {
        let split = self.get_split(split_id);
        match share_of(&split, &payee) {
            Some(share) => {
                self.due(split_id, &split, share, &token) - self.released(split_id, token, payee)
            }
            None => U256::zero(),
        }
    }
}

impl Splitter {
    fn get_split(&self, split_id: u64) -> Split {
        self.splits
            .get(&split_id)
            .unwrap_or_revert_with(self, Error::SplitNotFound)
    }

    /// A payee's part of everything the split has received in `token`, withdrawn or not.
    fn due(&self, split_id: u64, split: &Split, share: u64, token: &Address) -> U256 {
        let received = self.received.get_or_default(&(split_id, *token));
        received * U256::from(share) / U256::from(split.total_shares)
    }
}

fn share_of(split: &Split, account: &Address) -> Option<u64> {
    split
        .payees
        .iter()
        .find(|payee| payee.account == *account)
        .map(|payee| payee.share)
}

fn push_id(index: &mut Mapping<Address, Vec<u64>>, account: &Address, split_id: u64) {
    let mut ids = index.get_or_default(account);
    ids.push(split_id);
    index.set(account, ids);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::token::{TestToken, TestTokenHostRef};
    use odra::casper_types::contracts::ContractPackageHash;
    use odra::host::{Deployer, HostEnv, NoArgs};
    use odra_modules::cep18::errors::Error as Cep18Error;

    struct Setup {
        env: HostEnv,
        token: TestTokenHostRef,
        splitter: SplitterHostRef,
        /// Pays into the splits; has test tokens and an allowance for all of them.
        payer: Address,
        alice: Address,
        bob: Address,
        carol: Address,
    }

    fn setup() -> Setup {
        let env = odra_test::env();
        let payer = env.get_account(1);
        let mut token = TestToken::deploy(&env, NoArgs);
        let splitter = Splitter::deploy(&env, NoArgs);

        env.set_caller(payer);
        token.faucet();
        token.approve(&splitter.address(), &TestToken::faucet_amount());

        Setup {
            alice: env.get_account(2),
            bob: env.get_account(3),
            carol: env.get_account(4),
            env,
            token,
            splitter,
            payer,
        }
    }

    /// Creates a split of alice 50, bob 30, carol 20 as the payer and returns its id.
    fn create(s: &mut Setup) -> u64 {
        let id = s.splitter.splits_count();
        s.env.set_caller(s.payer);
        s.splitter
            .create_split(vec![s.alice, s.bob, s.carol], vec![50, 30, 20]);
        id
    }

    fn pay(s: &mut Setup, id: u64, amount: u64) {
        s.env.set_caller(s.payer);
        s.splitter.pay(id, s.token.address(), U256::from(amount));
    }

    fn withdraw(s: &mut Setup, id: u64, payee: Address) {
        s.env.set_caller(payee);
        s.splitter.withdraw(id, s.token.address());
    }

    #[test]
    fn creating_a_split_stores_it_and_indexes_it() {
        let mut s = setup();
        let id = create(&mut s);

        assert_eq!(id, 0);
        assert_eq!(s.splitter.splits_count(), 1);
        assert_eq!(
            s.splitter.split(id),
            Split {
                creator: s.payer,
                total_shares: 100,
                payees: vec![
                    Payee {
                        account: s.alice,
                        share: 50
                    },
                    Payee {
                        account: s.bob,
                        share: 30
                    },
                    Payee {
                        account: s.carol,
                        share: 20
                    },
                ]
            }
        );
        assert_eq!(s.splitter.splits_of_creator(s.payer), vec![0]);
        assert_eq!(s.splitter.splits_of_payee(s.alice), vec![0]);
        assert_eq!(s.splitter.splits_of_payee(s.carol), vec![0]);
        assert!(s.splitter.splits_of_payee(s.payer).is_empty());
        assert!(s.splitter.tokens_of(id).is_empty());
        assert!(s.env.emitted_event(
            &s.splitter,
            SplitCreated {
                split_id: 0,
                creator: s.payer,
                payees: 3,
                total_shares: 100
            }
        ));
    }

    #[test]
    fn splits_get_consecutive_ids() {
        let mut s = setup();
        assert_eq!(create(&mut s), 0);
        assert_eq!(create(&mut s), 1);
        s.env.set_caller(s.alice);
        s.splitter.create_split(vec![s.alice], vec![1]);
        assert_eq!(s.splitter.splits_count(), 3);
        assert_eq!(s.splitter.splits_of_creator(s.payer), vec![0, 1]);
        assert_eq!(s.splitter.splits_of_creator(s.alice), vec![2]);
        assert_eq!(s.splitter.splits_of_payee(s.alice), vec![0, 1, 2]);
        assert_eq!(s.splitter.splits_of_payee(s.bob), vec![0, 1]);
    }

    #[test]
    fn paying_in_pulls_the_tokens_and_counts_them_for_the_split() {
        let mut s = setup();
        let id = create(&mut s);
        let token = s.token.address();
        pay(&mut s, id, 1000);
        pay(&mut s, id, 500);

        assert_eq!(s.token.balance_of(&s.splitter.address()), U256::from(1500));
        assert_eq!(
            s.token.balance_of(&s.payer),
            TestToken::faucet_amount() - 1500
        );
        assert_eq!(s.splitter.received(id, token), U256::from(1500));
        assert_eq!(s.splitter.paid_out(id, token), U256::zero());
        assert_eq!(s.splitter.tokens_of(id), vec![token]);
        assert_eq!(s.splitter.withdrawable(id, token, s.alice), U256::from(750));
        assert_eq!(s.splitter.withdrawable(id, token, s.bob), U256::from(450));
        assert_eq!(s.splitter.withdrawable(id, token, s.carol), U256::from(300));
        // Not a payee: nothing.
        assert_eq!(s.splitter.withdrawable(id, token, s.payer), U256::zero());
        assert!(s.env.emitted_event(
            &s.splitter,
            PaymentReceived {
                split_id: id,
                token,
                payer: s.payer,
                amount: U256::from(500)
            }
        ));
    }

    #[test]
    fn each_payee_withdraws_their_part() {
        let mut s = setup();
        let id = create(&mut s);
        let token = s.token.address();
        pay(&mut s, id, 1000);

        let (alice, bob, carol) = (s.alice, s.bob, s.carol);
        withdraw(&mut s, id, alice);
        assert_eq!(s.token.balance_of(&s.alice), U256::from(500));
        assert_eq!(s.splitter.released(id, token, s.alice), U256::from(500));
        assert_eq!(s.splitter.paid_out(id, token), U256::from(500));
        assert_eq!(s.splitter.withdrawable(id, token, s.alice), U256::zero());
        assert!(s.env.emitted_event(
            &s.splitter,
            PaymentWithdrawn {
                split_id: id,
                token,
                payee: s.alice,
                amount: U256::from(500)
            }
        ));
        s.env.set_caller(s.alice);
        assert_eq!(
            s.splitter.try_withdraw(id, token),
            Err(Error::NothingToWithdraw.into())
        );

        // More comes in: alice is due only her part of the new income.
        pay(&mut s, id, 2000);
        withdraw(&mut s, id, alice);
        withdraw(&mut s, id, bob);
        withdraw(&mut s, id, carol);
        assert_eq!(s.token.balance_of(&s.alice), U256::from(1500));
        assert_eq!(s.token.balance_of(&s.bob), U256::from(900));
        assert_eq!(s.token.balance_of(&s.carol), U256::from(600));
        assert_eq!(s.splitter.paid_out(id, token), U256::from(3000));
        assert_eq!(s.token.balance_of(&s.splitter.address()), U256::zero());
    }

    #[test]
    fn rounding_leaves_dust_that_later_payments_pick_up() {
        let mut s = setup();
        let token = s.token.address();
        s.env.set_caller(s.payer);
        s.splitter
            .create_split(vec![s.alice, s.bob, s.carol], vec![1, 1, 1]);
        pay(&mut s, 0, 10);
        assert_eq!(s.splitter.withdrawable(0, token, s.alice), U256::from(3));
        for payee in [s.alice, s.bob, s.carol] {
            withdraw(&mut s, 0, payee);
        }
        // 10 = 3 + 3 + 3 and one unit left over.
        assert_eq!(s.token.balance_of(&s.splitter.address()), U256::one());

        // With 2 more, 12 divide evenly: everyone gets one more, nothing is left.
        pay(&mut s, 0, 2);
        for payee in [s.alice, s.bob, s.carol] {
            assert_eq!(s.splitter.withdrawable(0, token, payee), U256::one());
            withdraw(&mut s, 0, payee);
        }
        assert_eq!(s.token.balance_of(&s.splitter.address()), U256::zero());
    }

    #[test]
    fn splits_and_tokens_are_kept_apart() {
        let mut s = setup();
        let first = create(&mut s);
        s.env.set_caller(s.payer);
        s.splitter.create_split(vec![s.alice, s.bob], vec![1, 3]);
        let second = 1;
        let mut other_token = TestToken::deploy(&s.env, NoArgs);
        s.env.set_caller(s.payer);
        other_token.faucet();
        other_token.approve(&s.splitter.address(), &U256::from(400));

        pay(&mut s, first, 1000);
        pay(&mut s, second, 1000);
        s.splitter
            .pay(second, other_token.address(), U256::from(400));

        let token = s.token.address();
        assert_eq!(s.splitter.tokens_of(first), vec![token]);
        assert_eq!(
            s.splitter.tokens_of(second),
            vec![token, other_token.address()]
        );
        assert_eq!(
            s.splitter.withdrawable(second, token, s.alice),
            U256::from(250)
        );
        assert_eq!(
            s.splitter
                .withdrawable(second, other_token.address(), s.bob),
            U256::from(300)
        );

        s.env.set_caller(s.bob);
        s.splitter.withdraw(second, other_token.address());
        assert_eq!(other_token.balance_of(&s.bob), U256::from(300));
        assert_eq!(s.token.balance_of(&s.bob), U256::zero());
        assert_eq!(
            s.splitter.withdrawable(first, token, s.bob),
            U256::from(300)
        );
        assert_eq!(
            s.splitter.withdrawable(second, token, s.bob),
            U256::from(750)
        );
    }

    #[test]
    fn a_plain_transfer_belongs_to_no_split() {
        let mut s = setup();
        let id = create(&mut s);
        s.env.set_caller(s.payer);
        s.token.transfer(&s.splitter.address(), &U256::from(1000));

        assert_eq!(s.splitter.received(id, s.token.address()), U256::zero());
        s.env.set_caller(s.alice);
        assert_eq!(
            s.splitter.try_withdraw(id, s.token.address()),
            Err(Error::NothingToWithdraw.into())
        );
    }

    #[test]
    fn only_payees_withdraw() {
        let mut s = setup();
        let id = create(&mut s);
        pay(&mut s, id, 1000);
        s.env.set_caller(s.payer);
        assert_eq!(
            s.splitter.try_withdraw(id, s.token.address()),
            Err(Error::NotPayee.into())
        );
    }

    #[test]
    fn invalid_splits_are_rejected() {
        let s = setup();
        let mut splitter = s.splitter;
        let (alice, bob) = (s.alice, s.bob);

        assert_eq!(
            splitter.try_create_split(vec![], vec![]),
            Err(Error::NoPayees.into())
        );
        assert_eq!(
            splitter.try_create_split(vec![alice, bob], vec![1]),
            Err(Error::LengthMismatch.into())
        );
        assert_eq!(
            splitter.try_create_split(vec![alice, bob], vec![1, 0]),
            Err(Error::ZeroShare.into())
        );
        assert_eq!(
            splitter.try_create_split(vec![alice, bob, alice], vec![1, 2, 3]),
            Err(Error::DuplicatePayee.into())
        );
        assert_eq!(
            splitter.try_create_split(vec![alice, bob], vec![u64::MAX, 1]),
            Err(Error::SharesOverflow.into())
        );
        assert_eq!(
            splitter.try_create_split(vec![alice, splitter.address()], vec![1, 1]),
            Err(Error::SplitterAsPayee.into())
        );
        assert_eq!(splitter.splits_count(), 0);
    }

    /// `count` addresses that are all different: contract package hashes made up for the test.
    fn made_up(count: usize) -> Vec<Address> {
        (1..=count as u8)
            .map(|i| Address::Contract(ContractPackageHash::new([i; 32])))
            .collect()
    }

    #[test]
    fn a_split_has_at_most_max_payees() {
        let mut s = setup();
        let payees = made_up(MAX_PAYEES as usize + 1);
        let shares = vec![1u64; payees.len()];

        assert_eq!(
            s.splitter.try_create_split(payees.clone(), shares.clone()),
            Err(Error::TooManyPayees.into())
        );
        s.splitter
            .create_split(payees[1..].to_vec(), shares[1..].to_vec());
        assert_eq!(s.splitter.split(0).payees.len(), MAX_PAYEES as usize);
    }

    #[test]
    fn bad_payments_are_rejected() {
        let mut s = setup();
        let id = create(&mut s);
        let token = s.token.address();
        s.env.set_caller(s.payer);

        assert_eq!(
            s.splitter.try_pay(id, token, U256::zero()),
            Err(Error::ZeroAmount.into())
        );
        assert_eq!(
            s.splitter.try_pay(7, token, U256::one()),
            Err(Error::SplitNotFound.into())
        );
        // More than approved.
        assert_eq!(
            s.splitter
                .try_pay(id, token, TestToken::faucet_amount() + 1),
            Err(Cep18Error::InsufficientAllowance.into())
        );
        // `received * total_shares` would not fit in a U256.
        assert_eq!(
            s.splitter.try_pay(id, token, U256::MAX / 100 + 1),
            Err(Error::AmountTooLarge.into())
        );
        // A reverted payment counts for nothing.
        assert_eq!(s.splitter.received(id, token), U256::zero());
        assert!(s.splitter.tokens_of(id).is_empty());
    }

    #[test]
    fn unknown_splits_are_reported() {
        let mut s = setup();
        let token = s.token.address();
        assert_eq!(s.splitter.try_split(3), Err(Error::SplitNotFound.into()));
        assert_eq!(
            s.splitter.try_withdraw(3, token),
            Err(Error::SplitNotFound.into())
        );
        assert_eq!(
            s.splitter.try_withdrawable(3, token, s.alice),
            Err(Error::SplitNotFound.into())
        );
    }

    #[test]
    fn the_demo_runs_and_reports_its_gas() {
        let env = odra_test::env();
        let mut token = TestToken::deploy(&env, NoArgs);
        let mut splitter = Splitter::deploy(&env, NoArgs);
        let other = crate::demo::made_up_payee();
        let amount = U256::from(100_000_000_000u64);

        let outcome = crate::demo::run(&mut token, &mut splitter, other, amount).unwrap();
        assert_eq!(outcome.split_id, 0);
        assert_eq!(outcome.withdrawn, U256::from(75_000_000_000u64));
        assert_eq!(outcome.left_for_other, U256::from(25_000_000_000u64));
        assert_eq!(
            token.balance_of(&env.caller()),
            TestToken::faucet_amount() - amount + outcome.withdrawn
        );

        // A second split, of MAX_PAYEES, paid into and withdrawn from twice: what the page
        // sizes its limits from.
        let mut payees = made_up(MAX_PAYEES as usize - 1);
        payees.push(env.caller());
        let shares = vec![1u64; payees.len()];
        env.set_gas(100 * 1_000_000_000);
        splitter.create_split(payees, shares);
        token.approve(&splitter.address(), &U256::from(2000));
        splitter.pay(1, token.address(), U256::from(1000));
        splitter.pay(1, token.address(), U256::from(1000));
        splitter.withdraw(1, token.address());
        assert_eq!(
            splitter.released(1, token.address(), env.caller()),
            U256::from(50)
        );

        // `cargo test -- --nocapture` shows it; with ODRA_BACKEND=casper it is the gas used.
        println!("{}", env.gas_report());
    }
}
