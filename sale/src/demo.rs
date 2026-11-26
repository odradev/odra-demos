//! The demo the command line tool runs (`scenario demo`), kept here so that a CasperVM test runs
//! the same calls with the same gas limits before they are sent to a network.

use crate::merkle::Tree;
use crate::sale::TokenSaleHostRef;
use crate::token::TestTokenHostRef;
use core::str::FromStr;
use odra::casper_types::{Key, U256, U512};
use odra::host::{HostEnv, HostRef};
use odra::prelude::*;

const CSPR: u64 = 1_000_000_000;
/// One whole TEST, in its smallest unit (9 decimals).
const TEST: u64 = 1_000_000_000;

/// Gas limits. Measured on CasperVM (`cargo odra test -b casper -s`, on the wasm files that
/// `cargo odra build` writes and `deploy` sends): the deploy of `TokenSale` 337.5 CSPR, `faucet`
/// 0.30, `approve` 0.36, `create_sale` 2.25, `buy` 7.40 with the 2-node proof of the demo (7.74
/// with 10 nodes), `withdraw_proceeds` 3.03. The network refunds three quarters of what a
/// transaction leaves unused and charges a failed one its whole limit, so the deploy gets 10%
/// more than measured and a call a little more than it used, never less than the 2.5 CSPR that
/// is the practical minimum.
pub const DEPLOY_GAS: u64 = 370 * CSPR;
/// Deploys a `TestToken` only when the contracts file does not list one.
pub const TOKEN_DEPLOY_GAS: u64 = 400 * CSPR;
pub const FAUCET_GAS: u64 = 2_500_000_000;
pub const APPROVE_GAS: u64 = 2_500_000_000;
pub const CREATE_GAS: u64 = 3 * CSPR;
pub const BUY_GAS: u64 = 8 * CSPR;
pub const WITHDRAW_GAS: u64 = 3_500_000_000;

/// The demo sale: 100 TEST at 0.5 CSPR each, at most 20 per wallet, open for a week.
pub const PRICE: u64 = CSPR / 2;
pub const CAP: u64 = 100 * TEST;
pub const PER_WALLET: u64 = 20 * TEST;
pub const OPEN_FOR: u64 = 7 * 24 * 60 * 60 * 1000;
/// The caller pays 2 CSPR and gets 4 TEST.
pub const PAID: u64 = 2 * CSPR;
pub const BOUGHT: u64 = 4 * TEST;

/// Two made-up accounts the demo allowlist holds besides the caller. Nobody holds their keys.
const OTHERS: [&str; 2] = [
    "account-hash-1111111111111111111111111111111111111111111111111111111111111111",
    "account-hash-2222222222222222222222222222222222222222222222222222222222222222",
];

/// The allowlist of the demo sale: the caller and two made-up accounts.
pub fn allowlist(caller: Address) -> Vec<Address> {
    let other = |text: &str| Address::from_str(text).expect("a valid account hash");
    vec![caller, other(OTHERS[0]), other(OTHERS[1])]
}

/// What the demo created.
pub struct DemoSale {
    pub id: u64,
    /// The allowlist root, in hex.
    pub root: String,
    /// The allowlist in the format of the web app: one address per line.
    pub list_text: String,
}

/// Takes 1,000 TEST from the faucet, puts 100 of them on sale for a week to an allowlist of three
/// that includes the caller, buys 4 TEST for 2 CSPR with the caller's proof, and takes the 2 CSPR
/// out again as the creator. `now` is a block time in milliseconds.
pub fn run(
    env: &HostEnv,
    token: &mut TestTokenHostRef,
    sale: &mut TokenSaleHostRef,
    now: u64,
) -> OdraResult<DemoSale> {
    let caller = env.caller();
    let list = allowlist(caller);
    let tree = Tree::new(&list);

    env.set_gas(FAUCET_GAS);
    token.try_faucet()?;
    env.set_gas(APPROVE_GAS);
    token.try_approve(&sale.address(), &U256::from(CAP))?;

    let id = sale.sales_count();
    env.set_gas(CREATE_GAS);
    sale.try_create_sale(
        token.address(),
        U512::from(PRICE),
        U256::from(CAP),
        U256::from(PER_WALLET),
        now,
        now + OPEN_FOR,
        tree.root_bytes(),
    )?;

    env.set_gas(BUY_GAS);
    sale.with_tokens(U512::from(PAID))
        .try_buy(id, tree.proof_bytes(0))?;

    env.set_gas(WITHDRAW_GAS);
    sale.try_withdraw_proceeds(id)?;

    Ok(DemoSale {
        id,
        root: tree
            .root()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
        list_text: list
            .iter()
            .map(|address| format!("{}\n", formatted(address)))
            .collect(),
    })
}

/// An address as the web app and odra-cli read it: `account-hash-…` or `hash-…`.
/// (`Address::to_formatted_string` prints `entity-account-…`, which neither reads.)
pub fn formatted(address: &Address) -> String {
    Key::from(*address).to_formatted_string()
}
