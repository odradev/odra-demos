//! Token vesting: CEP-18 tokens locked for a beneficiary and released over time.

// `create_schedule` and the constructor `odra::event` generates for `ScheduleCreated` take one
// argument per field of a schedule.
#![allow(clippy::too_many_arguments)]

use odra::casper_types::U256;
use odra::prelude::*;
use odra::ContractRef;
use odra_modules::cep18_token::Cep18ContractRef;

/// A vesting schedule. All times are block times: milliseconds since the Unix epoch.
#[odra::odra_type]
pub struct Schedule {
    /// The account that funded the schedule and may revoke it.
    pub creator: Address,
    /// The account the tokens are released to.
    pub beneficiary: Address,
    /// The CEP-18 token being vested.
    pub token: Address,
    /// The amount the schedule pays out in total. Revoking lowers it to what had vested.
    pub total: U256,
    /// The amount already paid out to the beneficiary.
    pub released: U256,
    /// The moment vesting starts counting.
    pub start: u64,
    /// Nothing is vested before this moment.
    pub cliff: u64,
    /// Everything is vested from this moment on.
    pub end: u64,
    /// Whether the creator may revoke the schedule.
    pub revocable: bool,
    /// Whether the creator has revoked the schedule.
    pub revoked: bool,
}

/// Errors of the vesting contract.
#[odra::odra_error]
pub enum Error {
    /// The amount to vest is zero.
    ZeroAmount = 1,
    /// The times do not satisfy `start <= cliff <= end` and `start < end`.
    InvalidTimes = 2,
    /// The amount is too large to compute a vested share of.
    AmountTooLarge = 3,
    /// No schedule has this id.
    ScheduleNotFound = 4,
    /// There is nothing to release at the moment.
    NothingToRelease = 5,
    /// Only the creator of the schedule may do this.
    NotCreator = 6,
    /// The schedule was created as not revocable.
    NotRevocable = 7,
    /// The schedule has been revoked already.
    AlreadyRevoked = 8,
}

/// A schedule was created and funded.
#[odra::event]
pub struct ScheduleCreated {
    pub schedule_id: u64,
    pub creator: Address,
    pub beneficiary: Address,
    pub token: Address,
    pub amount: U256,
    pub start: u64,
    pub cliff: u64,
    pub end: u64,
    pub revocable: bool,
}

/// Vested tokens were paid out to the beneficiary.
#[odra::event]
pub struct TokensReleased {
    pub schedule_id: u64,
    pub beneficiary: Address,
    pub amount: U256,
}

/// The creator revoked a schedule and took back the unvested tokens.
#[odra::event]
pub struct ScheduleRevoked {
    pub schedule_id: u64,
    pub creator: Address,
    pub refunded: U256,
}

/// Holds CEP-18 tokens and releases them to beneficiaries over time.
///
/// Anyone can create a schedule for any CEP-18 token; the contract has no owner and no fees.
#[odra::module(
    events = [ScheduleCreated, TokensReleased, ScheduleRevoked],
    errors = Error
)]
pub struct Vesting {
    /// Schedules by id.
    schedules: Mapping<u64, Schedule>,
    /// The number of schedules created; also the id of the next one.
    count: Var<u64>,
    /// Ids of the schedules an account is the beneficiary of.
    by_beneficiary: Mapping<Address, Vec<u64>>,
    /// Ids of the schedules an account created.
    by_creator: Mapping<Address, Vec<u64>>,
}

#[odra::module]
impl Vesting {
    /// Creates a schedule and pulls `amount` of `token` from the caller, who must have approved
    /// this contract for at least that amount. The id of the schedule is the value
    /// `schedules_count` returned before the call; the `ScheduleCreated` event carries it.
    ///
    /// Nothing is vested before `cliff`. Between `cliff` and `end` the vested amount grows
    /// linearly, counted from `start`. From `end` on everything is vested. The times are in
    /// milliseconds since the Unix epoch and must satisfy `start <= cliff <= end`, `start < end`.
    pub fn create_schedule(
        &mut self,
        beneficiary: Address,
        token: Address,
        amount: U256,
        start: u64,
        cliff: u64,
        end: u64,
        revocable: bool,
    ) {
        if amount.is_zero() {
            self.env().revert(Error::ZeroAmount);
        }
        if start > cliff || cliff > end || start == end {
            self.env().revert(Error::InvalidTimes);
        }
        // The vested share is `amount * elapsed / duration`: the product must fit in a U256.
        if amount.checked_mul(U256::from(end - start)).is_none() {
            self.env().revert(Error::AmountTooLarge);
        }

        let creator = self.env().caller();
        let schedule_id = self.count.get_or_default();
        self.count.set(schedule_id + 1);
        self.schedules.set(
            &schedule_id,
            Schedule {
                creator,
                beneficiary,
                token,
                total: amount,
                released: U256::zero(),
                start,
                cliff,
                end,
                revocable,
                revoked: false,
            },
        );
        self.push_id(true, &beneficiary, schedule_id);
        self.push_id(false, &creator, schedule_id);

        Cep18ContractRef::new(self.env(), token).transfer_from(
            &creator,
            &self.env().self_address(),
            &amount,
        );

        self.env().emit_event(ScheduleCreated {
            schedule_id,
            creator,
            beneficiary,
            token,
            amount,
            start,
            cliff,
            end,
            revocable,
        });
    }

    /// Pays out everything that has vested and was not paid out yet to the beneficiary.
    /// Anyone may call it; the tokens always go to the beneficiary.
    pub fn release(&mut self, schedule_id: u64) {
        let mut schedule = self.get_schedule(schedule_id);
        let amount = self.vested_of(&schedule) - schedule.released;
        if amount.is_zero() {
            self.env().revert(Error::NothingToRelease);
        }

        schedule.released += amount;
        self.schedules.set(&schedule_id, schedule.clone());

        Cep18ContractRef::new(self.env(), schedule.token).transfer(&schedule.beneficiary, &amount);

        self.env().emit_event(TokensReleased {
            schedule_id,
            beneficiary: schedule.beneficiary,
            amount,
        });
    }

    /// Stops a revocable schedule: the unvested tokens go back to the creator, and what has
    /// vested so far stays for the beneficiary to release. Only the creator may call it.
    pub fn revoke(&mut self, schedule_id: u64) {
        let mut schedule = self.get_schedule(schedule_id);
        if self.env().caller() != schedule.creator {
            self.env().revert(Error::NotCreator);
        }
        if !schedule.revocable {
            self.env().revert(Error::NotRevocable);
        }
        if schedule.revoked {
            self.env().revert(Error::AlreadyRevoked);
        }

        let vested = self.vested_of(&schedule);
        let refunded = schedule.total - vested;
        schedule.total = vested;
        schedule.revoked = true;
        self.schedules.set(&schedule_id, schedule.clone());

        if !refunded.is_zero() {
            Cep18ContractRef::new(self.env(), schedule.token)
                .transfer(&schedule.creator, &refunded);
        }

        self.env().emit_event(ScheduleRevoked {
            schedule_id,
            creator: schedule.creator,
            refunded,
        });
    }

    /// Returns the schedule with the given id.
    pub fn schedule(&self, schedule_id: u64) -> Schedule {
        self.get_schedule(schedule_id)
    }

    /// Returns the amount vested so far, including what was already released.
    pub fn vested(&self, schedule_id: u64) -> U256 {
        self.vested_of(&self.get_schedule(schedule_id))
    }

    /// Returns the amount `release` would pay out now.
    pub fn releasable(&self, schedule_id: u64) -> U256 {
        let schedule = self.get_schedule(schedule_id);
        self.vested_of(&schedule) - schedule.released
    }

    /// Returns the number of schedules created. Ids run from `0` to `count - 1`.
    pub fn schedules_count(&self) -> u64 {
        self.count.get_or_default()
    }

    /// Returns the ids of the schedules `beneficiary` receives tokens from.
    pub fn schedules_of_beneficiary(&self, beneficiary: Address) -> Vec<u64> {
        self.by_beneficiary.get_or_default(&beneficiary)
    }

    /// Returns the ids of the schedules `creator` created.
    pub fn schedules_of_creator(&self, creator: Address) -> Vec<u64> {
        self.by_creator.get_or_default(&creator)
    }
}

impl Vesting {
    fn get_schedule(&self, schedule_id: u64) -> Schedule {
        self.schedules
            .get(&schedule_id)
            .unwrap_or_revert_with(self, Error::ScheduleNotFound)
    }

    /// The amount vested at the current block time.
    fn vested_of(&self, schedule: &Schedule) -> U256 {
        // A revoked schedule stopped at the moment of revoking: `total` is what had vested.
        if schedule.revoked {
            return schedule.total;
        }
        let now = self.env().get_block_time();
        if now < schedule.cliff {
            U256::zero()
        } else if now >= schedule.end {
            schedule.total
        } else {
            schedule.total * U256::from(now - schedule.start)
                / U256::from(schedule.end - schedule.start)
        }
    }

    fn push_id(&mut self, beneficiary: bool, account: &Address, schedule_id: u64) {
        let index = if beneficiary {
            &mut self.by_beneficiary
        } else {
            &mut self.by_creator
        };
        let mut ids = index.get_or_default(account);
        ids.push(schedule_id);
        index.set(account, ids);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::token::{TestToken, TestTokenHostRef};
    use odra::host::{Deployer, HostEnv, NoArgs};
    use odra_modules::cep18::errors::Error as Cep18Error;

    const DAY: u64 = 24 * 60 * 60 * 1000;

    struct Setup {
        env: HostEnv,
        token: TestTokenHostRef,
        vesting: VestingHostRef,
        creator: Address,
        beneficiary: Address,
    }

    /// Deploys both contracts and gives the creator tokens and an allowance for all of them.
    fn setup() -> Setup {
        let env = odra_test::env();
        let creator = env.get_account(1);
        let beneficiary = env.get_account(2);
        let mut token = TestToken::deploy(&env, NoArgs);
        let vesting = Vesting::deploy(&env, NoArgs);

        env.set_caller(creator);
        token.faucet();
        token.approve(&vesting.address(), &TestToken::faucet_amount());

        Setup {
            env,
            token,
            vesting,
            creator,
            beneficiary,
        }
    }

    /// Creates a schedule of 1000 units: starts now, cliff after 10 days, ends after 100 days.
    fn create(s: &mut Setup, revocable: bool) -> u64 {
        let now = s.env.block_time();
        let id = s.vesting.schedules_count();
        s.env.set_caller(s.creator);
        s.vesting.create_schedule(
            s.beneficiary,
            s.token.address(),
            U256::from(1000),
            now,
            now + 10 * DAY,
            now + 100 * DAY,
            revocable,
        );
        id
    }

    #[test]
    fn creating_a_schedule_pulls_the_tokens() {
        let mut s = setup();
        let now = s.env.block_time();
        let id = create(&mut s, true);

        assert_eq!(id, 0);
        assert_eq!(s.vesting.schedules_count(), 1);
        assert_eq!(s.token.balance_of(&s.vesting.address()), U256::from(1000));
        assert_eq!(
            s.token.balance_of(&s.creator),
            TestToken::faucet_amount() - 1000
        );
        assert_eq!(
            s.vesting.schedule(id),
            Schedule {
                creator: s.creator,
                beneficiary: s.beneficiary,
                token: s.token.address(),
                total: U256::from(1000),
                released: U256::zero(),
                start: now,
                cliff: now + 10 * DAY,
                end: now + 100 * DAY,
                revocable: true,
                revoked: false
            }
        );
        assert_eq!(s.vesting.schedules_of_beneficiary(s.beneficiary), vec![0]);
        assert_eq!(s.vesting.schedules_of_creator(s.creator), vec![0]);
        assert!(s.vesting.schedules_of_creator(s.beneficiary).is_empty());
        assert!(s.env.emitted_event(
            &s.vesting,
            ScheduleCreated {
                schedule_id: 0,
                creator: s.creator,
                beneficiary: s.beneficiary,
                token: s.token.address(),
                amount: U256::from(1000),
                start: now,
                cliff: now + 10 * DAY,
                end: now + 100 * DAY,
                revocable: true
            }
        ));
    }

    #[test]
    fn schedules_get_consecutive_ids() {
        let mut s = setup();
        assert_eq!(create(&mut s, true), 0);
        assert_eq!(create(&mut s, false), 1);
        assert_eq!(s.vesting.schedules_count(), 2);
        assert_eq!(
            s.vesting.schedules_of_beneficiary(s.beneficiary),
            vec![0, 1]
        );
    }

    #[test]
    fn nothing_vests_before_the_cliff() {
        let mut s = setup();
        let id = create(&mut s, true);

        s.env.advance_block_time(10 * DAY - 1);

        assert_eq!(s.vesting.vested(id), U256::zero());
        assert_eq!(s.vesting.releasable(id), U256::zero());
        assert_eq!(
            s.vesting.try_release(id),
            Err(Error::NothingToRelease.into())
        );
    }

    #[test]
    fn vesting_is_linear_from_the_start_once_the_cliff_passes() {
        let mut s = setup();
        let id = create(&mut s, true);

        s.env.advance_block_time(10 * DAY);
        assert_eq!(s.vesting.vested(id), U256::from(100));

        s.env.advance_block_time(40 * DAY);
        assert_eq!(s.vesting.vested(id), U256::from(500));

        s.env.advance_block_time(50 * DAY);
        assert_eq!(s.vesting.vested(id), U256::from(1000));

        s.env.advance_block_time(1000 * DAY);
        assert_eq!(s.vesting.vested(id), U256::from(1000));
    }

    #[test]
    fn release_pays_the_beneficiary_what_has_vested() {
        let mut s = setup();
        let id = create(&mut s, true);

        s.env.advance_block_time(25 * DAY);
        // Anyone may trigger the release; the beneficiary gets the tokens.
        s.env.set_caller(s.env.get_account(5));
        s.vesting.release(id);
        assert_eq!(s.token.balance_of(&s.beneficiary), U256::from(250));
        assert_eq!(s.token.balance_of(&s.env.get_account(5)), U256::zero());
        assert_eq!(s.vesting.schedule(id).released, U256::from(250));
        assert_eq!(s.vesting.releasable(id), U256::zero());
        assert!(s.env.emitted_event(
            &s.vesting,
            TokensReleased {
                schedule_id: id,
                beneficiary: s.beneficiary,
                amount: U256::from(250)
            }
        ));
        assert_eq!(
            s.vesting.try_release(id),
            Err(Error::NothingToRelease.into())
        );

        s.env.advance_block_time(75 * DAY);
        s.vesting.release(id);
        assert_eq!(s.token.balance_of(&s.beneficiary), U256::from(1000));
        assert_eq!(s.token.balance_of(&s.vesting.address()), U256::zero());
    }

    #[test]
    fn revoke_refunds_the_unvested_part_and_keeps_the_vested_part() {
        let mut s = setup();
        let id = create(&mut s, true);
        let creator_balance = s.token.balance_of(&s.creator);

        s.env.advance_block_time(40 * DAY);
        s.env.set_caller(s.creator);
        s.vesting.revoke(id);

        assert_eq!(s.token.balance_of(&s.creator), creator_balance + 600);
        assert!(s.env.emitted_event(
            &s.vesting,
            ScheduleRevoked {
                schedule_id: id,
                creator: s.creator,
                refunded: U256::from(600)
            }
        ));
        let schedule = s.vesting.schedule(id);
        assert!(schedule.revoked);
        assert_eq!(schedule.total, U256::from(400));

        // Time passing no longer vests anything.
        s.env.advance_block_time(100 * DAY);
        assert_eq!(s.vesting.vested(id), U256::from(400));
        s.vesting.release(id);
        assert_eq!(s.token.balance_of(&s.beneficiary), U256::from(400));
        assert_eq!(s.token.balance_of(&s.vesting.address()), U256::zero());
    }

    #[test]
    fn revoke_after_a_release_refunds_only_the_unvested_part() {
        let mut s = setup();
        let id = create(&mut s, true);

        s.env.advance_block_time(20 * DAY);
        s.vesting.release(id);
        s.env.advance_block_time(10 * DAY);
        s.env.set_caller(s.creator);

        s.vesting.revoke(id);
        assert_eq!(s.vesting.releasable(id), U256::from(100));
        assert_eq!(s.token.balance_of(&s.vesting.address()), U256::from(100));
    }

    #[test]
    fn revoke_before_the_cliff_refunds_everything() {
        let mut s = setup();
        let id = create(&mut s, true);

        s.env.advance_block_time(5 * DAY);
        s.env.set_caller(s.creator);

        s.vesting.revoke(id);
        assert_eq!(s.token.balance_of(&s.creator), TestToken::faucet_amount());
        assert_eq!(
            s.vesting.try_release(id),
            Err(Error::NothingToRelease.into())
        );
    }

    #[test]
    fn revoke_is_guarded() {
        let mut s = setup();
        let revocable = create(&mut s, true);
        let fixed = create(&mut s, false);

        s.env.set_caller(s.beneficiary);
        assert_eq!(
            s.vesting.try_revoke(revocable),
            Err(Error::NotCreator.into())
        );

        s.env.set_caller(s.creator);
        assert_eq!(s.vesting.try_revoke(fixed), Err(Error::NotRevocable.into()));

        s.vesting.revoke(revocable);
        assert_eq!(
            s.vesting.try_revoke(revocable),
            Err(Error::AlreadyRevoked.into())
        );
    }

    #[test]
    fn invalid_schedules_are_rejected() {
        let s = setup();
        let mut vesting = s.vesting;
        let token = s.token.address();
        s.env.set_caller(s.creator);

        let mut try_create = |amount: U256, start: u64, cliff: u64, end: u64| {
            vesting.try_create_schedule(s.beneficiary, token, amount, start, cliff, end, true)
        };

        assert_eq!(
            try_create(U256::zero(), 0, 10, 100),
            Err(Error::ZeroAmount.into())
        );
        // The cliff is before the start.
        assert_eq!(
            try_create(U256::one(), 10, 5, 100),
            Err(Error::InvalidTimes.into())
        );
        // The cliff is after the end.
        assert_eq!(
            try_create(U256::one(), 0, 101, 100),
            Err(Error::InvalidTimes.into())
        );
        // No duration.
        assert_eq!(
            try_create(U256::one(), 100, 100, 100),
            Err(Error::InvalidTimes.into())
        );
        assert_eq!(
            try_create(U256::MAX, 0, 10, 100),
            Err(Error::AmountTooLarge.into())
        );
        // More than the creator approved.
        assert_eq!(
            try_create(TestToken::faucet_amount() + 1, 0, 10, 100),
            Err(Cep18Error::InsufficientAllowance.into())
        );
    }

    #[test]
    fn a_schedule_may_be_a_plain_timelock() {
        // Cliff equal to the end: nothing until the end, then everything at once.
        let mut s = setup();
        let now = s.env.block_time();
        s.env.set_caller(s.creator);
        let id = s.vesting.schedules_count();
        s.vesting.create_schedule(
            s.beneficiary,
            s.token.address(),
            U256::from(1000),
            now,
            now + 30 * DAY,
            now + 30 * DAY,
            false,
        );

        s.env.advance_block_time(30 * DAY - 1);
        assert_eq!(s.vesting.vested(id), U256::zero());
        s.env.advance_block_time(1);
        s.vesting.release(id);
        assert_eq!(s.token.balance_of(&s.beneficiary), U256::from(1000));
    }

    #[test]
    fn a_schedule_may_start_in_the_past() {
        let mut s = setup();
        s.env.advance_block_time(50 * DAY);
        let now = s.env.block_time();
        s.env.set_caller(s.creator);
        let id = s.vesting.schedules_count();
        s.vesting.create_schedule(
            s.beneficiary,
            s.token.address(),
            U256::from(1000),
            now - 50 * DAY,
            now - 50 * DAY,
            now + 50 * DAY,
            false,
        );

        s.vesting.release(id);
        assert_eq!(s.token.balance_of(&s.beneficiary), U256::from(500));
    }

    #[test]
    fn unknown_schedules_are_reported() {
        let mut s = setup();
        assert_eq!(
            s.vesting.try_schedule(7),
            Err(Error::ScheduleNotFound.into())
        );
        assert_eq!(
            s.vesting.try_release(7),
            Err(Error::ScheduleNotFound.into())
        );
        assert_eq!(s.vesting.try_revoke(7), Err(Error::ScheduleNotFound.into()));
    }
}
