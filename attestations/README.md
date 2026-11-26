# Attestations

A registry of statements about accounts. An issuer records on chain that something is true of an
account ("passed KYC", "took part in the hackathon"), may give it an end date, and may revoke it.
Anyone can read the statements, and another contract can ask whether one holds before it lets an
account in. Written in [Odra](https://odra.dev) for [Casper](https://casper.network).

The project has five parts:

- `src/registry.rs`: the `AttestationRegistry` contract and its tests.
- `src/club.rs`: `Club`, a small contract that lets in only accounts with a valid attestation: the
  example of another contract calling `is_valid`. It is tested, not deployed.
- `bin/cli.rs` and `src/demo.rs`: a command line tool that deploys the registry and runs a demo.
- `web/`: a web app for looking an account up, registering schemas, attesting and revoking with a
  Casper wallet.
- `storage_reader/`: builds [odra-storage-reader](https://github.com/odradev/odra/tree/release/2.11.0/odra-storage-reader), which the web app reads contract state with, to wasm.

## How it works

- A **schema** is a kind of statement: a name ("Passed KYC") and whether its statements can be
  revoked. Anyone can register one with `register_schema` and becomes its **issuer**. A schema has
  exactly one issuer, the account that registered it, for ever: no list of issuers, no transfer.
  An organisation that wants several people to attest registers the schema from a shared account
  (a multisig, or a contract).
- An **attestation** is a statement of a schema's issuer about a **subject**, any account or
  contract: `attest(schema_id, subject, data, expires)`. `data` is a short note of up to 128
  bytes (a level, a reference); `expires` is a block time in milliseconds, or none for never.
- An attestation **holds** while it is not revoked and its expiry, if it has one, has not come.
  The issuer may `revoke` it, if the schema was registered as revocable.
- For each schema and subject the registry keeps one **current** attestation: the latest. Attesting
  again replaces the earlier statement, which stays readable; that is how a statement is renewed
  or corrected. `is_valid(schema_id, subject)` checks the current one: it exists, is not revoked
  and has not expired.

The contract has no owner, no fees, no token and no upgrade key. One deployed registry holds the
schemas of every issuer.

### Checking it from another contract

A contract declares the one entry point it needs and calls it:

```rust
#[odra::external_contract]
pub trait AttestationCheck {
    fn is_valid(&self, schema_id: u64, subject: Address) -> bool;
}

// in a module with `registry: External<AttestationCheckContractRef>`:
if !self.registry.is_valid(self.schema_id.get_or_default(), self.env().caller()) {
    self.env().revert(Error::NotAttested);
}
```

`src/club.rs` is that contract, with tests for a valid, an expired, a revoked and a wrong-schema
attestation. Its errors start at 100, apart from the registry's: the errors of every contract
called in one transaction share one number space.

The check trusts the issuer, not the statement: a contract should check the schema id it was given
belongs to the issuer it means (`schema(id).issuer`), since anyone can register a schema with any
name.

## Entry points

| Entry point | Who | What it does |
|---|---|---|
| `register_schema(name, revocable)` | anyone | Registers a schema with the caller as its issuer. `name` is 1 to 64 bytes. |
| `attest(schema_id, subject, data, expires)` | the issuer of the schema | Records a statement about `subject` and makes it the current one of the schema. `expires` is `Option<u64>`, a block time in milliseconds after now. |
| `revoke(attestation_id)` | the issuer | Revokes a statement of a revocable schema. |
| `is_valid(schema_id, subject)` | view | Whether the current statement of the schema about the subject holds. False for an unknown schema. |
| `schema(schema_id)` | view | The schema: issuer, name, revocable, number of attestations. |
| `attestation(attestation_id)` | view | The statement: schema, issuer, subject, data, issued_at, expires, revoked, revoked_at. |
| `current_attestation(schema_id, subject)` | view | The id of the current statement, if any. |
| `schemas_count()`, `attestations_count()` | view | The numbers of schemas and statements. Ids run from `0` to `count - 1`. |
| `attestations_of_subject(address)` | view | Ids of the statements about the address, oldest first. |
| `attestations_of_issuer(address)` | view | Ids of the statements the address made, oldest first. |
| `schemas_of_issuer(address)` | view | Ids of the schemas the address registered, oldest first. |

The entry points that change state return nothing. The id of a new schema or statement is the
value `schemas_count` or `attestations_count` returned before the call, and the events carry it.

### Storage

Everything the web app shows is a stored value, read without calling the contract:

| Field | Type | Key in the odra-cli text format |
|---|---|---|
| `schemas` | `Mapping<u64, Schema>` | `5` |
| `schema_count`, `attestation_count` | `Var<u64>` | |
| `attestations` | `Mapping<u64, Attestation>` | `5` |
| `current` | `Mapping<(u64, Address), u64>` | `5:account-hash-…` |
| `by_subject`, `by_issuer`, `schemas_by_issuer` | `Mapping<Address, List<u64>>` | `account-hash-…` and the index, `0`, `1`, … |

The lists of ids are Odra `List`s, one per account, so adding to one costs the same however long
it is (a `Vec` in a mapping is rewritten whole: an attestation cost 6.9 CSPR for an issuer with
500 before it, against 1.6 with a `List`). The length of a list kept in a mapping cannot be read
from storage; the app reads items until one is missing.

### Events

| Event | Fields |
|---|---|
| `SchemaRegistered` | `schema_id`, `issuer`, `name`, `revocable` |
| `Attested` | `attestation_id`, `schema_id`, `issuer`, `subject`, `data`, `expires` |
| `Revoked` | `attestation_id`, `schema_id`, `issuer`, `subject` |

### Errors

| Code | Error | When |
|---|---|---|
| 1 | `EmptyName` | The name of the schema is empty. |
| 2 | `NameTooLong` | The name is longer than 64 bytes. |
| 3 | `DataTooLong` | The note is longer than 128 bytes. |
| 4 | `ExpiryInPast` | The expiry is not after the current block time. |
| 5 | `SchemaNotFound` | No schema has this id. |
| 6 | `AttestationNotFound` | No statement has this id. |
| 7 | `NotIssuer` | Someone other than the issuer of the schema tried to attest or revoke. |
| 8 | `NotRevocable` | The schema was registered as not revocable. |
| 9 | `AlreadyRevoked` | The statement was revoked before. |

## Things to know before using it

- **Not audited.** Review and test it yourself before relying on it.
- **Everything is public**, the note included. Never put personal data in a statement: record that
  a check was done, not what it found.
- **A name proves nothing.** Anyone can register "Passed KYC". Trust a schema for its issuer.
- **An issuer is for ever.** A lost key cannot attest or revoke again; register a new schema.
- **Expiry is block time.** A statement stops holding at the first block at or after its expiry.
- **What it costs.** Gas measured on CasperVM and NCTL in November 2026, the same to the mote on
  the testnet: registering a schema 0.91 CSPR, an attestation 1.64 to 1.74 whatever the number
  before it, a revoke 0.50. With the 2.5 CSPR limit the CLI and the web app set, the network
  charges about 1.3, 1.9 and 1.0 CSPR.

## Running it

You need Rust, the `wasm32-unknown-unknown` target and
[cargo-odra](https://github.com/odradev/cargo-odra). `wasm-opt` and `wasm-strip` are needed to
build wasm files; see the [installation guide](https://odra.dev/docs/getting-started/installation).

```bash
cargo odra test            # tests on OdraVM
cargo odra test -b casper  # builds the wasm files and runs the tests on CasperVM
```

`cargo odra test -b casper -- --nocapture` prints the gas of the demo and of an attestation by an
issuer with 500 before it.

The project depends on the `release/2.11.0` branch of Odra, not on a published version: the web
client of the published 2.10 sends transactions the testnet rejects.

## Deploying to the testnet

```bash
cp .env.sample .env        # then set the path of your secret key in .env
cargo odra build
cargo run --bin attestations_cli -- deploy
```

Deploying `AttestationRegistry` cost 301.5 CSPR on the testnet in November 2026: 293.7 CSPR of
gas, as measured on CasperVM, under the 325 CSPR limit set in `src/demo.rs`. The address is saved
to `resources/casper-test-contracts.toml`, and a second `deploy` reuses it.

To see it working, register a schema, attest about yourself for 30 days, and attest about a
made-up account and revoke that:

```bash
cargo run --bin attestations_cli -- scenario demo
cargo run --bin attestations_cli -- contract AttestationRegistry is_valid --schema_id 0 --subject <your account-hash-…>
```

The scenario sends four transactions (register, attest, attest, revoke; 6.1 CSPR together on the
testnet). Run again, it reuses the schema and sends three. The test `the_demo_runs_to_the_end`
runs the same calls with the same gas limits on CasperVM.
`cargo run --bin attestations_cli -- --help` lists every command.

### Deployed on the testnet

| Contract | Package hash |
|---|---|
| `AttestationRegistry` | [`hash-718896420f2a07104799522c1c93c356ccbcc050771375d5cf2f5dbef0aef900`](https://testnet.cspr.live/contract-package/718896420f2a07104799522c1c93c356ccbcc050771375d5cf2f5dbef0aef900) |

Schema 0 and attestations 0 (valid until 26 December 2026) and 1 (revoked) are the demo run.

## The web app

The app in `web/` has three parts:

- **Look up an account**, by public key, account hash or `.cspr` name: every statement about it,
  newest first, with its status (valid, expired, revoked, or replaced by a newer one) worked out in
  the browser by the rule of `is_valid`. A lookup has its own link (`#account=account-hash-…`).
- **Register a schema** and **attest** under one of yours, about any account, with an optional
  note and expiry.
- **Yours**: the statements about the connected account, those it issued (with a button to revoke),
  and its schemas.

It does two things with the contract, in two different ways:

- **It reads state straight from the node's storage** with
  [odra-storage-reader](https://github.com/odradev/odra/tree/release/2.11.0/odra-storage-reader).
  The reader takes the schema of the contract (`resources/casper_contract_schemas/`) and says where
  a value is stored; the app fetches it over JSON-RPC and the reader decodes it. No contract code
  runs and nothing is signed, so lookups need no wallet. `web/src/storage.ts` holds all of it.
- **It sends transactions** through the client `cargo odra generate-client` generates from the
  contracts, signed with [CSPR.click](https://cspr.click) (Casper Wallet or Ledger).

Names come from [CSPR.name](https://cspr.name), read from the storage of its contracts on the
mainnet (`web/src/names.ts`): the testnet has no names of its own, and an account has the same
account hash on both networks. It is an extra: when the mainnet cannot be read, accounts show as
shortened hashes and a name lookup says nothing was found.

```bash
# 1. Build the two wasm packages the app depends on. Needs wasm-pack.
env -u WASM_CLIENT_SK cargo odra generate-client   # the transaction client: attestations_client/pkg-web
cd web
npm run reader               # the storage reader: storage_reader/pkg-web

# 2. Give the app the contract address and start it.
npm install
npm run contracts            # writes src/contracts.json from ../resources/casper-test-contracts.toml
npm run dev
```

`cargo odra generate-client` needs cargo-odra 0.2.1 or newer: 0.2.0 stops with `Project is not a
workspace`. Until 0.2.1 is on crates.io, install it from its branch:
`cargo install cargo-odra --locked --git https://github.com/odradev/cargo-odra --branch release/0.2.1`.

`npm run build` writes a static site to `web/dist`. `web/src/contracts.json` in the repository
holds the testnet address above, so `npm run contracts` is needed only after deploying your own.
