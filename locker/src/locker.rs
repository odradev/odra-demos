//! Liquidity locker: CEP-18 tokens held until a set moment, so anyone can check they cannot be
//! taken out before it.

use odra::casper_types::U256;
use odra::prelude::*;
use odra::ContractRef;
use odra_modules::cep18_token::Cep18ContractRef;

/// A lock. All times are block times: milliseconds since the Unix epoch.
#[odra::odra_type]
pub struct Lock {
    /// The account that may extend, hand over and, once unlocked, withdraw the lock.
    pub owner: Address,
    /// The CEP-18 token locked, typically the liquidity-pool token of a DEX pair.
    pub token: Address,
    /// The amount locked.
    pub amount: U256,
    /// The moment the lock was created.
    pub locked_at: u64,
    /// The tokens cannot be withdrawn before this moment.
    pub unlock_time: u64,
    /// Whether the owner has withdrawn the tokens.
    pub withdrawn: bool,
}

/// Errors of the locker.
#[odra::odra_error]
pub enum Error {
    /// The amount to lock is zero.
    ZeroAmount = 1,
    /// The unlock time is not in the future.
    UnlockTimeNotInFuture = 2,
    /// No lock has this id.
    LockNotFound = 3,
    /// Only the owner of the lock may do this.
    NotOwner = 4,
    /// The unlock time has not come yet.
    StillLocked = 5,
    /// The tokens of the lock have been withdrawn already.
    AlreadyWithdrawn = 6,
    /// The new unlock time is not later than the current one.
    NotLater = 7,
    /// The new owner is the owner already.
    AlreadyOwner = 8,
}

/// Tokens were locked.
#[odra::event]
pub struct Locked {
    pub lock_id: u64,
    pub owner: Address,
    pub token: Address,
    pub amount: U256,
    pub unlock_time: u64,
}

/// The owner moved the unlock time of a lock later.
#[odra::event]
pub struct LockExtended {
    pub lock_id: u64,
    pub previous_unlock_time: u64,
    pub unlock_time: u64,
}

/// The owner handed a lock over to another account.
#[odra::event]
pub struct OwnershipTransferred {
    pub lock_id: u64,
    pub previous_owner: Address,
    pub new_owner: Address,
}

/// The owner took the tokens of an expired lock.
#[odra::event]
pub struct Withdrawn {
    pub lock_id: u64,
    pub owner: Address,
    pub token: Address,
    pub amount: U256,
}

/// Holds CEP-18 tokens until their unlock time.
///
/// Anyone can lock any CEP-18 token; the contract has no owner and no fees, and nothing can take
/// tokens out of a lock before its unlock time.
#[odra::module(
    events = [Locked, LockExtended, OwnershipTransferred, Withdrawn],
    errors = Error
)]
pub struct Locker {
    /// Locks by id.
    locks: Mapping<u64, Lock>,
    /// The number of locks created; also the id of the next one.
    count: Var<u64>,
    /// Ids of the locks an account owns now, withdrawn ones included.
    by_owner: Mapping<Address, Vec<u64>>,
    /// Ids of every lock of a token, withdrawn ones included.
    by_token: Mapping<Address, Vec<u64>>,
    /// The amount of a token locked and not withdrawn yet.
    locked: Mapping<Address, U256>,
}

#[odra::module]
impl Locker {
    /// Locks `amount` of `token` until `unlock_time`, pulling it from the caller, who must have
    /// approved this contract for at least that amount. The caller owns the lock. Its id is the
    /// value `locks_count` returned before the call; the `Locked` event carries it.
    pub fn lock(&mut self, token: Address, amount: U256, unlock_time: u64) {
        if amount.is_zero() {
            self.env().revert(Error::ZeroAmount);
        }
        let now = self.env().get_block_time();
        if unlock_time <= now {
            self.env().revert(Error::UnlockTimeNotInFuture);
        }

        let owner = self.env().caller();
        let lock_id = self.count.get_or_default();
        self.count.set(lock_id + 1);
        self.locks.set(
            &lock_id,
            Lock {
                owner,
                token,
                amount,
                locked_at: now,
                unlock_time,
                withdrawn: false,
            },
        );
        push_id(&mut self.by_owner, &owner, lock_id);
        push_id(&mut self.by_token, &token, lock_id);
        self.locked.add(&token, amount);

        Cep18ContractRef::new(self.env(), token).transfer_from(
            &owner,
            &self.env().self_address(),
            &amount,
        );

        self.env().emit_event(Locked {
            lock_id,
            owner,
            token,
            amount,
            unlock_time,
        });
    }

    /// Moves the unlock time of a lock to `new_unlock_time`, which must be later than the
    /// current one. Only the owner may call it, also after the lock has expired.
    pub fn extend(&mut self, lock_id: u64, new_unlock_time: u64) {
        let mut lock = self.owned_lock(lock_id);
        if new_unlock_time <= lock.unlock_time {
            self.env().revert(Error::NotLater);
        }
        let previous_unlock_time = lock.unlock_time;
        lock.unlock_time = new_unlock_time;
        self.locks.set(&lock_id, lock);

        self.env().emit_event(LockExtended {
            lock_id,
            previous_unlock_time,
            unlock_time: new_unlock_time,
        });
    }

    /// Hands a lock over to `new_owner`, who may then extend, hand over and withdraw it. Only the
    /// owner may call it.
    pub fn transfer_ownership(&mut self, lock_id: u64, new_owner: Address) {
        let mut lock = self.owned_lock(lock_id);
        let previous_owner = lock.owner;
        if new_owner == previous_owner {
            self.env().revert(Error::AlreadyOwner);
        }
        lock.owner = new_owner;
        self.locks.set(&lock_id, lock);

        let mut ids = self.by_owner.get_or_default(&previous_owner);
        ids.retain(|id| *id != lock_id);
        self.by_owner.set(&previous_owner, ids);
        push_id(&mut self.by_owner, &new_owner, lock_id);

        self.env().emit_event(OwnershipTransferred {
            lock_id,
            previous_owner,
            new_owner,
        });
    }

    /// Sends the tokens of an expired lock to its owner. Only the owner may call it, at or after
    /// the unlock time.
    pub fn withdraw(&mut self, lock_id: u64) {
        let mut lock = self.owned_lock(lock_id);
        if self.env().get_block_time() < lock.unlock_time {
            self.env().revert(Error::StillLocked);
        }
        lock.withdrawn = true;
        self.locks.set(&lock_id, lock.clone());
        self.locked.subtract(&lock.token, lock.amount);

        Cep18ContractRef::new(self.env(), lock.token).transfer(&lock.owner, &lock.amount);

        self.env().emit_event(Withdrawn {
            lock_id,
            owner: lock.owner,
            token: lock.token,
            amount: lock.amount,
        });
    }

    /// Returns the lock with the given id.
    pub fn get_lock(&self, lock_id: u64) -> Lock {
        self.find_lock(lock_id)
    }

    /// Returns the number of locks created. Ids run from `0` to `count - 1`.
    pub fn locks_count(&self) -> u64 {
        self.count.get_or_default()
    }

    /// Returns the ids of the locks `owner` owns, withdrawn ones included.
    pub fn locks_of(&self, owner: Address) -> Vec<u64> {
        self.by_owner.get_or_default(&owner)
    }

    /// Returns the ids of every lock of `token`, withdrawn ones included.
    pub fn locks_of_token(&self, token: Address) -> Vec<u64> {
        self.by_token.get_or_default(&token)
    }

    /// Returns the amount of `token` locked and not withdrawn yet, expired locks included.
    pub fn locked_amount(&self, token: Address) -> U256 {
        self.locked.get_or_default(&token)
    }
}

impl Locker {
    fn find_lock(&self, lock_id: u64) -> Lock {
        self.locks
            .get(&lock_id)
            .unwrap_or_revert_with(self, Error::LockNotFound)
    }

    /// The lock, if the caller owns it and it has not been withdrawn; reverts otherwise.
    fn owned_lock(&self, lock_id: u64) -> Lock {
        let lock = self.find_lock(lock_id);
        if self.env().caller() != lock.owner {
            self.env().revert(Error::NotOwner);
        }
        if lock.withdrawn {
            self.env().revert(Error::AlreadyWithdrawn);
        }
        lock
    }
}

fn push_id(index: &mut Mapping<Address, Vec<u64>>, account: &Address, lock_id: u64) {
    let mut ids = index.get_or_default(account);
    ids.push(lock_id);
    index.set(account, ids);
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
        locker: LockerHostRef,
        owner: Address,
        other: Address,
    }

    /// Deploys both contracts and gives the owner tokens and an allowance for all of them.
    fn setup() -> Setup {
        let env = odra_test::env();
        let owner = env.get_account(1);
        let other = env.get_account(2);
        let mut token = TestToken::deploy(&env, NoArgs);
        let locker = Locker::deploy(&env, NoArgs);

        env.set_caller(owner);
        token.faucet();
        token.approve(&locker.address(), &TestToken::faucet_amount());

        Setup {
            env,
            token,
            locker,
            owner,
            other,
        }
    }

    /// Locks `amount` units for 30 days as the owner and returns the id.
    fn lock(s: &mut Setup, amount: u64) -> u64 {
        let id = s.locker.locks_count();
        s.env.set_caller(s.owner);
        s.locker.lock(
            s.token.address(),
            U256::from(amount),
            s.env.block_time() + 30 * DAY,
        );
        id
    }

    #[test]
    fn locking_pulls_the_tokens_and_records_the_lock() {
        let mut s = setup();
        let now = s.env.block_time();
        let id = lock(&mut s, 1000);

        assert_eq!(id, 0);
        assert_eq!(s.locker.locks_count(), 1);
        assert_eq!(s.token.balance_of(&s.locker.address()), U256::from(1000));
        assert_eq!(
            s.token.balance_of(&s.owner),
            TestToken::faucet_amount() - 1000
        );
        assert_eq!(
            s.locker.get_lock(id),
            Lock {
                owner: s.owner,
                token: s.token.address(),
                amount: U256::from(1000),
                locked_at: now,
                unlock_time: now + 30 * DAY,
                withdrawn: false
            }
        );
        assert_eq!(s.locker.locks_of(s.owner), vec![0]);
        assert_eq!(s.locker.locks_of_token(s.token.address()), vec![0]);
        assert_eq!(s.locker.locked_amount(s.token.address()), U256::from(1000));
        assert!(s.locker.locks_of(s.other).is_empty());
        assert!(s.env.emitted_event(
            &s.locker,
            Locked {
                lock_id: 0,
                owner: s.owner,
                token: s.token.address(),
                amount: U256::from(1000),
                unlock_time: now + 30 * DAY
            }
        ));
    }

    #[test]
    fn locks_of_one_token_add_up() {
        let mut s = setup();
        assert_eq!(lock(&mut s, 1000), 0);
        assert_eq!(lock(&mut s, 500), 1);

        assert_eq!(s.locker.locks_of_token(s.token.address()), vec![0, 1]);
        assert_eq!(s.locker.locked_amount(s.token.address()), U256::from(1500));
        assert_eq!(s.locker.locks_of(s.owner), vec![0, 1]);
    }

    #[test]
    fn invalid_locks_are_rejected() {
        let mut s = setup();
        let token = s.token.address();
        let now = s.env.block_time();
        s.env.set_caller(s.owner);

        assert_eq!(
            s.locker.try_lock(token, U256::zero(), now + DAY),
            Err(Error::ZeroAmount.into())
        );
        assert_eq!(
            s.locker.try_lock(token, U256::one(), now),
            Err(Error::UnlockTimeNotInFuture.into())
        );
        assert_eq!(
            s.locker
                .try_lock(token, TestToken::faucet_amount() + 1, now + DAY),
            Err(Cep18Error::InsufficientAllowance.into())
        );
        assert_eq!(s.locker.locks_count(), 0);
    }

    #[test]
    fn nothing_can_be_withdrawn_before_the_unlock_time() {
        let mut s = setup();
        let id = lock(&mut s, 1000);

        s.env.advance_block_time(30 * DAY - 1);
        assert_eq!(s.locker.try_withdraw(id), Err(Error::StillLocked.into()));
        assert_eq!(s.token.balance_of(&s.locker.address()), U256::from(1000));
    }

    #[test]
    fn the_owner_withdraws_after_the_unlock_time() {
        let mut s = setup();
        let id = lock(&mut s, 1000);

        s.env.advance_block_time(30 * DAY);
        s.locker.withdraw(id);

        assert_eq!(s.token.balance_of(&s.owner), TestToken::faucet_amount());
        assert_eq!(s.token.balance_of(&s.locker.address()), U256::zero());
        assert_eq!(s.locker.locked_amount(s.token.address()), U256::zero());
        assert!(s.locker.get_lock(id).withdrawn);
        // The lock stays listed, so its history can be shown.
        assert_eq!(s.locker.locks_of_token(s.token.address()), vec![id]);
        assert!(s.env.emitted_event(
            &s.locker,
            Withdrawn {
                lock_id: id,
                owner: s.owner,
                token: s.token.address(),
                amount: U256::from(1000)
            }
        ));
        assert_eq!(
            s.locker.try_withdraw(id),
            Err(Error::AlreadyWithdrawn.into())
        );
    }

    #[test]
    fn only_the_owner_withdraws() {
        let mut s = setup();
        let id = lock(&mut s, 1000);

        s.env.advance_block_time(31 * DAY);
        s.env.set_caller(s.other);
        assert_eq!(s.locker.try_withdraw(id), Err(Error::NotOwner.into()));
    }

    #[test]
    fn extend_moves_the_unlock_time_later_only() {
        let mut s = setup();
        let id = lock(&mut s, 1000);
        let unlock = s.locker.get_lock(id).unlock_time;

        assert_eq!(s.locker.try_extend(id, unlock), Err(Error::NotLater.into()));
        assert_eq!(
            s.locker.try_extend(id, unlock - 1),
            Err(Error::NotLater.into())
        );

        s.locker.extend(id, unlock + 10 * DAY);
        assert_eq!(s.locker.get_lock(id).unlock_time, unlock + 10 * DAY);
        assert!(s.env.emitted_event(
            &s.locker,
            LockExtended {
                lock_id: id,
                previous_unlock_time: unlock,
                unlock_time: unlock + 10 * DAY
            }
        ));

        // The old unlock time no longer counts.
        s.env.advance_block_time(30 * DAY);
        assert_eq!(s.locker.try_withdraw(id), Err(Error::StillLocked.into()));
        s.env.advance_block_time(10 * DAY);
        s.locker.withdraw(id);
    }

    #[test]
    fn an_expired_lock_can_be_extended_again() {
        let mut s = setup();
        let id = lock(&mut s, 1000);

        s.env.advance_block_time(40 * DAY);
        let later = s.env.block_time() + DAY;
        s.locker.extend(id, later);
        assert_eq!(s.locker.try_withdraw(id), Err(Error::StillLocked.into()));
    }

    #[test]
    fn extend_is_guarded() {
        let mut s = setup();
        let id = lock(&mut s, 1000);
        let unlock = s.locker.get_lock(id).unlock_time;

        s.env.set_caller(s.other);
        assert_eq!(
            s.locker.try_extend(id, unlock + DAY),
            Err(Error::NotOwner.into())
        );

        s.env.advance_block_time(30 * DAY);
        s.env.set_caller(s.owner);
        s.locker.withdraw(id);
        assert_eq!(
            s.locker.try_extend(id, unlock + DAY),
            Err(Error::AlreadyWithdrawn.into())
        );
    }

    #[test]
    fn a_new_owner_takes_over_the_lock() {
        let mut s = setup();
        let first = lock(&mut s, 1000);
        let second = lock(&mut s, 500);

        s.locker.transfer_ownership(first, s.other);
        assert_eq!(s.locker.get_lock(first).owner, s.other);
        assert_eq!(s.locker.locks_of(s.owner), vec![second]);
        assert_eq!(s.locker.locks_of(s.other), vec![first]);
        assert!(s.env.emitted_event(
            &s.locker,
            OwnershipTransferred {
                lock_id: first,
                previous_owner: s.owner,
                new_owner: s.other
            }
        ));

        // The previous owner has no say any more.
        s.env.advance_block_time(30 * DAY);
        assert_eq!(s.locker.try_withdraw(first), Err(Error::NotOwner.into()));
        assert_eq!(
            s.locker.try_transfer_ownership(first, s.owner),
            Err(Error::NotOwner.into())
        );

        s.env.set_caller(s.other);
        s.locker.withdraw(first);
        assert_eq!(s.token.balance_of(&s.other), U256::from(1000));
        assert_eq!(s.locker.locked_amount(s.token.address()), U256::from(500));
    }

    #[test]
    fn transfer_ownership_is_guarded() {
        let mut s = setup();
        let id = lock(&mut s, 1000);

        assert_eq!(
            s.locker.try_transfer_ownership(id, s.owner),
            Err(Error::AlreadyOwner.into())
        );

        s.env.advance_block_time(30 * DAY);
        s.locker.withdraw(id);
        assert_eq!(
            s.locker.try_transfer_ownership(id, s.other),
            Err(Error::AlreadyWithdrawn.into())
        );
    }

    #[test]
    fn unknown_locks_are_reported() {
        let mut s = setup();
        assert_eq!(s.locker.try_get_lock(7), Err(Error::LockNotFound.into()));
        assert_eq!(s.locker.try_withdraw(7), Err(Error::LockNotFound.into()));
        assert_eq!(s.locker.try_extend(7, 1), Err(Error::LockNotFound.into()));
        assert_eq!(
            s.locker.try_transfer_ownership(7, s.other),
            Err(Error::LockNotFound.into())
        );
    }
}
