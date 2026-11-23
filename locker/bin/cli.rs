//! Command line tool of the locker project: deploys the contract and runs scenarios on a network.

use std::time::{SystemTime, UNIX_EPOCH};

use locker::locker::Locker;
use locker::token::TestToken;
use odra::casper_types::U256;
use odra::host::{HostEnv, NoArgs};
use odra::prelude::*;
use odra::schema::casper_contract_schema::NamedCLType;
use odra_cli::{
    deploy::DeployScript,
    scenario::{Args, Error, Scenario, ScenarioMetadata},
    CommandArg, ContractProvider, DeployedContractsContainer, DeployerExt, OdraCli,
};

const CSPR: u64 = 1_000_000_000;

/// Deploys `Locker`, and `TestToken` unless it is listed as deployed already.
pub struct LockerDeployScript;

impl DeployScript for LockerDeployScript {
    fn deploy(
        &self,
        env: &HostEnv,
        container: &mut DeployedContractsContainer,
    ) -> Result<(), odra_cli::deploy::Error> {
        Locker::load_or_deploy(env, NoArgs, container, 400 * CSPR)?;
        TestToken::load_or_deploy(env, NoArgs, container, 400 * CSPR)?;
        Ok(())
    }
}

/// Takes test tokens from the faucet and locks 100 of them for a few minutes.
pub struct DemoScenario;

impl Scenario for DemoScenario {
    fn args(&self) -> Vec<CommandArg> {
        vec![CommandArg::new(
            "minutes",
            "How long the tokens stay locked. 10 by default",
            NamedCLType::U64,
        )]
    }

    fn run(
        &self,
        env: &HostEnv,
        container: &DeployedContractsContainer,
        args: Args,
    ) -> Result<(), Error> {
        let mut token = container.contract_ref::<TestToken>(env)?;
        let mut locker = container.contract_ref::<Locker>(env)?;
        let minutes = args.get_single::<u64>("minutes").unwrap_or(10);
        let amount = U256::from(100 * CSPR);

        env.set_gas(5 * CSPR);
        token.try_faucet()?;
        env.set_gas(5 * CSPR);
        token.try_approve(&locker.address(), &amount)?;

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("the clock is set before 1970")
            .as_millis() as u64;
        let unlock_time = now + minutes * 60 * 1000;
        let id = locker.locks_count();
        env.set_gas(10 * CSPR);
        locker.try_lock(token.address(), amount, unlock_time)?;

        odra_cli::log(format!(
            "Created lock {id}: 100 TEST locked for {minutes} minutes"
        ));
        Ok(())
    }
}

impl ScenarioMetadata for DemoScenario {
    const NAME: &'static str = "demo";
    const DESCRIPTION: &'static str =
        "Takes test tokens from the faucet and locks 100 of them for a few minutes";
}

/// Runs the command line tool.
pub fn main() {
    OdraCli::new()
        .about("CLI tool for the liquidity locker")
        .deploy(LockerDeployScript)
        .contract::<Locker>()
        .contract::<TestToken>()
        .scenario(DemoScenario)
        .build()
        .run();
}
