// A copy of ../timelock/src/timelock.rs: the Timelock deployed on the testnet, which runs the proposals that pass.
//! Timelock controller: holds admin rights over other contracts and makes every change wait a
//! public delay before it can be executed.

use odra::casper_types::account::AccountHash;
use odra::casper_types::bytesrepr::{Bytes, FromBytes};
use odra::casper_types::RuntimeArgs;
use odra::prelude::*;
use odra::CallDef;

/// The role of the accounts that may propose operations.
pub const PROPOSER: u8 = 1;
/// The role of the accounts that may execute an operation once its delay has passed.
pub const EXECUTOR: u8 = 2;
/// The role of the accounts that may cancel an operation that has not been executed.
pub const CANCELLER: u8 = 3;

/// The longest delay an operation or the minimum delay may have: 30 days, in milliseconds.
/// It keeps a mistaken or hostile change of the minimum delay from locking the timelock for good.
pub const MAX_DELAY: u64 = 30 * 24 * 60 * 60 * 1000;

/// The address that stands for every account when it holds a role: `account-hash-00…00`.
/// Granting it `EXECUTOR` lets anyone execute a ready operation.
pub fn anyone() -> Address {
    Address::Account(AccountHash::new([0u8; 32]))
}

/// An operation: one call of an entry point of a contract, made by the timelock.
/// Times are block times: milliseconds since the Unix epoch.
#[odra::odra_type]
pub struct Operation {
    /// The account that proposed the operation. It may cancel it too.
    pub proposer: Address,
    /// The contract the timelock calls.
    pub target: Address,
    /// The entry point of `target` the timelock calls.
    pub entry_point: String,
    /// The arguments of the call: `RuntimeArgs` in their bytesrepr serialization.
    pub args: Bytes,
    /// When the operation was proposed.
    pub proposed_at: u64,
    /// The operation can be executed from this moment on.
    pub ready_at: u64,
    /// Whether the operation has been executed.
    pub executed: bool,
    /// Whether the operation has been cancelled.
    pub cancelled: bool,
}

/// Errors of the timelock.
#[odra::odra_error]
pub enum Error {
    /// The caller does not hold the role the entry point needs.
    MissingRole = 1,
    /// Only the timelock itself may do this: schedule an operation that calls this entry point.
    NotTimelock = 2,
    /// The delay is shorter than the minimum delay.
    DelayTooShort = 3,
    /// The delay is longer than `MAX_DELAY`.
    DelayTooLong = 4,
    /// The target is an account, not a contract.
    TargetNotContract = 5,
    /// The entry point name is empty.
    EmptyEntryPoint = 6,
    /// The arguments are not serialized `RuntimeArgs`.
    InvalidArgs = 7,
    /// No operation has this id.
    OperationNotFound = 8,
    /// The delay of the operation has not passed yet.
    NotReady = 9,
    /// The operation has been executed already.
    AlreadyExecuted = 10,
    /// The operation has been cancelled.
    AlreadyCancelled = 11,
    /// There is no role with this number.
    UnknownRole = 12,
}

/// An operation was proposed. It can be executed from `ready_at` on.
#[odra::event]
pub struct OperationScheduled {
    pub operation_id: u64,
    pub proposer: Address,
    pub target: Address,
    pub entry_point: String,
    pub args: Bytes,
    pub ready_at: u64,
}

/// An operation was executed: the timelock made its call.
#[odra::event]
pub struct OperationExecuted {
    pub operation_id: u64,
    pub executor: Address,
}

/// An operation was cancelled and can no longer be executed.
#[odra::event]
pub struct OperationCancelled {
    pub operation_id: u64,
    pub canceller: Address,
}

/// The minimum delay changed.
#[odra::event]
pub struct MinDelayChanged {
    pub old_delay: u64,
    pub new_delay: u64,
}

/// An account was given a role.
#[odra::event]
pub struct RoleGranted {
    pub role: u8,
    pub account: Address,
}

/// An account lost a role.
#[odra::event]
pub struct RoleRevoked {
    pub role: u8,
    pub account: Address,
}

/// Holds admin rights over other contracts and calls them only after a public delay.
///
/// Proposers schedule a call of any entry point of any contract, executors make the call once
/// the delay has passed, cancellers (and the proposer of the operation) can stop it before. The
/// minimum delay and the roles change only through operations the timelock schedules on itself.
#[odra::module(
    events = [
        OperationScheduled,
        OperationExecuted,
        OperationCancelled,
        MinDelayChanged,
        RoleGranted,
        RoleRevoked
    ],
    errors = Error
)]
pub struct Timelock {
    /// The shortest delay an operation may have, in milliseconds.
    min_delay: Var<u64>,
    /// Operations by id.
    operations: Mapping<u64, Operation>,
    /// The number of operations proposed; also the id of the next one.
    count: Var<u64>,
    /// Accounts that may propose operations.
    proposers: Mapping<Address, bool>,
    /// Accounts that may execute ready operations.
    executors: Mapping<Address, bool>,
    /// Accounts that may cancel operations.
    cancellers: Mapping<Address, bool>,
}

#[odra::module]
impl Timelock {
    /// Sets the minimum delay (milliseconds) and the first holders of each role. `anyone()`
    /// (`account-hash-00…00`) in a list opens the role to every account.
    pub fn init(
        &mut self,
        min_delay: u64,
        proposers: Vec<Address>,
        executors: Vec<Address>,
        cancellers: Vec<Address>,
    ) {
        if min_delay > MAX_DELAY {
            self.env().revert(Error::DelayTooLong);
        }
        self.min_delay.set(min_delay);
        self.env().emit_event(MinDelayChanged {
            old_delay: 0,
            new_delay: min_delay,
        });
        for (role, accounts) in [
            (PROPOSER, proposers),
            (EXECUTOR, executors),
            (CANCELLER, cancellers),
        ] {
            for account in accounts {
                self.set_role(role, account, true);
            }
        }
    }

    /// Proposes a call of `entry_point` of `target` with `args` (serialized `RuntimeArgs`),
    /// executable `delay` milliseconds from now. `delay` must be at least the minimum delay.
    /// The id of the operation is the value `operations_count` returned before the call; the
    /// `OperationScheduled` event carries it. Needs the proposer role.
    pub fn schedule(&mut self, target: Address, entry_point: String, args: Bytes, delay: u64) {
        let proposer = self.env().caller();
        self.check_role(PROPOSER, &proposer);
        if !target.is_contract() {
            self.env().revert(Error::TargetNotContract);
        }
        if entry_point.is_empty() {
            self.env().revert(Error::EmptyEntryPoint);
        }
        if decode_args(&args).is_none() {
            self.env().revert(Error::InvalidArgs);
        }
        if delay < self.min_delay.get_or_default() {
            self.env().revert(Error::DelayTooShort);
        }
        if delay > MAX_DELAY {
            self.env().revert(Error::DelayTooLong);
        }

        let now = self.env().get_block_time();
        let ready_at = now + delay;
        let operation_id = self.count.get_or_default();
        self.count.set(operation_id + 1);
        self.operations.set(
            &operation_id,
            Operation {
                proposer,
                target,
                entry_point: entry_point.clone(),
                args: args.clone(),
                proposed_at: now,
                ready_at,
                executed: false,
                cancelled: false,
            },
        );

        self.env().emit_event(OperationScheduled {
            operation_id,
            proposer,
            target,
            entry_point,
            args,
            ready_at,
        });
    }

    /// Makes the call of an operation whose delay has passed. Needs the executor role. If the
    /// call fails, the whole transaction fails and the operation stays ready to execute.
    pub fn execute(&mut self, operation_id: u64) {
        let executor = self.env().caller();
        self.check_role(EXECUTOR, &executor);
        let mut operation = self.open_operation(operation_id);
        if self.env().get_block_time() < operation.ready_at {
            self.env().revert(Error::NotReady);
        }

        // Marked before the call, so the call cannot execute the operation a second time.
        operation.executed = true;
        self.operations.set(&operation_id, operation.clone());

        let args = decode_args(&operation.args).unwrap_or_revert_with(self, Error::InvalidArgs);
        let _: AnyValue = self.env().call_contract(
            operation.target,
            CallDef::new(operation.entry_point, true, args),
        );

        self.env().emit_event(OperationExecuted {
            operation_id,
            executor,
        });
    }

    /// Cancels an operation that has not been executed. Needs the canceller role, or the caller
    /// must be the proposer of the operation.
    pub fn cancel(&mut self, operation_id: u64) {
        let canceller = self.env().caller();
        let mut operation = self.open_operation(operation_id);
        if canceller != operation.proposer {
            self.check_role(CANCELLER, &canceller);
        }

        operation.cancelled = true;
        self.operations.set(&operation_id, operation);

        self.env().emit_event(OperationCancelled {
            operation_id,
            canceller,
        });
    }

    /// Changes the minimum delay. Only the timelock itself may call it, through an operation.
    pub fn update_delay(&mut self, new_delay: u64) {
        self.only_self();
        if new_delay > MAX_DELAY {
            self.env().revert(Error::DelayTooLong);
        }
        let old_delay = self.min_delay.get_or_default();
        self.min_delay.set(new_delay);
        self.env().emit_event(MinDelayChanged {
            old_delay,
            new_delay,
        });
    }

    /// Gives `account` a role (1 proposer, 2 executor, 3 canceller). Only the timelock itself
    /// may call it, through an operation.
    pub fn grant_role(&mut self, role: u8, account: Address) {
        self.only_self();
        self.set_role(role, account, true);
    }

    /// Takes a role from `account`. Only the timelock itself may call it, through an operation.
    pub fn revoke_role(&mut self, role: u8, account: Address) {
        self.only_self();
        self.set_role(role, account, false);
    }

    /// Gives up a role the caller holds.
    pub fn renounce_role(&mut self, role: u8) {
        let caller = self.env().caller();
        self.set_role(role, caller, false);
    }

    /// Returns the operation with the given id.
    pub fn operation(&self, operation_id: u64) -> Operation {
        self.get_operation(operation_id)
    }

    /// Returns the number of operations proposed. Ids run from `0` to `count - 1`.
    pub fn operations_count(&self) -> u64 {
        self.count.get_or_default()
    }

    /// Returns the minimum delay, in milliseconds.
    pub fn min_delay(&self) -> u64 {
        self.min_delay.get_or_default()
    }

    /// Returns whether `account` holds `role` itself. A role opened to `anyone()` is reported
    /// for `anyone()` only.
    pub fn has_role(&self, role: u8, account: Address) -> bool {
        self.role_holders(role).get_or_default(&account)
    }
}

impl Timelock {
    fn role_holders(&self, role: u8) -> &Mapping<Address, bool> {
        match role {
            PROPOSER => &self.proposers,
            EXECUTOR => &self.executors,
            CANCELLER => &self.cancellers,
            _ => self.env().revert(Error::UnknownRole),
        }
    }

    fn set_role(&mut self, role: u8, account: Address, granted: bool) {
        let holders = match role {
            PROPOSER => &mut self.proposers,
            EXECUTOR => &mut self.executors,
            CANCELLER => &mut self.cancellers,
            _ => self.env().revert(Error::UnknownRole),
        };
        if holders.get_or_default(&account) == granted {
            return;
        }
        holders.set(&account, granted);
        if granted {
            self.env().emit_event(RoleGranted { role, account });
        } else {
            self.env().emit_event(RoleRevoked { role, account });
        }
    }

    fn check_role(&self, role: u8, account: &Address) {
        let holders = self.role_holders(role);
        if !holders.get_or_default(account) && !holders.get_or_default(&anyone()) {
            self.env().revert(Error::MissingRole);
        }
    }

    fn only_self(&self) {
        if self.env().caller() != self.env().self_address() {
            self.env().revert(Error::NotTimelock);
        }
    }

    fn get_operation(&self, operation_id: u64) -> Operation {
        self.operations
            .get(&operation_id)
            .unwrap_or_revert_with(self, Error::OperationNotFound)
    }

    /// The operation, if it has been neither executed nor cancelled.
    fn open_operation(&self, operation_id: u64) -> Operation {
        let operation = self.get_operation(operation_id);
        if operation.executed {
            self.env().revert(Error::AlreadyExecuted);
        }
        if operation.cancelled {
            self.env().revert(Error::AlreadyCancelled);
        }
        operation
    }
}

/// Reads serialized `RuntimeArgs`; `None` if the bytes are anything else.
fn decode_args(args: &Bytes) -> Option<RuntimeArgs> {
    match RuntimeArgs::from_bytes(args) {
        Ok((decoded, [])) => Some(decoded),
        _ => None,
    }
}

/// Whatever an executed call returns. The timelock does not look at it.
struct AnyValue;

impl FromBytes for AnyValue {
    fn from_bytes(_bytes: &[u8]) -> Result<(Self, &[u8]), odra::casper_types::bytesrepr::Error> {
        Ok((AnyValue, &[]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fee_config::{Error as FeeError, FeeConfig, FeeConfigHostRef, FeeConfigInitArgs};
    use odra::casper_types::bytesrepr::ToBytes;
    use odra::casper_types::runtime_args;
    use odra::host::{Deployer, HostEnv};

    const MINUTE: u64 = 60 * 1000;

    struct Setup {
        env: HostEnv,
        timelock: TimelockHostRef,
        config: FeeConfigHostRef,
        proposer: Address,
        executor: Address,
        canceller: Address,
        stranger: Address,
    }

    /// A timelock with a one minute delay and one holder of each role, owning a fee of 1%.
    fn setup() -> Setup {
        let env = odra_test::env();
        let (proposer, executor, canceller, stranger) = (
            env.get_account(1),
            env.get_account(2),
            env.get_account(3),
            env.get_account(4),
        );
        let timelock = Timelock::deploy(
            &env,
            TimelockInitArgs {
                min_delay: MINUTE,
                proposers: vec![proposer],
                executors: vec![executor],
                cancellers: vec![canceller],
            },
        );
        let config = FeeConfig::deploy(
            &env,
            FeeConfigInitArgs {
                owner: timelock.address(),
                fee_bps: 100,
            },
        );
        Setup {
            env,
            timelock,
            config,
            proposer,
            executor,
            canceller,
            stranger,
        }
    }

    fn args(args: RuntimeArgs) -> Bytes {
        Bytes::from(args.to_bytes().unwrap())
    }

    /// Proposes a fee change as the proposer; returns the id of the operation.
    fn propose_fee(s: &mut Setup, fee_bps: u32, delay: u64) -> u64 {
        let id = s.timelock.operations_count();
        s.env.set_caller(s.proposer);
        s.timelock.schedule(
            s.config.address(),
            "set_fee".to_string(),
            args(runtime_args! { "fee_bps" => fee_bps }),
            delay,
        );
        id
    }

    /// Proposes a call of the timelock's own entry point as the proposer.
    fn propose_on_timelock(s: &mut Setup, entry_point: &str, call_args: RuntimeArgs) -> u64 {
        let id = s.timelock.operations_count();
        s.env.set_caller(s.proposer);
        s.timelock.schedule(
            s.timelock.address(),
            entry_point.to_string(),
            args(call_args),
            MINUTE,
        );
        id
    }

    fn execute(s: &mut Setup, id: u64) {
        s.env.set_caller(s.executor);
        s.timelock.execute(id);
    }

    #[test]
    fn scheduling_stores_the_operation() {
        let mut s = setup();
        let now = s.env.block_time();
        let id = propose_fee(&mut s, 250, 2 * MINUTE);

        assert_eq!(id, 0);
        assert_eq!(s.timelock.operations_count(), 1);
        let fee_args = args(runtime_args! { "fee_bps" => 250u32 });
        assert_eq!(
            s.timelock.operation(id),
            Operation {
                proposer: s.proposer,
                target: s.config.address(),
                entry_point: "set_fee".to_string(),
                args: fee_args.clone(),
                proposed_at: now,
                ready_at: now + 2 * MINUTE,
                executed: false,
                cancelled: false
            }
        );
        assert!(s.env.emitted_event(
            &s.timelock,
            OperationScheduled {
                operation_id: 0,
                proposer: s.proposer,
                target: s.config.address(),
                entry_point: "set_fee".to_string(),
                args: fee_args,
                ready_at: now + 2 * MINUTE
            }
        ));
        assert_eq!(propose_fee(&mut s, 300, MINUTE), 1);
    }

    #[test]
    fn an_operation_runs_only_after_its_delay() {
        let mut s = setup();
        let id = propose_fee(&mut s, 250, MINUTE);

        s.env.advance_block_time(MINUTE - 1);
        s.env.set_caller(s.executor);
        assert_eq!(s.timelock.try_execute(id), Err(Error::NotReady.into()));
        assert_eq!(s.config.fee_bps(), 100);

        s.env.advance_block_time(1);
        execute(&mut s, id);
        assert_eq!(s.config.fee_bps(), 250);
        assert!(s.timelock.operation(id).executed);
        assert!(s.env.emitted_event(
            &s.timelock,
            OperationExecuted {
                operation_id: id,
                executor: s.executor
            }
        ));
        assert_eq!(
            s.timelock.try_execute(id),
            Err(Error::AlreadyExecuted.into())
        );
    }

    #[test]
    fn the_target_cannot_be_changed_around_the_timelock() {
        let s = setup();
        let mut config = s.config;
        s.env.set_caller(s.proposer);
        assert_eq!(config.try_set_fee(5000), Err(FeeError::NotOwner.into()));
    }

    #[test]
    fn roles_are_checked() {
        let mut s = setup();
        let target = s.config.address();
        let fee_args = args(runtime_args! { "fee_bps" => 250u32 });

        s.env.set_caller(s.stranger);
        assert_eq!(
            s.timelock
                .try_schedule(target, "set_fee".to_string(), fee_args, MINUTE),
            Err(Error::MissingRole.into())
        );

        let id = propose_fee(&mut s, 250, MINUTE);
        s.env.advance_block_time(MINUTE);
        // Neither the proposer nor a stranger may execute.
        for caller in [s.proposer, s.stranger] {
            s.env.set_caller(caller);
            assert_eq!(s.timelock.try_execute(id), Err(Error::MissingRole.into()));
        }
        s.env.set_caller(s.stranger);
        assert_eq!(s.timelock.try_cancel(id), Err(Error::MissingRole.into()));
        execute(&mut s, id);
    }

    #[test]
    fn a_role_granted_to_anyone_is_open() {
        let env = odra_test::env();
        let mut timelock = Timelock::deploy(
            &env,
            TimelockInitArgs {
                min_delay: MINUTE,
                proposers: vec![anyone()],
                executors: vec![anyone()],
                cancellers: vec![],
            },
        );
        let config = FeeConfig::deploy(
            &env,
            FeeConfigInitArgs {
                owner: timelock.address(),
                fee_bps: 100,
            },
        );
        env.set_caller(env.get_account(7));
        timelock.schedule(
            config.address(),
            "set_fee".to_string(),
            args(runtime_args! { "fee_bps" => 42u32 }),
            MINUTE,
        );
        env.advance_block_time(MINUTE);
        env.set_caller(env.get_account(8));
        timelock.execute(0);
        assert_eq!(config.fee_bps(), 42);
        assert!(timelock.has_role(PROPOSER, anyone()));
        assert!(!timelock.has_role(PROPOSER, env.get_account(7)));
    }

    #[test]
    fn cancelling_stops_an_operation() {
        let mut s = setup();
        let by_canceller = propose_fee(&mut s, 250, MINUTE);
        let by_proposer = propose_fee(&mut s, 300, MINUTE);

        s.env.set_caller(s.canceller);
        s.timelock.cancel(by_canceller);
        assert!(s.env.emitted_event(
            &s.timelock,
            OperationCancelled {
                operation_id: by_canceller,
                canceller: s.canceller
            }
        ));
        // The proposer may withdraw their own proposal.
        s.env.set_caller(s.proposer);
        s.timelock.cancel(by_proposer);
        assert!(s.timelock.operation(by_proposer).cancelled);

        s.env.advance_block_time(MINUTE);
        s.env.set_caller(s.executor);
        assert_eq!(
            s.timelock.try_execute(by_canceller),
            Err(Error::AlreadyCancelled.into())
        );
        s.env.set_caller(s.canceller);
        assert_eq!(
            s.timelock.try_cancel(by_canceller),
            Err(Error::AlreadyCancelled.into())
        );
        assert_eq!(s.config.fee_bps(), 100);

        let executed = propose_fee(&mut s, 400, MINUTE);
        s.env.advance_block_time(MINUTE);
        execute(&mut s, executed);
        s.env.set_caller(s.canceller);
        assert_eq!(
            s.timelock.try_cancel(executed),
            Err(Error::AlreadyExecuted.into())
        );
    }

    #[test]
    fn invalid_operations_are_rejected() {
        let s = setup();
        let mut timelock = s.timelock;
        let target = s.config.address();
        let fee_args = args(runtime_args! { "fee_bps" => 250u32 });
        s.env.set_caller(s.proposer);
        let mut try_schedule = |target: Address, entry_point: &str, args: Bytes, delay: u64| {
            timelock.try_schedule(target, entry_point.to_string(), args, delay)
        };

        assert_eq!(
            try_schedule(target, "set_fee", fee_args.clone(), MINUTE - 1),
            Err(Error::DelayTooShort.into())
        );
        assert_eq!(
            try_schedule(target, "set_fee", fee_args.clone(), MAX_DELAY + 1),
            Err(Error::DelayTooLong.into())
        );
        assert_eq!(
            try_schedule(s.stranger, "set_fee", fee_args.clone(), MINUTE),
            Err(Error::TargetNotContract.into())
        );
        assert_eq!(
            try_schedule(target, "", fee_args, MINUTE),
            Err(Error::EmptyEntryPoint.into())
        );
        assert_eq!(
            try_schedule(target, "set_fee", Bytes::from(vec![1, 2, 3]), MINUTE),
            Err(Error::InvalidArgs.into())
        );
    }

    #[test]
    fn a_failing_call_leaves_the_operation_ready() {
        let mut s = setup();
        let id = propose_fee(&mut s, 20_000, MINUTE);
        s.env.advance_block_time(MINUTE);

        s.env.set_caller(s.executor);
        assert_eq!(s.timelock.try_execute(id), Err(FeeError::FeeTooHigh.into()));
        let operation = s.timelock.operation(id);
        assert!(!operation.executed && !operation.cancelled);
    }

    #[test]
    fn the_delay_changes_only_through_the_timelock() {
        let mut s = setup();
        for caller in [s.proposer, s.executor, s.canceller] {
            s.env.set_caller(caller);
            assert_eq!(
                s.timelock.try_update_delay(0),
                Err(Error::NotTimelock.into())
            );
        }

        let id = propose_on_timelock(
            &mut s,
            "update_delay",
            runtime_args! { "new_delay" => 5 * MINUTE },
        );
        s.env.advance_block_time(MINUTE);
        execute(&mut s, id);
        assert_eq!(s.timelock.min_delay(), 5 * MINUTE);
        assert!(s.env.emitted_event(
            &s.timelock,
            MinDelayChanged {
                old_delay: MINUTE,
                new_delay: 5 * MINUTE
            }
        ));

        s.env.set_caller(s.proposer);
        let fee_args = args(runtime_args! { "fee_bps" => 250u32 });
        assert_eq!(
            s.timelock
                .try_schedule(s.config.address(), "set_fee".to_string(), fee_args, MINUTE),
            Err(Error::DelayTooShort.into())
        );
    }

    #[test]
    fn roles_change_only_through_the_timelock() {
        let mut s = setup();
        s.env.set_caller(s.proposer);
        assert_eq!(
            s.timelock.try_grant_role(PROPOSER, s.stranger),
            Err(Error::NotTimelock.into())
        );

        let (stranger, executor) = (s.stranger, s.executor);
        let grant = propose_on_timelock(
            &mut s,
            "grant_role",
            runtime_args! { "role" => PROPOSER, "account" => stranger },
        );
        let revoke = propose_on_timelock(
            &mut s,
            "revoke_role",
            runtime_args! { "role" => EXECUTOR, "account" => executor },
        );
        s.env.advance_block_time(MINUTE);
        execute(&mut s, grant);
        assert!(s.timelock.has_role(PROPOSER, s.stranger));
        assert!(s.env.emitted_event(
            &s.timelock,
            RoleGranted {
                role: PROPOSER,
                account: s.stranger
            }
        ));
        execute(&mut s, revoke);
        assert!(!s.timelock.has_role(EXECUTOR, s.executor));
        assert_eq!(s.timelock.try_execute(0), Err(Error::MissingRole.into()));

        // A holder may give up a role on its own.
        s.env.set_caller(s.stranger);
        s.timelock.renounce_role(PROPOSER);
        assert!(!s.timelock.has_role(PROPOSER, s.stranger));
        assert_eq!(
            s.timelock.try_renounce_role(9),
            Err(Error::UnknownRole.into())
        );
    }

    #[test]
    fn arguments_are_serialized_as_the_web_app_writes_them() {
        // web/src/main.ts encodes `RuntimeArgs` by hand: a u32 count, then per argument its
        // name (u32 length, UTF-8), its value (u32 length, bytes) and its CLType tag.
        let hex = |args: RuntimeArgs| {
            args.to_bytes()
                .unwrap()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        };
        assert_eq!(
            hex(runtime_args! { "fee_bps" => 250u32 }),
            "01000000".to_string() + "07000000" + "6665655f627073" + "04000000" + "fa000000" + "04"
        );
        assert_eq!(
            hex(runtime_args! { "new_delay" => 120_000u64 }),
            "01000000".to_string()
                + "09000000"
                + "6e65775f64656c6179"
                + "08000000"
                + "c0d4010000000000"
                + "05"
        );
    }

    #[test]
    fn unknown_operations_are_reported() {
        let mut s = setup();
        assert_eq!(
            s.timelock.try_operation(3),
            Err(Error::OperationNotFound.into())
        );
        s.env.set_caller(s.executor);
        assert_eq!(
            s.timelock.try_execute(3),
            Err(Error::OperationNotFound.into())
        );
        s.env.set_caller(s.canceller);
        assert_eq!(
            s.timelock.try_cancel(3),
            Err(Error::OperationNotFound.into())
        );
    }
}
