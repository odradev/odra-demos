//! The demo scenario, as a sequence of calls a host runs: the command line tool runs it on a
//! network, and a test runs the same sequence on CasperVM before it touches one.

use crate::swap::OtcSwapHostRef;
use crate::token::{TestDollarHostRef, TestTokenHostRef};
use odra::casper_types::U256;
use odra::host::HostRef;
use odra::prelude::*;

const CSPR: u64 = 1_000_000_000;
/// One whole TEST in its smallest unit: the token has 9 decimals.
pub const TEST: u64 = 1_000_000_000;
/// One whole TUSD in its smallest unit: the token has 6 decimals.
pub const TUSD: u64 = 1_000_000;

/// Gas limits of the deploys and the calls of the demo, in motes: what each used on CasperVM
/// (`the_demo_runs_and_reports_its_gas` in `src/demo.rs` prints it, on the wasm files
/// `cargo odra build` writes) and a margin. The network refunds three quarters of what a
/// transaction leaves unused, and lane limits make 2.5 CSPR the practical minimum of a call.
pub mod gas {
    use super::CSPR;
    /// Deploying `OtcSwap`: 289.6 CSPR used, and 7% more.
    pub const DEPLOY: u64 = 310 * CSPR;
    /// Deploying `TestDollar`: 291.4 CSPR used, and 7% more.
    pub const DEPLOY_TOKEN: u64 = 312 * CSPR;
    /// 0.30 CSPR used.
    pub const FAUCET: u64 = 2_500_000_000;
    /// 0.36 CSPR used.
    pub const APPROVE: u64 = 2_500_000_000;
    /// 2.04 CSPR used for a public offer, 2.14 for one with a named taker; a little more as the
    /// lists of the maker and the taker grow.
    pub const MAKE: u64 = 3 * CSPR;
    /// 2.62 CSPR used when another account takes the offer: two token transfers. 1.64 when the
    /// maker takes its own, with one.
    pub const TAKE: u64 = 3_500_000_000;
    /// 1.28 CSPR used.
    pub const CANCEL: u64 = 2_500_000_000;
}

/// An account nobody holds the key of: the taker of the demo's private offer by default.
pub fn made_up_taker() -> Address {
    "account-hash-5a755a755a755a755a755a755a755a755a755a755a755a755a755a755a755a75"
        .parse()
        .expect("a valid account hash")
}

/// What the demo did.
pub struct Outcome {
    /// The public offer the caller made and took.
    pub taken: u64,
    /// The offer made for another account, then cancelled.
    pub cancelled: u64,
}

/// Offers 100 TEST for 250 TUSD to anyone and takes the offer with the same account; then offers
/// 50 TEST for 120 TUSD to `other` only and cancels it. Takes TEST from the faucet and approves
/// the contract only when the caller lacks them. `expiry` is the expiry of both offers.
///
/// A maker that takes its own offer would pay itself, so the contract moves no TUSD: the caller
/// needs none, and the balances end where they began.
pub fn run(
    test: &mut TestTokenHostRef,
    dollar: &TestDollarHostRef,
    swap: &mut OtcSwapHostRef,
    other: Address,
    expiry: u64,
) -> OdraResult<Outcome> {
    let env = test.env().clone();
    let me = env.caller();
    let swap_address = swap.address();
    let public_give = U256::from(100 * TEST);
    let private_give = U256::from(50 * TEST);
    let test_needed = public_give + private_give;

    if test.balance_of(&me) < test_needed {
        env.set_gas(gas::FAUCET);
        test.try_faucet()?;
    }
    if test.allowance(&me, &swap_address) < test_needed {
        env.set_gas(gas::APPROVE);
        test.try_approve(&swap_address, &test_needed)?;
    }

    // A public offer, taken by the account that made it.
    let taken = swap.offers_count();
    env.set_gas(gas::MAKE);
    swap.try_make_offer(
        test.address(),
        public_give,
        dollar.address(),
        U256::from(250 * TUSD),
        None,
        expiry,
    )?;
    env.set_gas(gas::TAKE);
    swap.try_take(taken)?;

    // An offer only `other` may take, cancelled by the maker: the tokens come back.
    let cancelled = swap.offers_count();
    env.set_gas(gas::MAKE);
    swap.try_make_offer(
        test.address(),
        private_give,
        dollar.address(),
        U256::from(120 * TUSD),
        Some(other),
        expiry,
    )?;
    env.set_gas(gas::CANCEL);
    swap.try_cancel(cancelled)?;

    Ok(Outcome { taken, cancelled })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::swap::{OfferState, OtcSwap};
    use crate::token::{TestDollar, TestToken};
    use odra::host::{Deployer, NoArgs};

    const DAY: u64 = 24 * 60 * 60 * 1000;

    /// Runs the demo as the CLI does and prints the gas of every call. To measure, on the wasm
    /// files `cargo odra build` writes:
    /// `ODRA_BACKEND=casper cargo test --lib the_demo_runs_and_reports_its_gas -- --nocapture`.
    #[test]
    fn the_demo_runs_and_reports_its_gas() {
        let env = odra_test::env();
        let me = env.get_account(0);
        env.set_caller(me);
        let mut test = TestToken::deploy(&env, NoArgs);
        let mut dollar = TestDollar::deploy(&env, NoArgs);
        let mut swap = OtcSwap::deploy(&env, NoArgs);
        let other = made_up_taker();

        let outcome = run(&mut test, &dollar, &mut swap, other, env.block_time() + DAY).unwrap();

        assert_eq!((outcome.taken, outcome.cancelled), (0, 1));
        assert_eq!(swap.offer(0).state, OfferState::Taken);
        assert_eq!(swap.offer(0).taken_by, Some(me));
        assert_eq!(swap.offer(1).state, OfferState::Cancelled);
        assert_eq!(swap.offers_of_taker(other), vec![1]);
        assert!(swap.open_public_offers().is_empty());
        assert_eq!(test.balance_of(&me), TestToken::faucet_amount());
        assert_eq!(dollar.balance_of(&me), U256::zero());
        assert_eq!(test.balance_of(&swap.address()), U256::zero());

        // A second run takes nothing from the faucets: the first one left the balances as they were.
        let again = run(&mut test, &dollar, &mut swap, other, env.block_time() + DAY).unwrap();
        assert_eq!((again.taken, again.cancelled), (2, 3));

        // The calls the demo does not make, for the limits of the web app: another account takes
        // a public offer, paying TUSD with its allowance.
        let taker = env.get_account(1);
        env.set_caller(taker);
        dollar.faucet();
        dollar.approve(&swap.address(), &U256::from(250 * TUSD));
        env.set_caller(me);
        test.approve(&swap.address(), &U256::from(100 * TEST));
        swap.make_offer(
            test.address(),
            U256::from(100 * TEST),
            dollar.address(),
            U256::from(250 * TUSD),
            None,
            env.block_time() + DAY,
        );
        env.set_caller(taker);
        swap.take(4);
        assert_eq!(dollar.balance_of(&me), U256::from(250 * TUSD));
        assert_eq!(test.balance_of(&taker), U256::from(100 * TEST));

        println!("{}", env.gas_report());
    }
}
