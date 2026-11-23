//! Command line tool of the vesting project: deploys the contracts and runs scenarios on a network.

use std::time::{SystemTime, UNIX_EPOCH};

use odra::casper_types::U256;
use odra::host::{HostEnv, NoArgs};
use odra::prelude::*;
use odra::schema::casper_contract_schema::NamedCLType;
use odra_cli::{
    deploy::DeployScript,
    scenario::{Args, Error, Scenario, ScenarioMetadata},
    CommandArg, ContractProvider, DeployedContractsContainer, DeployerExt, OdraCli,
};
use vesting::token::TestToken;
use vesting::vesting::Vesting;

const CSPR: u64 = 1_000_000_000;

/// Deploys `Vesting` and `TestToken`, or loads them if they are deployed already.
pub struct VestingDeployScript;

impl DeployScript for VestingDeployScript {
    fn deploy(
        &self,
        env: &HostEnv,
        container: &mut DeployedContractsContainer,
    ) -> Result<(), odra_cli::deploy::Error> {
        Vesting::load_or_deploy(env, NoArgs, container, 400 * CSPR)?;
        TestToken::load_or_deploy(env, NoArgs, container, 400 * CSPR)?;
        Ok(())
    }
}

/// Takes test tokens from the faucet and vests 100 of them over a few minutes.
pub struct DemoScenario;

impl Scenario for DemoScenario {
    fn args(&self) -> Vec<CommandArg> {
        vec![
            CommandArg::new(
                "beneficiary",
                "The account that receives the tokens; the caller by default",
                NamedCLType::Key,
            ),
            CommandArg::new(
                "minutes",
                "How long the schedule lasts; the cliff is a fifth of it. 10 by default",
                NamedCLType::U64,
            ),
        ]
    }

    fn run(
        &self,
        env: &HostEnv,
        container: &DeployedContractsContainer,
        args: Args,
    ) -> Result<(), Error> {
        let mut token = container.contract_ref::<TestToken>(env)?;
        let mut vesting = container.contract_ref::<Vesting>(env)?;
        let beneficiary = args
            .get_single::<Address>("beneficiary")
            .unwrap_or(env.caller());
        let minutes = args.get_single::<u64>("minutes").unwrap_or(10);
        let amount = U256::from(100 * CSPR);

        env.set_gas(5 * CSPR);
        token.try_faucet()?;
        env.set_gas(5 * CSPR);
        token.try_approve(&vesting.address(), &amount)?;

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("the clock is set before 1970")
            .as_millis() as u64;
        let duration = minutes * 60 * 1000;
        env.set_gas(10 * CSPR);
        let id = vesting.schedules_count();
        vesting.try_create_schedule(
            beneficiary,
            token.address(),
            amount,
            now,
            now + duration / 5,
            now + duration,
            true,
        )?;

        odra_cli::log(format!(
            "Created schedule {id}: 100 TEST for {beneficiary:?} over {minutes} minutes"
        ));
        Ok(())
    }
}

impl ScenarioMetadata for DemoScenario {
    const NAME: &'static str = "demo";
    const DESCRIPTION: &'static str =
        "Takes test tokens from the faucet and vests 100 of them over a few minutes";
}

/// Runs the command line tool.
pub fn main() {
    OdraCli::new()
        .about("CLI tool for the vesting contract")
        .deploy(VestingDeployScript)
        .contract::<Vesting>()
        .contract::<TestToken>()
        .scenario(DemoScenario)
        .build()
        .run();
}
