//! Command line tool of the sale project: deploys the contract and runs a demo on a network.

use std::time::{SystemTime, UNIX_EPOCH};

use odra::host::{HostEnv, NoArgs};
use odra::prelude::*;
use odra_cli::{
    deploy::DeployScript,
    scenario::{Args, Error, Scenario, ScenarioMetadata},
    ContractProvider, DeployedContractsContainer, DeployerExt, OdraCli,
};
use sale::demo;
use sale::sale::TokenSale;
use sale::token::TestToken;

/// Deploys `TokenSale`, or loads it if it is deployed already. `TestToken` is loaded from the
/// contracts file, which lists the one deployed for the vesting project; without that entry it
/// is deployed as well.
pub struct SaleDeployScript;

impl DeployScript for SaleDeployScript {
    fn deploy(
        &self,
        env: &HostEnv,
        container: &mut DeployedContractsContainer,
    ) -> Result<(), odra_cli::deploy::Error> {
        TestToken::load_or_deploy(env, NoArgs, container, demo::TOKEN_DEPLOY_GAS)?;
        TokenSale::load_or_deploy(env, NoArgs, container, demo::DEPLOY_GAS)?;
        Ok(())
    }
}

/// Puts 100 test tokens on sale to an allowlist of three that includes the caller, buys 4 of
/// them for 2 CSPR, and takes the 2 CSPR out again.
pub struct DemoScenario;

impl Scenario for DemoScenario {
    fn run(
        &self,
        env: &HostEnv,
        container: &DeployedContractsContainer,
        _args: Args,
    ) -> Result<(), Error> {
        let mut token = container.contract_ref::<TestToken>(env)?;
        let mut sale = container.contract_ref::<TokenSale>(env)?;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("the clock is set after 1970")
            .as_millis() as u64;

        let created = demo::run(env, &mut token, &mut sale, now)?;

        odra_cli::log(format!(
            "Created sale {}: 100 TEST at 0.5 CSPR each, 20 per wallet, for a week, allowlist root {}",
            created.id, created.root
        ));
        odra_cli::log(format!(
            "Bought 4 TEST for 2 CSPR as {}, and took the 2 CSPR out as the creator",
            demo::formatted(&env.caller())
        ));
        odra_cli::log("The allowlist, to paste into the web app:".to_string());
        for line in created.list_text.lines() {
            odra_cli::log(line.to_string());
        }
        Ok(())
    }
}

impl ScenarioMetadata for DemoScenario {
    const NAME: &'static str = "demo";
    const DESCRIPTION: &'static str =
        "Sells 100 test tokens to an allowlist with the caller on it, buys 4 for 2 CSPR and takes the CSPR out";
}

/// Runs the command line tool.
pub fn main() {
    OdraCli::new()
        .about("CLI tool for the token sale contract")
        .deploy(SaleDeployScript)
        .contract::<TokenSale>()
        .contract::<TestToken>()
        .scenario(DemoScenario)
        .build()
        .run();
}
