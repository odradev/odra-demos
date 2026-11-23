//! Command line tool of the multisend project: deploys the contracts and runs scenarios on a network.

use multisend::multisend::Multisend;
use multisend::token::TestToken;
use odra::casper_types::{U256, U512};
use odra::host::{HostEnv, HostRef, NoArgs};
use odra::prelude::*;
use odra::schema::casper_contract_schema::NamedCLType;
use odra_cli::{
    deploy::DeployScript,
    scenario::{Args, Error, Scenario, ScenarioMetadata},
    CommandArg, ContractProvider, DeployedContractsContainer, DeployerExt, OdraCli,
};

const CSPR: u64 = 1_000_000_000;

/// Deploys `Multisend` and `TestToken`, or loads them if they are deployed already.
pub struct MultisendDeployScript;

impl DeployScript for MultisendDeployScript {
    fn deploy(
        &self,
        env: &HostEnv,
        container: &mut DeployedContractsContainer,
    ) -> Result<(), odra_cli::deploy::Error> {
        Multisend::load_or_deploy(env, NoArgs, container, 400 * CSPR)?;
        TestToken::load_or_deploy(env, NoArgs, container, 400 * CSPR)?;
        Ok(())
    }
}

/// Sends test tokens, and CSPR if asked, to a list of recipients in one transaction each.
pub struct DemoScenario;

impl Scenario for DemoScenario {
    fn args(&self) -> Vec<CommandArg> {
        vec![
            CommandArg::new("recipient", "An account to send to", NamedCLType::Key)
                .list()
                .required(),
            CommandArg::new(
                "tokens",
                "Whole TEST tokens for each recipient; 10 by default",
                NamedCLType::U64,
            ),
            CommandArg::new(
                "cspr",
                "Motes of CSPR for each recipient; none by default",
                NamedCLType::U512,
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
        let mut multisend = container.contract_ref::<Multisend>(env)?;
        let recipients = args.get_many::<Address>("recipient")?;
        let count = recipients.len() as u64;
        let tokens = args.get_single::<u64>("tokens").unwrap_or(10);
        let cspr = args.get_single::<U512>("cspr").unwrap_or_default();

        let amount = U256::from(tokens) * U256::from(CSPR);
        let total = amount * U256::from(count);
        env.set_gas(5 * CSPR);
        token.try_faucet()?;
        env.set_gas(5 * CSPR);
        token.try_approve(&multisend.address(), &total)?;
        env.set_gas((5 + 2 * count) * CSPR);
        multisend.try_send_token(
            token.address(),
            recipients.clone(),
            vec![amount; recipients.len()],
        )?;
        odra_cli::log(format!("Sent {tokens} TEST to each of {count} recipients"));

        if !cspr.is_zero() {
            env.set_gas((10 + 3 * count) * CSPR);
            multisend
                .with_tokens(cspr * U512::from(count))
                .try_send_cspr(recipients.clone(), vec![cspr; recipients.len()])?;
            odra_cli::log(format!("Sent {cspr} motes to each of {count} recipients"));
        }
        Ok(())
    }
}

impl ScenarioMetadata for DemoScenario {
    const NAME: &'static str = "demo";
    const DESCRIPTION: &'static str =
        "Sends test tokens, and CSPR if asked, to a list of recipients in one transaction each";
}

/// Runs the command line tool.
pub fn main() {
    OdraCli::new()
        .about("CLI tool for the multisend contract")
        .deploy(MultisendDeployScript)
        .contract::<Multisend>()
        .contract::<TestToken>()
        .scenario(DemoScenario)
        .build()
        .run();
}
