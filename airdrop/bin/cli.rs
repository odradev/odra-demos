//! Command line tool of the airdrop project: deploys the contract and runs a demo on a network.

use std::time::{SystemTime, UNIX_EPOCH};

use airdrop::airdrop::Airdrop;
use airdrop::demo;
use airdrop::token::TestToken;
use odra::host::{HostEnv, NoArgs};
use odra::prelude::*;
use odra_cli::{
    deploy::DeployScript,
    scenario::{Args, Error, Scenario, ScenarioMetadata},
    ContractProvider, DeployedContractsContainer, DeployerExt, OdraCli,
};

/// Deploys `Airdrop`, or loads it if it is deployed already. `TestToken` is loaded from the
/// contracts file, which lists the one deployed for the vesting project; without that entry it
/// is deployed as well.
pub struct AirdropDeployScript;

impl DeployScript for AirdropDeployScript {
    fn deploy(
        &self,
        env: &HostEnv,
        container: &mut DeployedContractsContainer,
    ) -> Result<(), odra_cli::deploy::Error> {
        TestToken::load_or_deploy(env, NoArgs, container, demo::TOKEN_DEPLOY_GAS)?;
        Airdrop::load_or_deploy(env, NoArgs, container, demo::DEPLOY_GAS)?;
        Ok(())
    }
}

/// Takes test tokens from the faucet, drops 40 of them to a list of three that includes the
/// caller, and claims the caller's 25.
pub struct DemoScenario;

impl Scenario for DemoScenario {
    fn run(
        &self,
        env: &HostEnv,
        container: &DeployedContractsContainer,
        _args: Args,
    ) -> Result<(), Error> {
        let mut token = container.contract_ref::<TestToken>(env)?;
        let mut airdrop = container.contract_ref::<Airdrop>(env)?;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("the clock is set after 1970")
            .as_millis() as u64;
        let caller = env.caller();

        let drop = demo::run(env, &mut token, &mut airdrop, now)?;

        odra_cli::log(format!(
            "Created drop {}: 40 TEST for 3 recipients, root {}",
            drop.id, drop.root
        ));
        odra_cli::log(format!(
            "Claimed 25 TEST of drop {} for {}",
            drop.id,
            demo::formatted(&caller)
        ));
        odra_cli::log("The list, to paste into the web app:".to_string());
        for line in drop.list_text.lines() {
            odra_cli::log(line.to_string());
        }
        Ok(())
    }
}

impl ScenarioMetadata for DemoScenario {
    const NAME: &'static str = "demo";
    const DESCRIPTION: &'static str =
        "Drops 40 test tokens to a list of three that includes the caller, and claims the caller's 25";
}

/// Runs the command line tool.
pub fn main() {
    OdraCli::new()
        .about("CLI tool for the airdrop contract")
        .deploy(AirdropDeployScript)
        .contract::<Airdrop>()
        .contract::<TestToken>()
        .scenario(DemoScenario)
        .build()
        .run();
}
