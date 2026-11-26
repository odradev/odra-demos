//! An attestation registry: issuers record statements about accounts, anyone can check them.

use odra::prelude::*;

/// The longest name of a schema, in bytes.
pub const MAX_NAME_LENGTH: usize = 64;
/// The longest `data` of an attestation, in bytes.
pub const MAX_DATA_LENGTH: usize = 128;

/// A kind of statement, such as "passed KYC". The account that registers it is its only issuer.
#[odra::odra_type]
pub struct Schema {
    /// The account that registered the schema: the only one that may attest under it.
    pub issuer: Address,
    /// What an attestation under this schema says, in words.
    pub name: String,
    /// Whether the issuer may revoke an attestation under this schema.
    pub revocable: bool,
    /// The number of attestations made under this schema so far.
    pub attestations: u64,
}

/// A statement an issuer made about a subject. Times are block times: milliseconds since the
/// Unix epoch.
#[odra::odra_type]
pub struct Attestation {
    /// The schema the statement belongs to.
    pub schema_id: u64,
    /// The issuer of the schema, who made the statement.
    pub issuer: Address,
    /// The account the statement is about.
    pub subject: Address,
    /// A short note of the issuer: a level, a reference, an event name. May be empty.
    pub data: String,
    /// When the statement was made.
    pub issued_at: u64,
    /// When the statement stops being valid, if ever.
    pub expires: Option<u64>,
    /// Whether the issuer has revoked the statement.
    pub revoked: bool,
    /// When the issuer revoked it; 0 while it is not revoked.
    pub revoked_at: u64,
}

/// Errors of the registry.
#[odra::odra_error]
pub enum Error {
    /// The name of a schema is empty.
    EmptyName = 1,
    /// The name of a schema is longer than `MAX_NAME_LENGTH` bytes.
    NameTooLong = 2,
    /// The data of an attestation is longer than `MAX_DATA_LENGTH` bytes.
    DataTooLong = 3,
    /// The expiry is not after the current block time.
    ExpiryInPast = 4,
    /// No schema has this id.
    SchemaNotFound = 5,
    /// No attestation has this id.
    AttestationNotFound = 6,
    /// Only the issuer of the schema may do this.
    NotIssuer = 7,
    /// The schema was registered as not revocable.
    NotRevocable = 8,
    /// The attestation has been revoked already.
    AlreadyRevoked = 9,
}

/// A schema was registered.
#[odra::event]
pub struct SchemaRegistered {
    pub schema_id: u64,
    pub issuer: Address,
    pub name: String,
    pub revocable: bool,
}

/// An issuer attested something about a subject.
#[odra::event]
pub struct Attested {
    pub attestation_id: u64,
    pub schema_id: u64,
    pub issuer: Address,
    pub subject: Address,
    pub data: String,
    pub expires: Option<u64>,
}

/// An issuer revoked an attestation.
#[odra::event]
pub struct Revoked {
    pub attestation_id: u64,
    pub schema_id: u64,
    pub issuer: Address,
    pub subject: Address,
}

/// Records statements issuers make about accounts, and answers whether one holds.
///
/// Anyone can register a schema and becomes its issuer. The contract has no owner, no fees and
/// no upgrade key.
#[odra::module(events = [SchemaRegistered, Attested, Revoked], errors = Error)]
pub struct AttestationRegistry {
    /// Schemas by id.
    schemas: Mapping<u64, Schema>,
    /// The number of schemas registered; also the id of the next one.
    schema_count: Var<u64>,
    /// Attestations by id.
    attestations: Mapping<u64, Attestation>,
    /// The number of attestations made; also the id of the next one.
    attestation_count: Var<u64>,
    /// The id of the latest attestation of a schema about a subject: the one `is_valid` checks.
    current: Mapping<(u64, Address), u64>,
    /// Ids of the attestations about an account, oldest first. A `List` per account, so that
    /// adding one costs the same however many there are.
    by_subject: Mapping<Address, List<u64>>,
    /// Ids of the attestations an account issued, oldest first.
    by_issuer: Mapping<Address, List<u64>>,
    /// Ids of the schemas an account registered, oldest first.
    schemas_by_issuer: Mapping<Address, List<u64>>,
}

#[odra::module]
impl AttestationRegistry {
    /// Registers a schema with the caller as its issuer. Its id is the value `schemas_count`
    /// returned before the call; the `SchemaRegistered` event carries it.
    pub fn register_schema(&mut self, name: String, revocable: bool) {
        if name.is_empty() {
            self.env().revert(Error::EmptyName);
        }
        if name.len() > MAX_NAME_LENGTH {
            self.env().revert(Error::NameTooLong);
        }
        let issuer = self.env().caller();
        let schema_id = self.schema_count.get_or_default();
        self.schema_count.set(schema_id + 1);
        self.schemas.set(
            &schema_id,
            Schema {
                issuer,
                name: name.clone(),
                revocable,
                attestations: 0,
            },
        );
        self.schemas_by_issuer.list(&issuer).push(schema_id);
        self.env().emit_event(SchemaRegistered {
            schema_id,
            issuer,
            name,
            revocable,
        });
    }

    /// Attests under `schema_id` about `subject`. Only the issuer of the schema may call it.
    /// `expires` is a block time in milliseconds after which the attestation no longer holds, or
    /// `None` for never.
    ///
    /// The new attestation becomes the current one of the schema about the subject, the one
    /// `is_valid` checks: attesting again replaces an older statement, for example to renew it.
    /// Its id is the value `attestations_count` returned before the call; the `Attested` event
    /// carries it.
    pub fn attest(&mut self, schema_id: u64, subject: Address, data: String, expires: Option<u64>) {
        let mut schema = self.get_schema(schema_id);
        let issuer = self.env().caller();
        if issuer != schema.issuer {
            self.env().revert(Error::NotIssuer);
        }
        if data.len() > MAX_DATA_LENGTH {
            self.env().revert(Error::DataTooLong);
        }
        let now = self.env().get_block_time();
        if expires.is_some_and(|moment| moment <= now) {
            self.env().revert(Error::ExpiryInPast);
        }

        let attestation_id = self.attestation_count.get_or_default();
        self.attestation_count.set(attestation_id + 1);
        self.attestations.set(
            &attestation_id,
            Attestation {
                schema_id,
                issuer,
                subject,
                data: data.clone(),
                issued_at: now,
                expires,
                revoked: false,
                revoked_at: 0,
            },
        );
        schema.attestations += 1;
        self.schemas.set(&schema_id, schema);
        self.current.set(&(schema_id, subject), attestation_id);
        self.by_subject.list(&subject).push(attestation_id);
        self.by_issuer.list(&issuer).push(attestation_id);

        self.env().emit_event(Attested {
            attestation_id,
            schema_id,
            issuer,
            subject,
            data,
            expires,
        });
    }

    /// Revokes an attestation. Only the issuer may call it, and only under a revocable schema.
    pub fn revoke(&mut self, attestation_id: u64) {
        let mut attestation = self.get_attestation(attestation_id);
        let schema = self.get_schema(attestation.schema_id);
        if self.env().caller() != attestation.issuer {
            self.env().revert(Error::NotIssuer);
        }
        if !schema.revocable {
            self.env().revert(Error::NotRevocable);
        }
        if attestation.revoked {
            self.env().revert(Error::AlreadyRevoked);
        }
        attestation.revoked = true;
        attestation.revoked_at = self.env().get_block_time();
        self.attestations.set(&attestation_id, attestation.clone());
        self.env().emit_event(Revoked {
            attestation_id,
            schema_id: attestation.schema_id,
            issuer: attestation.issuer,
            subject: attestation.subject,
        });
    }

    /// Whether the current attestation of `schema_id` about `subject` holds: it exists, it is not
    /// revoked and it has not expired. False for a schema that does not exist. Meant to be called
    /// by other contracts.
    pub fn is_valid(&self, schema_id: u64, subject: Address) -> bool {
        match self.current.get(&(schema_id, subject)) {
            Some(id) => self.holds(&self.get_attestation(id)),
            None => false,
        }
    }

    /// Returns the schema with the given id.
    pub fn schema(&self, schema_id: u64) -> Schema {
        self.get_schema(schema_id)
    }

    /// Returns the attestation with the given id.
    pub fn attestation(&self, attestation_id: u64) -> Attestation {
        self.get_attestation(attestation_id)
    }

    /// Returns the id of the current attestation of `schema_id` about `subject`, if there is one.
    pub fn current_attestation(&self, schema_id: u64, subject: Address) -> Option<u64> {
        self.current.get(&(schema_id, subject))
    }

    /// Returns the number of schemas. Ids run from `0` to `count - 1`.
    pub fn schemas_count(&self) -> u64 {
        self.schema_count.get_or_default()
    }

    /// Returns the number of attestations. Ids run from `0` to `count - 1`.
    pub fn attestations_count(&self) -> u64 {
        self.attestation_count.get_or_default()
    }

    /// Returns the ids of the attestations about `subject`, oldest first.
    pub fn attestations_of_subject(&self, subject: Address) -> Vec<u64> {
        self.by_subject.list(&subject).iter().collect()
    }

    /// Returns the ids of the attestations `issuer` made, oldest first.
    pub fn attestations_of_issuer(&self, issuer: Address) -> Vec<u64> {
        self.by_issuer.list(&issuer).iter().collect()
    }

    /// Returns the ids of the schemas `issuer` registered, oldest first.
    pub fn schemas_of_issuer(&self, issuer: Address) -> Vec<u64> {
        self.schemas_by_issuer.list(&issuer).iter().collect()
    }
}

impl AttestationRegistry {
    fn get_schema(&self, schema_id: u64) -> Schema {
        self.schemas
            .get(&schema_id)
            .unwrap_or_revert_with(self, Error::SchemaNotFound)
    }

    fn get_attestation(&self, attestation_id: u64) -> Attestation {
        self.attestations
            .get(&attestation_id)
            .unwrap_or_revert_with(self, Error::AttestationNotFound)
    }

    /// Whether an attestation holds at the current block time.
    fn holds(&self, attestation: &Attestation) -> bool {
        let now = self.env().get_block_time();
        !attestation.revoked && attestation.expires.is_none_or(|moment| now < moment)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use odra::host::{Deployer, HostEnv, NoArgs};

    const DAY: u64 = 24 * 60 * 60 * 1000;

    struct Setup {
        env: HostEnv,
        registry: AttestationRegistryHostRef,
        issuer: Address,
        subject: Address,
    }

    fn setup() -> Setup {
        let env = odra_test::env();
        let issuer = env.get_account(1);
        let subject = env.get_account(2);
        let registry = AttestationRegistry::deploy(&env, NoArgs);
        Setup {
            env,
            registry,
            issuer,
            subject,
        }
    }

    /// Registers a schema as the issuer and returns its id.
    fn register(s: &mut Setup, name: &str, revocable: bool) -> u64 {
        s.env.set_caller(s.issuer);
        let id = s.registry.schemas_count();
        s.registry.register_schema(name.to_string(), revocable);
        id
    }

    /// Attests about the subject as the issuer and returns the id of the attestation.
    fn attest(s: &mut Setup, schema_id: u64, expires: Option<u64>) -> u64 {
        s.env.set_caller(s.issuer);
        let id = s.registry.attestations_count();
        s.registry
            .attest(schema_id, s.subject, "level 2".to_string(), expires);
        id
    }

    #[test]
    fn registering_a_schema_makes_the_caller_its_issuer() {
        let mut s = setup();
        let id = register(&mut s, "Passed KYC", true);

        assert_eq!(id, 0);
        assert_eq!(s.registry.schemas_count(), 1);
        assert_eq!(
            s.registry.schema(id),
            Schema {
                issuer: s.issuer,
                name: "Passed KYC".to_string(),
                revocable: true,
                attestations: 0
            }
        );
        assert_eq!(s.registry.schemas_of_issuer(s.issuer), vec![0]);
        assert!(s.registry.schemas_of_issuer(s.subject).is_empty());
        assert!(s.env.emitted_event(
            &s.registry,
            SchemaRegistered {
                schema_id: 0,
                issuer: s.issuer,
                name: "Passed KYC".to_string(),
                revocable: true
            }
        ));
        assert_eq!(register(&mut s, "Hackathon participant", false), 1);
        assert_eq!(s.registry.schemas_of_issuer(s.issuer), vec![0, 1]);
    }

    #[test]
    fn an_attestation_is_recorded_and_valid() {
        let mut s = setup();
        let schema = register(&mut s, "Passed KYC", true);
        let now = s.env.block_time();
        let id = attest(&mut s, schema, Some(now + 30 * DAY));

        assert_eq!(id, 0);
        assert_eq!(
            s.registry.attestation(id),
            Attestation {
                schema_id: schema,
                issuer: s.issuer,
                subject: s.subject,
                data: "level 2".to_string(),
                issued_at: now,
                expires: Some(now + 30 * DAY),
                revoked: false,
                revoked_at: 0
            }
        );
        assert!(s.registry.is_valid(schema, s.subject));
        assert!(!s.registry.is_valid(schema, s.issuer));
        assert_eq!(s.registry.current_attestation(schema, s.subject), Some(id));
        assert_eq!(s.registry.attestations_of_subject(s.subject), vec![id]);
        assert_eq!(s.registry.attestations_of_issuer(s.issuer), vec![id]);
        assert!(s.registry.attestations_of_issuer(s.subject).is_empty());
        assert_eq!(s.registry.schema(schema).attestations, 1);
        assert!(s.env.emitted_event(
            &s.registry,
            Attested {
                attestation_id: id,
                schema_id: schema,
                issuer: s.issuer,
                subject: s.subject,
                data: "level 2".to_string(),
                expires: Some(now + 30 * DAY)
            }
        ));
    }

    #[test]
    fn an_attestation_stops_holding_when_it_expires() {
        let mut s = setup();
        let schema = register(&mut s, "Passed KYC", true);
        let expires = s.env.block_time() + DAY;
        attest(&mut s, schema, Some(expires));

        s.env.advance_block_time(DAY - 1);
        assert!(s.registry.is_valid(schema, s.subject));
        s.env.advance_block_time(1);
        assert!(!s.registry.is_valid(schema, s.subject));
    }

    #[test]
    fn an_attestation_without_expiry_holds_for_ever() {
        let mut s = setup();
        let schema = register(&mut s, "Hackathon participant", false);
        attest(&mut s, schema, None);
        s.env.advance_block_time(10_000 * DAY);
        assert!(s.registry.is_valid(schema, s.subject));
    }

    #[test]
    fn the_issuer_revokes_an_attestation() {
        let mut s = setup();
        let schema = register(&mut s, "Passed KYC", true);
        let id = attest(&mut s, schema, None);
        s.env.advance_block_time(DAY);
        let now = s.env.block_time();

        s.registry.revoke(id);

        assert!(!s.registry.is_valid(schema, s.subject));
        let attestation = s.registry.attestation(id);
        assert!(attestation.revoked);
        assert_eq!(attestation.revoked_at, now);
        assert!(s.env.emitted_event(
            &s.registry,
            Revoked {
                attestation_id: id,
                schema_id: schema,
                issuer: s.issuer,
                subject: s.subject
            }
        ));
        assert_eq!(s.registry.try_revoke(id), Err(Error::AlreadyRevoked.into()));
    }

    #[test]
    fn attesting_again_replaces_the_current_attestation() {
        let mut s = setup();
        let schema = register(&mut s, "Passed KYC", true);
        let now = s.env.block_time();
        let first = attest(&mut s, schema, Some(now + DAY));
        let second = attest(&mut s, schema, Some(now + 30 * DAY));

        assert_eq!(
            s.registry.current_attestation(schema, s.subject),
            Some(second)
        );
        assert_eq!(
            s.registry.attestations_of_subject(s.subject),
            vec![first, second]
        );
        // The renewed statement holds after the old one would have expired.
        s.env.advance_block_time(2 * DAY);
        assert!(s.registry.is_valid(schema, s.subject));

        // A revoked statement can be replaced by a new one, too.
        s.registry.revoke(second);
        assert!(!s.registry.is_valid(schema, s.subject));
        let third = attest(&mut s, schema, None);
        assert!(s.registry.is_valid(schema, s.subject));
        assert_eq!(s.registry.schema(schema).attestations, 3);
        assert_eq!(s.registry.attestations_of_issuer(s.issuer), vec![0, 1, 2]);
        assert_eq!(third, 2);
    }

    #[test]
    fn schemas_are_independent() {
        let mut s = setup();
        let kyc = register(&mut s, "Passed KYC", true);
        let hackathon = register(&mut s, "Hackathon participant", false);
        attest(&mut s, hackathon, None);
        assert!(s.registry.is_valid(hackathon, s.subject));
        assert!(!s.registry.is_valid(kyc, s.subject));
        // A schema that does not exist is not valid for anyone, and the check does not fail.
        assert!(!s.registry.is_valid(7, s.subject));
    }

    #[test]
    fn only_the_issuer_attests() {
        let mut s = setup();
        let schema = register(&mut s, "Passed KYC", true);
        s.env.set_caller(s.subject);
        assert_eq!(
            s.registry
                .try_attest(schema, s.subject, String::new(), None),
            Err(Error::NotIssuer.into())
        );
    }

    #[test]
    fn revoking_is_guarded() {
        let mut s = setup();
        let revocable = register(&mut s, "Passed KYC", true);
        let fixed = register(&mut s, "Hackathon participant", false);
        let a = attest(&mut s, revocable, None);
        let b = attest(&mut s, fixed, None);

        s.env.set_caller(s.subject);
        assert_eq!(s.registry.try_revoke(a), Err(Error::NotIssuer.into()));
        s.env.set_caller(s.issuer);
        assert_eq!(s.registry.try_revoke(b), Err(Error::NotRevocable.into()));
        assert!(s.registry.is_valid(fixed, s.subject));
    }

    #[test]
    fn invalid_input_is_rejected() {
        let mut s = setup();
        s.env.set_caller(s.issuer);
        assert_eq!(
            s.registry.try_register_schema(String::new(), true),
            Err(Error::EmptyName.into())
        );
        assert_eq!(
            s.registry
                .try_register_schema("x".repeat(MAX_NAME_LENGTH + 1), true),
            Err(Error::NameTooLong.into())
        );
        let schema = register(&mut s, &"x".repeat(MAX_NAME_LENGTH), true);

        let subject = s.subject;
        assert_eq!(
            s.registry
                .try_attest(schema, subject, "x".repeat(MAX_DATA_LENGTH + 1), None),
            Err(Error::DataTooLong.into())
        );
        let now = s.env.block_time();
        assert_eq!(
            s.registry
                .try_attest(schema, subject, String::new(), Some(now)),
            Err(Error::ExpiryInPast.into())
        );
        assert_eq!(
            s.registry.try_attest(7, subject, String::new(), None),
            Err(Error::SchemaNotFound.into())
        );
        // The longest data and an empty one are both fine.
        s.registry
            .attest(schema, subject, "x".repeat(MAX_DATA_LENGTH), None);
        s.registry.attest(schema, subject, String::new(), None);
    }

    #[test]
    fn unknown_ids_are_reported() {
        let mut s = setup();
        assert_eq!(s.registry.try_schema(3), Err(Error::SchemaNotFound.into()));
        assert_eq!(
            s.registry.try_attestation(3),
            Err(Error::AttestationNotFound.into())
        );
        assert_eq!(
            s.registry.try_revoke(3),
            Err(Error::AttestationNotFound.into())
        );
        assert_eq!(s.registry.current_attestation(3, s.subject), None);
    }

    /// The gas of an attestation by an issuer who has made 500 before, about subjects with
    /// about 60 each: the same as the first, as the lists of ids are appended to, not rewritten.
    /// Printed on CasperVM.
    #[test]
    fn gas_of_an_attestation_after_five_hundred() {
        let mut s = setup();
        let schema = register(&mut s, "Passed KYC", true);
        for i in 0..500 {
            let subject = s.env.get_account(2 + i % 8);
            s.registry.attest(schema, subject, String::new(), None);
        }
        attest(&mut s, schema, None);
        if std::env::var("ODRA_BACKEND").as_deref() == Ok("casper") {
            let last = s.env.gas_report().into_iter().last();
            println!("Gas of the 501st attestation: {}", last.expect("a call"));
        }
        assert_eq!(s.registry.attestations_of_issuer(s.issuer).len(), 501);
    }

    #[test]
    fn a_contract_may_be_the_subject() {
        let mut s = setup();
        let schema = register(&mut s, "Audited contract", true);
        let contract = s.registry.address();
        s.registry.attest(schema, contract, String::new(), None);
        assert!(s.registry.is_valid(schema, contract));
        assert_eq!(s.registry.attestations_of_subject(contract), vec![0]);
    }
}
