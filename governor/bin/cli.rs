//! Command line tool of the governor project: deploys the governor and runs the demo on a network.

use std::time::{SystemTime, UNIX_EPOCH};

use governor::fee_config::{FeeConfig, FeeConfigHostRef};
use governor::governor::{Governor, GovernorHostRef, GovernorInitArgs, Proposal};
use governor::timelock::Timelock;
use governor::token::TestToken;
use odra::casper_types::U256;
use odra::host::HostEnv;
use odra::prelude::*;
use odra::schema::casper_contract_schema::NamedCLType;
use odra_cli::{
    deploy::DeployScript,
    scenario::{Args, Error, Scenario, ScenarioMetadata},
    CommandArg, ContractProvider, DeployedContractsContainer, DeployerExt, OdraCli,
};

const CSPR: u64 = 1_000_000_000;
/// One whole TEST in its smallest unit: the token has 9 decimals.
const TEST: u64 = 1_000_000_000;

/// How long voting on a proposal lasts in the demo deployment: three minutes.
const DEMO_VOTING_PERIOD: u64 = 3 * 60 * 1000;
/// The tokens in favour a proposal needs to pass in the demo deployment: 500 TEST.
const DEMO_QUORUM: u64 = 500 * TEST;
/// The tokens an account must hold to propose in the demo deployment: 100 TEST, a tenth of what
/// one faucet call gives.
const DEMO_PROPOSAL_THRESHOLD: u64 = 100 * TEST;

/// The gas limit of the deploy: about a tenth above the 309.8 CSPR it uses on CasperVM. Unused
/// gas is refunded only in part, so a looser limit costs more.
const GOVERNOR_DEPLOY_GAS: u64 = 341 * CSPR;

/// Gas limits of the demo's transactions: what each uses on CasperVM (in the comment) with room
/// to spare. Below 2.5 CSPR a lower limit saves next to nothing.
const FAUCET_GAS: u64 = 5 * CSPR / 2; // 0.30
const APPROVE_GAS: u64 = 5 * CSPR / 2; // 0.36
const PROPOSE_GAS: u64 = 5 * CSPR / 2; // 0.90
const VOTE_GAS: u64 = 3 * CSPR; // 1.58
const QUEUE_GAS: u64 = 7 * CSPR / 2; // 2.11
const EXECUTE_GAS: u64 = 3 * CSPR; // 1.81
const WITHDRAW_GAS: u64 = 5 * CSPR / 2; // 1.12

/// How long after a moment by the local clock the scenario waits before sending a transaction
/// that needs the moment to have passed: the time of the next block can lag this computer's clock.
const CLOCK_MARGIN: u64 = 20 * 1000;

/// Deploys the governor over the `Timelock`, `FeeConfig` and `TestToken` that are deployed
/// already. They must be listed in the contracts file (`resources/casper-test-contracts.toml`):
/// this script never deploys them.
pub struct GovernorDeployScript;

impl DeployScript for GovernorDeployScript {
    fn deploy(
        &self,
        env: &HostEnv,
        container: &mut DeployedContractsContainer,
    ) -> Result<(), odra_cli::deploy::Error> {
        let token = container.contract_ref::<TestToken>(env)?;
        let timelock = container.contract_ref::<Timelock>(env)?;
        let fee_config = container.contract_ref::<FeeConfig>(env)?;
        Governor::load_or_deploy(
            env,
            GovernorInitArgs {
                token: token.address(),
                timelock: timelock.address(),
                fee_config: fee_config.address(),
                voting_period: DEMO_VOTING_PERIOD,
                quorum: U256::from(DEMO_QUORUM),
                proposal_threshold: U256::from(DEMO_PROPOSAL_THRESHOLD),
            },
            container,
            GOVERNOR_DEPLOY_GAS,
        )?;
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

/// Seconds until the scenario will act on `moment`: the moment plus the clock margin.
fn seconds_until(moment: u64) -> u64 {
    (moment + CLOCK_MARGIN).saturating_sub(now()).div_ceil(1000)
}

/// Proposes a fee and votes for it with 1,000 TEST; run again, it takes the next step.
pub struct DemoScenario;

impl Scenario for DemoScenario {
    fn args(&self) -> Vec<CommandArg> {
        vec![CommandArg::new(
            "fee_bps",
            "The fee to propose, in basis points; 250 (2.5%) by default",
            NamedCLType::U32,
        )]
    }

    fn run(
        &self,
        env: &HostEnv,
        container: &DeployedContractsContainer,
        args: Args,
    ) -> Result<(), Error> {
        let mut governor = container.contract_ref::<Governor>(env)?;
        let mut token = container.contract_ref::<TestToken>(env)?;
        let config = container.contract_ref::<FeeConfig>(env)?;
        let me = env.caller();
        odra_cli::log(format!(
            "The fee is {} basis points.",
            config.try_fee_bps()?
        ));

        // The last proposal, if this account made it and the demo is not done with it.
        let count = governor.try_proposals_count()?;
        if count > 0 {
            let id = count - 1;
            let proposal = governor.try_proposal(id)?;
            let deposit = governor
                .try_ballot(id, me)?
                .is_some_and(|ballot| !ballot.withdrawn);
            let open = deposit || (proposal.queued && !proposal.executed);
            if proposal.proposer == me && open {
                return next_step(env, &mut governor, &config, id, &proposal, deposit);
            }
        }

        // A new round: tokens, a proposal and a vote for it.
        let amount = TestToken::faucet_amount();
        if token.try_balance_of(&me)? < amount {
            env.set_gas(FAUCET_GAS);
            token.try_faucet()?;
            odra_cli::log("Took 1,000 TEST from the faucet.");
        }
        if token.try_allowance(&me, &governor.address())? < amount {
            env.set_gas(APPROVE_GAS);
            token.try_approve(&governor.address(), &amount)?;
            odra_cli::log("Let the governor take 1,000 TEST.");
        }
        let fee_bps = args.get_single::<u32>("fee_bps").unwrap_or(250);
        env.set_gas(PROPOSE_GAS);
        governor.try_propose(fee_bps)?;
        odra_cli::log(format!(
            "Proposed {count}: set the fee to {fee_bps} basis points."
        ));
        env.set_gas(VOTE_GAS);
        governor.try_vote(count, true, amount)?;
        let vote_end = governor.try_proposal(count)?.vote_end;
        odra_cli::log(format!(
            "Voted for proposal {count} with 1,000 TEST. Run the scenario again in {} seconds to \
             queue it.",
            seconds_until(vote_end)
        ));
        Ok(())
    }
}

/// Takes the next step with a proposal of the caller: queue it, execute it, take the tokens back.
fn next_step(
    env: &HostEnv,
    governor: &mut GovernorHostRef,
    config: &FeeConfigHostRef,
    id: u64,
    proposal: &Proposal,
    deposit: bool,
) -> Result<(), Error> {
    if now() < proposal.vote_end + CLOCK_MARGIN {
        odra_cli::log(format!(
            "Voting on proposal {id} is open. Run the scenario again in {} seconds.",
            seconds_until(proposal.vote_end)
        ));
        return Ok(());
    }

    // The rule of the contract, on the local clock: a view would use the time of the last block.
    let passed = proposal.votes_for >= U256::from(DEMO_QUORUM)
        && proposal.votes_for > proposal.votes_against;
    if passed && !proposal.queued {
        env.set_gas(QUEUE_GAS);
        governor.try_queue(id)?;
        let ready_at = governor.try_proposal(id)?.ready_at;
        odra_cli::log(format!(
            "Queued proposal {id} in the timelock. Run the scenario again in {} seconds to \
             execute it.",
            seconds_until(ready_at)
        ));
        return Ok(());
    }

    if proposal.queued && !proposal.executed {
        if now() < proposal.ready_at + CLOCK_MARGIN {
            odra_cli::log(format!(
                "Proposal {id} waits in the timelock. Run the scenario again in {} seconds.",
                seconds_until(proposal.ready_at)
            ));
            return Ok(());
        }
        env.set_gas(EXECUTE_GAS);
        governor.try_execute(id)?;
        odra_cli::log(format!(
            "Executed proposal {id}. The fee is {} basis points now.",
            config.try_fee_bps()?
        ));
    } else if !passed {
        odra_cli::log(format!("Proposal {id} did not pass."));
    }

    if deposit {
        env.set_gas(WITHDRAW_GAS);
        governor.try_withdraw(id)?;
        odra_cli::log(format!("Took back the TEST deposited on proposal {id}."));
    }
    Ok(())
}

impl ScenarioMetadata for DemoScenario {
    const NAME: &'static str = "demo";
    const DESCRIPTION: &'static str =
        "Proposes a fee and votes for it; run again to queue it, and again to execute it";
}

/// Runs the command line tool.
pub fn main() {
    OdraCli::new()
        .about("CLI tool for the governor contract")
        .deploy(GovernorDeployScript)
        .contract::<Governor>()
        .contract::<Timelock>()
        .contract::<FeeConfig>()
        .contract::<TestToken>()
        .scenario(DemoScenario)
        .build()
        .run();
}
