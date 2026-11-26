#![cfg_attr(not(test), no_std)]
#![cfg_attr(not(test), no_main)]
extern crate alloc;

pub mod club;
#[cfg(not(target_arch = "wasm32"))]
pub mod demo;
pub mod registry;

#[cfg(test)]
mod tests {
    use crate::registry::AttestationRegistry;
    use odra::host::{Deployer, HostEnv, NoArgs};

    /// Prints the gas report on CasperVM (`cargo odra test -b casper`); does nothing on OdraVM.
    fn print_gas_report(env: &HostEnv, what: &str) {
        if std::env::var("ODRA_BACKEND").as_deref() == Ok("casper") {
            println!("Gas report of {what}:\n{}", env.gas_report());
        }
    }

    /// The demo of the command line tool, call for call with its gas limits, from the deploy on.
    #[test]
    fn the_demo_runs_to_the_end() {
        let env = odra_test::env();
        env.set_gas(crate::demo::DEPLOY_GAS);
        let mut registry = AttestationRegistry::deploy(&env, NoArgs);
        let caller = env.caller();
        let now = env.block_time();

        let run = crate::demo::run(&env, &mut registry, now).unwrap();

        assert!(run.registered);
        assert_eq!((run.schema_id, run.valid_id, run.revoked_id), (0, 0, 1));
        assert!(registry.is_valid(0, caller));
        let other = registry.attestation(1).subject;
        assert_eq!(crate::demo::formatted(&other), crate::demo::OTHER);
        assert!(!registry.is_valid(0, other));
        assert_eq!(
            registry.attestation(0).expires,
            Some(now + crate::demo::VALID_FOR)
        );

        // Run again, it finds the schema and attests once more.
        let again = crate::demo::run(&env, &mut registry, now).unwrap();
        assert!(!again.registered);
        assert_eq!(
            (again.schema_id, again.valid_id, again.revoked_id),
            (0, 2, 3)
        );
        assert_eq!(registry.schemas_count(), 1);
        print_gas_report(&env, "the demo");
    }
}
