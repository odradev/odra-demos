//! Command line tool of the streaming project: deploys the contracts and runs scenarios on a network.

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
use streaming::streaming::Streaming;
use streaming::token::TestToken;

const CSPR: u64 = 1_000_000_000;

/// Deploys `Streaming` and `TestToken`, or loads them if they are deployed already.
pub struct StreamingDeployScript;

impl DeployScript for StreamingDeployScript {
    fn deploy(
        &self,
        env: &HostEnv,
        container: &mut DeployedContractsContainer,
    ) -> Result<(), odra_cli::deploy::Error> {
        Streaming::load_or_deploy(env, NoArgs, container, 400 * CSPR)?;
        TestToken::load_or_deploy(env, NoArgs, container, 400 * CSPR)?;
        Ok(())
    }
}

/// Takes test tokens from the faucet, streams 100 of them over a few minutes and, when the caller
/// is the recipient, withdraws half of what has accrued by then.
pub struct DemoScenario;

impl Scenario for DemoScenario {
    fn args(&self) -> Vec<CommandArg> {
        vec![
            CommandArg::new(
                "recipient",
                "The account the tokens are paid to; the caller by default",
                NamedCLType::Key,
            ),
            CommandArg::new(
                "minutes",
                "How long the stream lasts; 10 by default",
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
        let mut streaming = container.contract_ref::<Streaming>(env)?;
        let recipient = args
            .get_single::<Address>("recipient")
            .unwrap_or(env.caller());
        let minutes = args.get_single::<u64>("minutes").unwrap_or(10);
        let deposit = U256::from(100 * CSPR);

        env.set_gas(5 * CSPR);
        token.try_faucet()?;
        env.set_gas(5 * CSPR);
        token.try_approve(&streaming.address(), &deposit)?;

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("the clock is set before 1970")
            .as_millis() as u64;
        let id = streaming.streams_count();
        env.set_gas(10 * CSPR);
        streaming.try_create_stream(
            recipient,
            token.address(),
            deposit,
            now,
            now + minutes * 60 * 1000,
        )?;
        odra_cli::log(format!(
            "Created stream {id}: 100 TEST to {recipient:?} over {minutes} minutes"
        ));

        // Only the recipient may withdraw, so this part runs when the caller streams to itself.
        if recipient == env.caller() {
            // Computed here rather than with `balance_of`: when the sender is the recipient,
            // `balance_of` adds the part that has not accrued yet, which is the sender's.
            let stream = streaming.stream(id);
            let elapsed = env.block_time().clamp(stream.start, stream.stop) - stream.start;
            let accrued =
                stream.deposit * U256::from(elapsed) / U256::from(stream.stop - stream.start);
            // Half of it: a withdrawal may take any part of what has accrued.
            let amount = accrued / 2;
            if !amount.is_zero() {
                env.set_gas(10 * CSPR);
                streaming.try_withdraw(id, amount)?;
                odra_cli::log(format!(
                    "Withdrew {amount} of the {accrued} units accrued in stream {id}"
                ));
            }
        }
        Ok(())
    }
}

impl ScenarioMetadata for DemoScenario {
    const NAME: &'static str = "demo";
    const DESCRIPTION: &'static str =
        "Takes test tokens from the faucet, streams 100 of them over a few minutes and withdraws part";
}

/// Runs the command line tool.
pub fn main() {
    OdraCli::new()
        .about("CLI tool for the streaming contract")
        .deploy(StreamingDeployScript)
        .contract::<Streaming>()
        .contract::<TestToken>()
        .scenario(DemoScenario)
        .build()
        .run();
}
