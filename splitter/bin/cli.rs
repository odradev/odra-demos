//! Command line tool of the splitter project: deploys the contracts and runs scenarios on a network.

use odra::casper_types::U256;
use odra::host::{HostEnv, NoArgs};
use odra::prelude::*;
use odra::schema::casper_contract_schema::NamedCLType;
use odra_cli::{
    deploy::DeployScript,
    scenario::{Args, Error, Scenario, ScenarioMetadata},
    CommandArg, ContractProvider, DeployedContractsContainer, DeployerExt, OdraCli,
};
use splitter::demo::{self, gas};
use splitter::splitter::Splitter;
use splitter::token::TestToken;

const CSPR: u64 = 1_000_000_000;

/// Deploys `Splitter`, and `TestToken` unless the contracts file names one already.
pub struct SplitterDeployScript;

impl DeployScript for SplitterDeployScript {
    fn deploy(
        &self,
        env: &HostEnv,
        container: &mut DeployedContractsContainer,
    ) -> Result<(), odra_cli::deploy::Error> {
        Splitter::load_or_deploy(env, NoArgs, container, gas::DEPLOY)?;
        TestToken::load_or_deploy(env, NoArgs, container, 400 * CSPR)?;
        Ok(())
    }
}

/// Splits test tokens between the caller and another account, and withdraws the caller's part.
pub struct DemoScenario;

impl Scenario for DemoScenario {
    fn args(&self) -> Vec<CommandArg> {
        vec![
            CommandArg::new(
                "payee",
                "The other payee, with one share to the caller's three; a made-up account by default",
                NamedCLType::Key,
            ),
            CommandArg::new(
                "tokens",
                "Whole TEST tokens to pay into the split; 100 by default",
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
        let mut splitter = container.contract_ref::<Splitter>(env)?;
        let other = args
            .get_single::<Address>("payee")
            .unwrap_or_else(|_| demo::made_up_payee());
        let tokens = args.get_single::<u64>("tokens").unwrap_or(100);
        let amount = U256::from(tokens) * U256::from(CSPR);

        let outcome = demo::run(&mut token, &mut splitter, other, amount)?;
        odra_cli::log(format!(
            "Split {}: paid in {tokens} TEST, withdrew your three quarters ({} units); {} units wait for {other:?}",
            outcome.split_id, outcome.withdrawn, outcome.left_for_other
        ));
        Ok(())
    }
}

impl ScenarioMetadata for DemoScenario {
    const NAME: &'static str = "demo";
    const DESCRIPTION: &'static str =
        "Splits test tokens between the caller and another account, and withdraws the caller's part";
}

/// Runs the command line tool.
pub fn main() {
    OdraCli::new()
        .about("CLI tool for the splitter contract")
        .deploy(SplitterDeployScript)
        .contract::<Splitter>()
        .contract::<TestToken>()
        .scenario(DemoScenario)
        .build()
        .run();
}
