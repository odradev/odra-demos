//! Command line tool of the curve project: deploys the token and runs scenarios on a network.

use curve::curve::Curve;
use curve::demo::{self, gas};
use odra::casper_types::U512;
use odra::host::HostEnv;
use odra::prelude::*;
use odra::schema::casper_contract_schema::NamedCLType;
use odra_cli::{
    deploy::DeployScript,
    scenario::{Args, Error, Scenario, ScenarioMetadata},
    CommandArg, ContractProvider, DeployedContractsContainer, DeployerExt, OdraCli,
};

const CSPR: u64 = 1_000_000_000;

/// Deploys `Curve` with the curve of `demo::init_args`, or loads it if it is deployed already.
pub struct CurveDeployScript;

impl DeployScript for CurveDeployScript {
    fn deploy(
        &self,
        env: &HostEnv,
        container: &mut DeployedContractsContainer,
    ) -> Result<(), odra_cli::deploy::Error> {
        Curve::load_or_deploy(env, demo::init_args(), container, gas::DEPLOY)?;
        Ok(())
    }
}

/// Formats motes or 9-decimal token units with four fraction digits.
fn whole(units: impl ToString) -> String {
    let digits = format!("{:0>10}", units.to_string());
    let (int, fraction) = digits.split_at(digits.len() - 9);
    format!("{int}.{}", &fraction[..4])
}

/// Buys tokens with CSPR, then sells half of them back.
pub struct DemoScenario;

impl Scenario for DemoScenario {
    fn args(&self) -> Vec<CommandArg> {
        vec![CommandArg::new(
            "cspr",
            "Whole CSPR to spend on the purchase; 10 by default",
            NamedCLType::U64,
        )]
    }

    fn run(
        &self,
        env: &HostEnv,
        container: &DeployedContractsContainer,
        args: Args,
    ) -> Result<(), Error> {
        let mut curve = container.contract_ref::<Curve>(env)?;
        let spend = args
            .get_single::<u64>("cspr")
            .map(|cspr| cspr * CSPR)
            .unwrap_or(demo::CSPR_TO_SPEND);

        let outcome = demo::run(&mut curve, U512::from(spend))?;
        odra_cli::log(format!(
            "Bought {} CURVE for {} CSPR, sold {} back for {} CSPR. The reserve holds {} CSPR; \
             a token costs {} CSPR now.",
            whole(outcome.bought),
            whole(outcome.paid),
            whole(outcome.sold),
            whole(outcome.received),
            whole(outcome.reserve),
            whole(curve.try_price()?),
        ));
        Ok(())
    }
}

impl ScenarioMetadata for DemoScenario {
    const NAME: &'static str = "demo";
    const DESCRIPTION: &'static str = "Buys tokens with CSPR, then sells half of them back";
}

/// Runs the command line tool.
pub fn main() {
    OdraCli::new()
        .about("CLI tool for the bonding curve token")
        .deploy(CurveDeployScript)
        .contract::<Curve>()
        .scenario(DemoScenario)
        .build()
        .run();
}
