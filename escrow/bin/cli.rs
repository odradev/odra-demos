//! Command line tool of the escrow project: deploys the contract and runs a scenario on a network.

use std::time::{SystemTime, UNIX_EPOCH};

use escrow::escrow::Escrow;
use escrow::token::TestToken;
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
/// One whole TEST in its smallest unit: the token has 9 decimals.
const TEST: u64 = 1_000_000_000;

/// Gas limits, in motes: what each call consumed on CasperVM (the `demo_scenario` test of
/// `src/escrow.rs`, run with `ODRA_BACKEND=casper`) with a margin. The network refunds three
/// quarters of what a limit leaves unused; a failed transaction is charged its whole limit.
/// 2.5 CSPR is the practical minimum of a contract call.
///
/// Deploying `Escrow` consumed 289.3 CSPR.
const DEPLOY_GAS: u64 = 320 * CSPR;
/// `faucet` consumed 0.30 CSPR, `approve` 0.36.
const TOKEN_GAS: u64 = 2_500_000_000;
/// `create_deal` consumed 2.29 to 2.37 CSPR; it grows a little with the lists of the parties.
const CREATE_GAS: u64 = 4 * CSPR;
/// `release` consumed 1.24 CSPR.
const RELEASE_GAS: u64 = 2_500_000_000;
/// `open_dispute` consumed 0.50 CSPR.
const DISPUTE_GAS: u64 = 2_500_000_000;
/// `resolve` with a split, two transfers, consumed 2.02 CSPR.
const RESOLVE_GAS: u64 = 3_500_000_000;

/// Deploys `Escrow`, or loads it if it is deployed already. `TestToken` is loaded from the
/// contracts file, where the one of the vesting project is listed.
pub struct EscrowDeployScript;

impl DeployScript for EscrowDeployScript {
    fn deploy(
        &self,
        env: &HostEnv,
        container: &mut DeployedContractsContainer,
    ) -> Result<(), odra_cli::deploy::Error> {
        Escrow::load_or_deploy(env, NoArgs, container, DEPLOY_GAS)?;
        TestToken::load_or_deploy(env, NoArgs, container, 400 * CSPR)?;
        Ok(())
    }
}

/// Opens two deals of 100 TEST with the caller as the buyer. The first one the caller releases to
/// the seller. On the second one the caller opens a dispute and, when it is the arbiter too,
/// decides it: half to the seller, half back.
pub struct DemoScenario;

impl Scenario for DemoScenario {
    fn args(&self) -> Vec<CommandArg> {
        vec![
            CommandArg::new(
                "seller",
                "The account the tokens are for; the caller by default",
                NamedCLType::Key,
            ),
            CommandArg::new(
                "arbiter",
                "The account that decides a dispute; the caller by default",
                NamedCLType::Key,
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
        let mut escrow = container.contract_ref::<Escrow>(env)?;
        let caller = env.caller();
        let seller = args.get_single::<Address>("seller").unwrap_or(caller);
        let arbiter = args.get_single::<Address>("arbiter").unwrap_or(caller);
        let amount = U256::from(100 * TEST);
        let deadline = now() + 24 * 60 * 60 * 1000;

        // Tokens and an allowance for both deals, asked for only when missing.
        if token.balance_of(&caller) < amount * 2 {
            env.set_gas(TOKEN_GAS);
            token.try_faucet()?;
        }
        if token.allowance(&caller, &escrow.address()) < amount * 2 {
            env.set_gas(TOKEN_GAS);
            token.try_approve(&escrow.address(), &(amount * 2))?;
        }

        let released = escrow.deals_count();
        env.set_gas(CREATE_GAS);
        escrow.try_create_deal(seller, arbiter, token.address(), amount, deadline)?;
        env.set_gas(RELEASE_GAS);
        escrow.try_release(released)?;
        odra_cli::log(format!("Deal {released}: 100 TEST released to {seller:?}"));

        let disputed = escrow.deals_count();
        env.set_gas(CREATE_GAS);
        escrow.try_create_deal(seller, arbiter, token.address(), amount, deadline)?;
        env.set_gas(DISPUTE_GAS);
        escrow.try_open_dispute(disputed)?;
        if arbiter == caller {
            env.set_gas(RESOLVE_GAS);
            escrow.try_resolve(disputed, amount / 2)?;
            odra_cli::log(format!(
                "Deal {disputed}: disputed, and split 50 TEST to the seller, 50 TEST back"
            ));
        } else {
            odra_cli::log(format!("Deal {disputed}: disputed; {arbiter:?} decides it"));
        }
        Ok(())
    }
}

impl ScenarioMetadata for DemoScenario {
    const NAME: &'static str = "demo";
    const DESCRIPTION: &'static str =
        "Opens two deals of 100 TEST: releases one, disputes the other and decides it as the arbiter";
}

/// The milliseconds since the Unix epoch, by the local clock.
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("the clock is set before 1970")
        .as_millis() as u64
}

/// Runs the command line tool.
pub fn main() {
    OdraCli::new()
        .about("CLI tool for the escrow contract")
        .deploy(EscrowDeployScript)
        .contract::<Escrow>()
        .contract::<TestToken>()
        .scenario(DemoScenario)
        .build()
        .run();
}
