//! Command line tool of the OTC swap project: deploys the contracts and runs a scenario on a
//! network.

use std::time::{SystemTime, UNIX_EPOCH};

use odra::casper_types::Key;
use odra::host::{HostEnv, NoArgs};
use odra::prelude::*;
use odra::schema::casper_contract_schema::NamedCLType;
use odra_cli::{
    deploy::DeployScript,
    scenario::{Args, Error, Scenario, ScenarioMetadata},
    CommandArg, ContractProvider, DeployedContractsContainer, DeployerExt, OdraCli,
};
use otc_swap::demo::{self, gas};
use otc_swap::swap::OtcSwap;
use otc_swap::token::{TestDollar, TestToken};

const DAY: u64 = 24 * 60 * 60 * 1000;

/// Deploys `OtcSwap` and `TestDollar`, or loads them if they are deployed already. `TestToken`
/// is not deployed: the one of the vesting project is reused, and it must be listed in the
/// contracts file.
pub struct SwapDeployScript;

impl DeployScript for SwapDeployScript {
    fn deploy(
        &self,
        env: &HostEnv,
        container: &mut DeployedContractsContainer,
    ) -> Result<(), odra_cli::deploy::Error> {
        container.contract_ref::<TestToken>(env)?;
        TestDollar::load_or_deploy(env, NoArgs, container, gas::DEPLOY_TOKEN)?;
        OtcSwap::load_or_deploy(env, NoArgs, container, gas::DEPLOY)?;
        Ok(())
    }
}

/// Offers TEST for TUSD to anyone and takes the offer; then makes an offer for one account only
/// and cancels it.
pub struct DemoScenario;

impl Scenario for DemoScenario {
    fn args(&self) -> Vec<CommandArg> {
        vec![CommandArg::new(
            "taker",
            "The only account that may take the second offer; a made-up account by default",
            NamedCLType::Key,
        )]
    }

    fn run(
        &self,
        env: &HostEnv,
        container: &DeployedContractsContainer,
        args: Args,
    ) -> Result<(), Error> {
        let mut test = container.contract_ref::<TestToken>(env)?;
        let dollar = container.contract_ref::<TestDollar>(env)?;
        let mut swap = container.contract_ref::<OtcSwap>(env)?;
        let other = args
            .get_single::<Address>("taker")
            .unwrap_or_else(|_| demo::made_up_taker());

        let outcome = demo::run(&mut test, &dollar, &mut swap, other, now() + DAY)?;
        odra_cli::log(format!(
            "Offer {}: 100 TEST for 250 TUSD, open to anyone, taken by you",
            outcome.taken
        ));
        odra_cli::log(format!(
            "Offer {}: 50 TEST for 120 TUSD, only for {}, cancelled: the TEST came back",
            outcome.cancelled,
            Key::from(other).to_formatted_string()
        ));
        Ok(())
    }
}

impl ScenarioMetadata for DemoScenario {
    const NAME: &'static str = "demo";
    const DESCRIPTION: &'static str =
        "Offers TEST for TUSD to anyone and takes it, then makes an offer for one account and cancels it";
}

/// The milliseconds since the Unix epoch, by the local clock, like block time.
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("the clock is set before 1970")
        .as_millis() as u64
}

/// Runs the command line tool.
pub fn main() {
    OdraCli::new()
        .about("CLI tool for the OTC swap contract")
        .deploy(SwapDeployScript)
        .contract::<OtcSwap>()
        .contract::<TestToken>()
        .contract::<TestDollar>()
        .scenario(DemoScenario)
        .build()
        .run();
}
