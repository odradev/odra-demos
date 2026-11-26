//! Command line tool of the attestations project: deploys the registry and runs a demo on a
//! network.

use std::time::{SystemTime, UNIX_EPOCH};

use attestations::demo;
use attestations::registry::AttestationRegistry;
use odra::host::{HostEnv, NoArgs};
use odra::prelude::*;
use odra_cli::{
    deploy::DeployScript,
    scenario::{Args, Error, Scenario, ScenarioMetadata},
    ContractProvider, DeployedContractsContainer, DeployerExt, OdraCli,
};

/// Deploys `AttestationRegistry`, or loads it if it is deployed already. `Club`, the example of
/// a contract that checks the registry, is not deployed.
pub struct RegistryDeployScript;

impl DeployScript for RegistryDeployScript {
    fn deploy(
        &self,
        env: &HostEnv,
        container: &mut DeployedContractsContainer,
    ) -> Result<(), odra_cli::deploy::Error> {
        AttestationRegistry::load_or_deploy(env, NoArgs, container, demo::DEPLOY_GAS)?;
        Ok(())
    }
}

/// Registers a schema, attests about the caller for 30 days, and attests about a made-up
/// account and revokes it.
pub struct DemoScenario;

impl Scenario for DemoScenario {
    fn run(
        &self,
        env: &HostEnv,
        container: &DeployedContractsContainer,
        _args: Args,
    ) -> Result<(), Error> {
        let mut registry = container.contract_ref::<AttestationRegistry>(env)?;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("the clock is set after 1970")
            .as_millis() as u64;
        let caller = env.caller();

        let run = demo::run(env, &mut registry, now)?;

        let schema = if run.registered {
            "Registered schema"
        } else {
            "Reused schema"
        };
        odra_cli::log(format!(
            "{schema} {}: \"{}\", revocable",
            run.schema_id,
            demo::SCHEMA_NAME
        ));
        odra_cli::log(format!(
            "Attestation {}: about {}, valid for 30 days",
            run.valid_id,
            demo::formatted(&caller)
        ));
        odra_cli::log(format!(
            "Attestation {}: about {}, revoked",
            run.revoked_id,
            demo::OTHER
        ));
        Ok(())
    }
}

impl ScenarioMetadata for DemoScenario {
    const NAME: &'static str = "demo";
    const DESCRIPTION: &'static str =
        "Registers a schema, attests about the caller for 30 days, and attests about a made-up account and revokes it";
}

/// Runs the command line tool.
pub fn main() {
    OdraCli::new()
        .about("CLI tool for the attestation registry")
        .deploy(RegistryDeployScript)
        .contract::<AttestationRegistry>()
        .scenario(DemoScenario)
        .build()
        .run();
}
