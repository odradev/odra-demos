//! An example of a contract that trusts the registry: only accounts with a valid attestation of
//! one schema may join. It is here to show the call; it is not deployed on the testnet.

use odra::prelude::*;

/// The part of the registry another contract needs. A project that does not depend on this crate
/// declares the same trait; Odra generates `AttestationCheckContractRef` from it.
#[odra::external_contract]
pub trait AttestationCheck {
    /// Whether the current attestation of `schema_id` about `subject` holds.
    fn is_valid(&self, schema_id: u64, subject: Address) -> bool;
}

/// Errors of the club. They start at 100, apart from the registry's: the errors of every
/// contract called in one transaction share one number space.
#[odra::odra_error]
pub enum Error {
    /// The caller has no valid attestation of the schema the club requires.
    NotAttested = 100,
    /// The caller is a member already.
    AlreadyMember = 101,
}

/// An account joined the club.
#[odra::event]
pub struct Joined {
    pub member: Address,
}

/// A club that admits only accounts the registry vouches for.
#[odra::module(events = [Joined], errors = Error)]
pub struct Club {
    /// The registry to ask.
    registry: External<AttestationCheckContractRef>,
    /// The schema a member needs a valid attestation of.
    schema_id: Var<u64>,
    /// The accounts that joined.
    members: Mapping<Address, bool>,
    /// How many accounts joined.
    count: Var<u32>,
}

#[odra::module]
impl Club {
    /// Sets the registry to ask and the schema to require.
    pub fn init(&mut self, registry: Address, schema_id: u64) {
        self.registry.set(registry);
        self.schema_id.set(schema_id);
    }

    /// Makes the caller a member, if the registry holds a valid attestation of the schema about
    /// them. Membership stays when the attestation later expires or is revoked: the check is
    /// made once, at the door.
    pub fn join(&mut self) {
        let caller = self.env().caller();
        if !self
            .registry
            .is_valid(self.schema_id.get_or_default(), caller)
        {
            self.env().revert(Error::NotAttested);
        }
        if self.members.get_or_default(&caller) {
            self.env().revert(Error::AlreadyMember);
        }
        self.members.set(&caller, true);
        self.count.set(self.count.get_or_default() + 1);
        self.env().emit_event(Joined { member: caller });
    }

    /// Whether `account` has joined.
    pub fn is_member(&self, account: Address) -> bool {
        self.members.get_or_default(&account)
    }

    /// How many accounts have joined.
    pub fn members_count(&self) -> u32 {
        self.count.get_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::{AttestationRegistry, AttestationRegistryHostRef};
    use odra::host::{Deployer, HostEnv, NoArgs};

    const DAY: u64 = 24 * 60 * 60 * 1000;

    fn setup() -> (HostEnv, AttestationRegistryHostRef, ClubHostRef) {
        let env = odra_test::env();
        let mut registry = AttestationRegistry::deploy(&env, NoArgs);
        env.set_caller(env.get_account(1));
        registry.register_schema("Hackathon participant".to_string(), true);
        let club = Club::deploy(
            &env,
            ClubInitArgs {
                registry: registry.address(),
                schema_id: 0,
            },
        );
        (env, registry, club)
    }

    #[test]
    fn only_attested_accounts_may_join() {
        let (env, mut registry, mut club) = setup();
        let guest = env.get_account(2);

        env.set_caller(guest);
        assert_eq!(club.try_join(), Err(Error::NotAttested.into()));

        env.set_caller(env.get_account(1));
        registry.attest(0, guest, "Odra hackathon 2026".to_string(), None);

        env.set_caller(guest);
        club.join();
        assert!(club.is_member(guest));
        assert_eq!(club.members_count(), 1);
        assert!(env.emitted_event(&club, Joined { member: guest }));
        assert_eq!(club.try_join(), Err(Error::AlreadyMember.into()));
    }

    #[test]
    fn an_expired_or_revoked_attestation_does_not_open_the_door() {
        let (env, mut registry, mut club) = setup();
        let late = env.get_account(2);
        let revoked = env.get_account(3);

        env.set_caller(env.get_account(1));
        registry.attest(0, late, String::new(), Some(env.block_time() + DAY));
        registry.attest(0, revoked, String::new(), None);
        registry.revoke(1);
        env.advance_block_time(DAY);

        env.set_caller(late);
        assert_eq!(club.try_join(), Err(Error::NotAttested.into()));
        env.set_caller(revoked);
        assert_eq!(club.try_join(), Err(Error::NotAttested.into()));
        assert_eq!(club.members_count(), 0);
    }

    #[test]
    fn an_attestation_of_another_schema_does_not_count() {
        let (env, mut registry, mut club) = setup();
        let guest = env.get_account(2);
        env.set_caller(env.get_account(1));
        registry.register_schema("Passed KYC".to_string(), true);
        registry.attest(1, guest, String::new(), None);

        env.set_caller(guest);
        assert_eq!(club.try_join(), Err(Error::NotAttested.into()));
    }
}
