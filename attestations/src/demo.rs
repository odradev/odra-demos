//! The demo the command line tool runs (`scenario demo`), kept here so that a CasperVM test runs
//! the same calls with the same gas limits before they are sent to a network.

use crate::registry::AttestationRegistryHostRef;
use core::str::FromStr;
use odra::casper_types::Key;
use odra::host::HostEnv;
use odra::prelude::*;

const CSPR: u64 = 1_000_000_000;

/// Gas limits. Measured on CasperVM (`cargo odra test -b casper -s`, on the wasm file that
/// `cargo odra build` writes and `deploy` sends): the deploy of `AttestationRegistry` 293.7 CSPR,
/// `register_schema` 0.91, `attest` 1.64 to 1.74, `revoke` 0.50. The network refunds three
/// quarters of what a transaction leaves unused and charges a failed one its whole limit, so the
/// deploy gets 10% more than measured and a call the 2.5 CSPR that is the practical minimum.
pub const DEPLOY_GAS: u64 = 325 * CSPR;
pub const REGISTER_GAS: u64 = 2_500_000_000;
pub const ATTEST_GAS: u64 = 2_500_000_000;
pub const REVOKE_GAS: u64 = 2_500_000_000;

/// The schema the demo attests under.
pub const SCHEMA_NAME: &str = "Ran the Odra attestations demo";
/// How long the demo's attestation of the caller holds: 30 days, in milliseconds.
pub const VALID_FOR: u64 = 30 * 24 * 60 * 60 * 1000;
/// A made-up account the demo attests about and then revokes. Nobody holds its key.
pub const OTHER: &str =
    "account-hash-3333333333333333333333333333333333333333333333333333333333333333";

/// What the demo did.
pub struct DemoRun {
    pub schema_id: u64,
    /// Whether the schema was registered in this run rather than found from an earlier one.
    pub registered: bool,
    /// The attestation of the caller: valid for `VALID_FOR`.
    pub valid_id: u64,
    /// The attestation of `OTHER`: made and revoked.
    pub revoked_id: u64,
}

/// Registers `SCHEMA_NAME` (revocable) unless the caller has registered it before, attests about
/// the caller with an expiry of `now + VALID_FOR`, and attests about `OTHER` and revokes that.
/// `now` is a block time in milliseconds.
pub fn run(
    env: &HostEnv,
    registry: &mut AttestationRegistryHostRef,
    now: u64,
) -> OdraResult<DemoRun> {
    let caller = env.caller();

    let mut found = None;
    for id in registry.try_schemas_of_issuer(caller)? {
        if registry.try_schema(id)?.name == SCHEMA_NAME {
            found = Some(id);
            break;
        }
    }
    let registered = found.is_none();
    let schema_id = match found {
        Some(id) => id,
        None => {
            let id = registry.try_schemas_count()?;
            env.set_gas(REGISTER_GAS);
            registry.try_register_schema(SCHEMA_NAME.to_string(), true)?;
            id
        }
    };

    let valid_id = registry.try_attestations_count()?;
    env.set_gas(ATTEST_GAS);
    registry.try_attest(
        schema_id,
        caller,
        "Signed from the command line".to_string(),
        Some(now + VALID_FOR),
    )?;

    let other = Address::from_str(OTHER).expect("a valid account hash");
    let revoked_id = registry.try_attestations_count()?;
    env.set_gas(ATTEST_GAS);
    registry.try_attest(schema_id, other, "To be revoked".to_string(), None)?;
    env.set_gas(REVOKE_GAS);
    registry.try_revoke(revoked_id)?;

    Ok(DemoRun {
        schema_id,
        registered,
        valid_id,
        revoked_id,
    })
}

/// An address as the web app and odra-cli read it: `account-hash-…` or `hash-…`.
/// (`Address::to_formatted_string` prints `entity-account-…`, which neither reads.)
pub fn formatted(address: &Address) -> String {
    Key::from(*address).to_formatted_string()
}
