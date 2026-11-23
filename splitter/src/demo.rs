//! The demo scenario, as a sequence of calls a host runs: the command line tool runs it on a
//! network, and a test runs the same sequence on CasperVM before it touches one.

use crate::splitter::SplitterHostRef;
use crate::token::TestTokenHostRef;
use odra::casper_types::U256;
use odra::host::HostRef;
use odra::prelude::*;

const CSPR: u64 = 1_000_000_000;

/// Gas limits of the deploy and the calls of the demo, in motes: what each used on CasperVM
/// (`the_demo_runs_and_reports_its_gas` in `src/splitter.rs` prints it, on the wasm files
/// `cargo odra build` writes) and a margin. The network refunds three quarters of what a
/// transaction leaves unused, and lane limits make 2.5 CSPR the practical minimum of a call.
pub mod gas {
    use super::CSPR;
    /// Deploying `Splitter`: 311.6 CSPR used, and 10% more.
    pub const DEPLOY: u64 = 343 * CSPR;
    /// 0.30 CSPR used.
    pub const FAUCET: u64 = 2_500_000_000;
    /// 0.36 CSPR used.
    pub const APPROVE: u64 = 2_500_000_000;
    /// A split of two payees: 1.14 CSPR used.
    pub const CREATE: u64 = 2_500_000_000;
    /// The first payment of a token into a split: 1.58 CSPR used.
    pub const PAY: u64 = 3 * CSPR;
    /// 1.35 CSPR used.
    pub const WITHDRAW: u64 = 2_500_000_000;
}

/// An account nobody holds the key of: the other payee of the demo split by default.
pub fn made_up_payee() -> Address {
    "account-hash-5917ad005917ad005917ad005917ad005917ad005917ad005917ad005917ad00"
        .parse()
        .expect("a valid account hash")
}

/// What the demo did.
pub struct Outcome {
    /// The id of the split it created.
    pub split_id: u64,
    /// What the caller withdrew.
    pub withdrawn: U256,
    /// What waits in the split for the other payee.
    pub left_for_other: U256,
}

/// Takes test tokens from the faucet, creates a split of three shares for the caller and one for
/// `other`, pays `amount` into it and withdraws the caller's part.
pub fn run(
    token: &mut TestTokenHostRef,
    splitter: &mut SplitterHostRef,
    other: Address,
    amount: U256,
) -> OdraResult<Outcome> {
    let env = token.env().clone();
    let me = env.caller();

    env.set_gas(gas::FAUCET);
    token.try_faucet()?;

    let split_id = splitter.splits_count();
    env.set_gas(gas::CREATE);
    splitter.try_create_split(vec![me, other], vec![3, 1])?;

    env.set_gas(gas::APPROVE);
    token.try_approve(&splitter.address(), &amount)?;
    env.set_gas(gas::PAY);
    splitter.try_pay(split_id, token.address(), amount)?;

    env.set_gas(gas::WITHDRAW);
    splitter.try_withdraw(split_id, token.address())?;

    Ok(Outcome {
        split_id,
        withdrawn: splitter.released(split_id, token.address(), me),
        left_for_other: splitter.withdrawable(split_id, token.address(), other),
    })
}
