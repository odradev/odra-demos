//! Command line tool of the crowdfunding project: deploys the contract and runs scenarios on a
//! network.

use std::time::{SystemTime, UNIX_EPOCH};

use crowdfunding::crowdfunding::Crowdfunding;
use crowdfunding::token::{TestToken, DECIMALS};
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
/// The gas limit of the deploy: a tenth above the 296.3 CSPR it uses on CasperVM. Unused gas is
/// refunded only in part, so a higher limit costs more.
const DEPLOY_GAS: u64 = 326 * CSPR;
/// Gas limits of the demo's calls, a round margin above what they use on CasperVM: 0.30
/// (`faucet`), 0.36 (`approve`), 0.90 (`create_campaign`), 1.82 (`pledge`) and 1.26 CSPR
/// (`claim`). 2.5 CSPR is the smallest limit the testnet takes for a contract call.
const CALL_GAS: u64 = 2_500_000_000;
const PLEDGE_GAS: u64 = 3 * CSPR;
/// How long after the deadline the scenario waits before claiming: the block that runs the claim
/// must be timed at or after the deadline, and block time lags the local clock.
const CLAIM_MARGIN: u64 = 60 * 1000;
const DAY: u64 = 24 * 60 * 60 * 1000;

/// Deploys `Crowdfunding`, or loads it if it is deployed already. `TestToken` is not deployed:
/// the one of the vesting project is reused, and it must be listed in the contracts file.
pub struct CrowdfundingDeployScript;

impl DeployScript for CrowdfundingDeployScript {
    fn deploy(
        &self,
        env: &HostEnv,
        container: &mut DeployedContractsContainer,
    ) -> Result<(), odra_cli::deploy::Error> {
        container.contract_ref::<TestToken>(env)?;
        Crowdfunding::load_or_deploy(env, NoArgs, container, DEPLOY_GAS)?;
        Ok(())
    }
}

/// The local clock, in milliseconds since the Unix epoch, like block time.
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("the clock is set before 1970")
        .as_millis() as u64
}

/// Whole TEST tokens in the smallest unit.
fn tokens(whole: u64) -> U256 {
    U256::from(whole) * U256::from(10u64.pow(DECIMALS as u32))
}

/// Starts two campaigns and backs both; run again after the first one's deadline, it claims it.
pub struct DemoScenario;

impl Scenario for DemoScenario {
    fn args(&self) -> Vec<CommandArg> {
        vec![CommandArg::new(
            "minutes",
            "Minutes until the deadline of the campaign that reaches its goal; 3 by default",
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
        let mut crowdfunding = container.contract_ref::<Crowdfunding>(env)?;
        let me = env.caller();

        // A campaign of the caller that reached its goal and was not claimed: claim it once its
        // deadline has passed. Nothing is sent before that.
        for id in crowdfunding.try_campaigns_of_creator(me)?.into_iter().rev() {
            let campaign = crowdfunding.try_campaign(id)?;
            if campaign.claimed || campaign.pledged < campaign.goal {
                continue;
            }
            let ready_at = campaign.deadline + CLAIM_MARGIN;
            let now = now();
            if now < ready_at {
                odra_cli::log(format!(
                    "Campaign {id} reached its goal; it can be claimed in {} seconds. \
                     Run the scenario again then.",
                    (ready_at - now).div_ceil(1000)
                ));
                return Ok(());
            }
            env.set_gas(CALL_GAS);
            crowdfunding.try_claim(id)?;
            odra_cli::log(format!(
                "Claimed campaign {id}: {} TEST went to the creator.",
                campaign.pledged / tokens(1)
            ));
            return Ok(());
        }

        let minutes = args.get_single::<u64>("minutes").unwrap_or(3);
        let funded_goal = tokens(100);
        let open_goal = tokens(1000);
        let open_pledge = tokens(40);
        let needed = funded_goal + open_pledge;

        if token.try_balance_of(&me)? < needed {
            env.set_gas(CALL_GAS);
            token.try_faucet()?;
        }
        env.set_gas(CALL_GAS);
        token.try_approve(&crowdfunding.address(), &needed)?;

        let first = crowdfunding.try_campaigns_count()?;
        let now = now();
        env.set_gas(CALL_GAS);
        crowdfunding.try_create_campaign(
            token.address(),
            String::from("A coffee machine for the hackerspace"),
            funded_goal,
            now + minutes * 60 * 1000,
        )?;
        env.set_gas(PLEDGE_GAS);
        crowdfunding.try_pledge(first, funded_goal)?;

        env.set_gas(CALL_GAS);
        crowdfunding.try_create_campaign(
            token.address(),
            String::from("A community garden by the river"),
            open_goal,
            now + 14 * DAY,
        )?;
        env.set_gas(PLEDGE_GAS);
        crowdfunding.try_pledge(first + 1, open_pledge)?;

        odra_cli::log(format!(
            "Created campaign {first}, backed with its whole goal of 100 TEST, ending in {minutes} \
             minutes, and campaign {}, backed with 40 of 1,000 TEST, ending in 14 days. \
             Run the scenario again after the first one ends to claim it.",
            first + 1
        ));
        Ok(())
    }
}

impl ScenarioMetadata for DemoScenario {
    const NAME: &'static str = "demo";
    const DESCRIPTION: &'static str =
        "Starts two campaigns and backs both; run again after the first one ends to claim it";
}

/// Runs the command line tool.
pub fn main() {
    OdraCli::new()
        .about("CLI tool for the crowdfunding contract")
        .deploy(CrowdfundingDeployScript)
        .contract::<Crowdfunding>()
        .contract::<TestToken>()
        .scenario(DemoScenario)
        .build()
        .run();
}
