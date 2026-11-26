//! The demo scenario, as a sequence of calls a host runs: the command line tool runs it on a
//! network, and a test runs the same sequence on CasperVM before it touches one.

use crate::curve::{CurveHostRef, CurveInitArgs};
use odra::casper_types::{U256, U512};
use odra::host::HostRef;
use odra::prelude::*;

const CSPR: u64 = 1_000_000_000;

/// Gas limits of the deploy and of the calls of the demo, in motes: what each used on CasperVM
/// (`the_demo_runs_and_reports_its_gas` in `src/curve.rs` prints it, on the wasm file
/// `cargo odra build` writes) and a margin. The network refunds three quarters of what a
/// transaction leaves unused, and lane limits make 2.5 CSPR the practical minimum of a call.
pub mod gas {
    use super::CSPR;
    /// Deploying `Curve`: 382.7 CSPR used, and 10% more.
    pub const DEPLOY: u64 = 421 * CSPR;
    /// A purchase. A payable call runs through Odra's proxy session code, which carries the CSPR
    /// to the contract. The buyer's first purchase used 6.60 CSPR on CasperVM but 3.92 on the
    /// testnet; one that sends change back used 2.5 CSPR more than one that does not.
    pub const BUY: u64 = 8 * CSPR;
    /// A sale: 3.18 CSPR used.
    pub const SELL: u64 = 4 * CSPR;
}

/// The token the CLI deploys: CURVE, 9 decimals, 0.1 CSPR a token at the start, and the price of a
/// token 0.001 CSPR higher with each token sold. At 100 tokens it costs 0.2 CSPR.
pub fn init_args() -> CurveInitArgs {
    CurveInitArgs {
        name: String::from("Curve Token"),
        symbol: String::from("CURVE"),
        decimals: 9,
        base_price: U512::from(CSPR / 10),
        slope: U512::from(CSPR / 1000),
    }
}

/// CSPR, in motes, the demo spends on its purchase: 10 CSPR.
pub const CSPR_TO_SPEND: u64 = 10 * CSPR;

/// How far the price may move between the quote and the transaction: 1%.
const SLIPPAGE_PERCENT: u64 = 1;

/// What the demo did.
pub struct Outcome {
    /// Tokens bought, in the smallest unit.
    pub bought: U256,
    /// What they cost, in motes.
    pub paid: U512,
    /// Tokens sold back: half of those bought.
    pub sold: U256,
    /// What the sale paid, in motes.
    pub received: U512,
    /// The reserve after the sale, in motes.
    pub reserve: U512,
}

/// Buys tokens for `cspr` motes, then sells half of them back. Both calls carry a minimum 1% below
/// the quote, as the web app's do.
pub fn run(curve: &mut CurveHostRef, cspr: U512) -> OdraResult<Outcome> {
    let env = curve.env().clone();
    let me = env.caller();

    let quote = curve.try_tokens_for(cspr)?;
    let held = curve.try_balance_of(&me)?;
    let reserve = curve.try_reserve()?;
    env.set_gas(gas::BUY);
    curve
        .with_tokens(cspr)
        .try_buy(quote * (100 - SLIPPAGE_PERCENT) / 100)?;
    let bought = curve.try_balance_of(&me)? - held;
    let after_buy = curve.try_reserve()?;
    let paid = after_buy - reserve;

    let sold = bought / 2;
    let quote = curve.try_proceeds_of(sold)?;
    env.set_gas(gas::SELL);
    curve.try_sell(sold, quote * (100 - SLIPPAGE_PERCENT) / 100)?;
    let reserve = curve.try_reserve()?;

    Ok(Outcome {
        bought,
        paid,
        sold,
        received: after_buy - reserve,
        reserve,
    })
}
