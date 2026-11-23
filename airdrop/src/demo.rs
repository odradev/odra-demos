//! The demo the command line tool runs (`scenario demo`), kept here so that a CasperVM test runs
//! the same calls with the same gas limits before they are sent to a network.

use crate::airdrop::AirdropHostRef;
use crate::merkle::Tree;
use crate::token::TestTokenHostRef;
use core::str::FromStr;
use odra::casper_types::bytesrepr::Bytes;
use odra::casper_types::{Key, U256};
use odra::host::HostEnv;
use odra::prelude::*;

const CSPR: u64 = 1_000_000_000;
/// One whole TEST, in its smallest unit (9 decimals).
const TEST: u64 = 1_000_000_000;

/// Gas limits. Measured on CasperVM (`cargo odra test -b casper -s`, on the wasm files that
/// `cargo odra build` writes and `deploy` sends): the deploy of `Airdrop` 281.0 CSPR, `faucet`
/// 0.30, `approve` 0.36, `create_drop` 1.72, `claim` 1.45 with the 2-node proof of the demo. The
/// network refunds three quarters of what a transaction leaves unused and charges a failed one
/// its whole limit, so the deploy gets 10% more than measured and a call the 2.5 CSPR that is the
/// practical minimum, or a little more.
pub const DEPLOY_GAS: u64 = 310 * CSPR;
/// Deploys a `TestToken` only when the contracts file does not list one.
pub const TOKEN_DEPLOY_GAS: u64 = 400 * CSPR;
pub const FAUCET_GAS: u64 = 2_500_000_000;
pub const APPROVE_GAS: u64 = 2_500_000_000;
pub const CREATE_GAS: u64 = 3 * CSPR;
pub const CLAIM_GAS: u64 = 2_500_000_000;

/// How long the demo drop stays open: a week, in milliseconds.
pub const OPEN_FOR: u64 = 7 * 24 * 60 * 60 * 1000;

/// Two made-up accounts the demo list pays besides the caller. Nobody holds their keys.
const OTHERS: [&str; 2] = [
    "account-hash-1111111111111111111111111111111111111111111111111111111111111111",
    "account-hash-2222222222222222222222222222222222222222222222222222222222222222",
];

/// The list of the demo drop: 25 TEST to the caller, 10 and 5 TEST to two made-up accounts.
pub fn list(caller: Address) -> Vec<(Address, U256)> {
    let other = |text: &str| Address::from_str(text).expect("a valid account hash");
    vec![
        (caller, U256::from(25 * TEST)),
        (other(OTHERS[0]), U256::from(10 * TEST)),
        (other(OTHERS[1]), U256::from(5 * TEST)),
    ]
}

/// What the demo created.
pub struct DemoDrop {
    pub id: u64,
    /// The root, in hex.
    pub root: String,
    /// The list in the format of the web app: `address, amount` per line, amounts in TEST.
    pub list_text: String,
}

/// Takes 1,000 TEST from the faucet, approves 40, drops them to `list(caller)` with claims open
/// until `now + OPEN_FOR`, and claims the caller's 25. `now` is a block time in milliseconds.
pub fn run(
    env: &HostEnv,
    token: &mut TestTokenHostRef,
    airdrop: &mut AirdropHostRef,
    now: u64,
) -> OdraResult<DemoDrop> {
    let caller = env.caller();
    let list = list(caller);
    let tree = Tree::new(&list);
    let total = list
        .iter()
        .fold(U256::zero(), |sum, (_, amount)| sum + amount);

    env.set_gas(FAUCET_GAS);
    token.try_faucet()?;
    env.set_gas(APPROVE_GAS);
    token.try_approve(&airdrop.address(), &total)?;

    let id = airdrop.drops_count();
    env.set_gas(CREATE_GAS);
    airdrop.try_create_drop(
        token.address(),
        Bytes::from(tree.root().to_vec()),
        total,
        list.len() as u32,
        now + OPEN_FOR,
    )?;

    env.set_gas(CLAIM_GAS);
    airdrop.try_claim(id, caller, list[0].1, tree.proof_bytes(0))?;

    let list_text = list
        .iter()
        .map(|(recipient, amount)| {
            format!("{}, {}\n", formatted(recipient), amount.as_u64() / TEST)
        })
        .collect();
    Ok(DemoDrop {
        id,
        root: tree
            .root()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
        list_text,
    })
}

/// An address as the web app and odra-cli read it: `account-hash-…` or `hash-…`.
/// (`Address::to_formatted_string` prints `entity-account-…`, which neither reads.)
pub fn formatted(address: &Address) -> String {
    Key::from(*address).to_formatted_string()
}
