//! Command line tool of the timelock project: deploys the contracts and runs scenarios on a network.

use std::time::{SystemTime, UNIX_EPOCH};

use odra::casper_types::bytesrepr::{Bytes, ToBytes};
use odra::casper_types::{runtime_args, CLValue, RuntimeArgs};
use odra::host::HostEnv;
use odra::prelude::*;
use odra::schema::casper_contract_schema::NamedCLType;
use odra::schema::codec;
use odra_cli::{
    deploy::DeployScript,
    scenario::{Args, Error, Scenario, ScenarioMetadata},
    CommandArg, ContractProvider, DeployedContractsContainer, DeployerExt, OdraCli,
};
use timelock::fee_config::{FeeConfig, FeeConfigInitArgs};
use timelock::timelock::{anyone, Timelock, TimelockInitArgs};

const CSPR: u64 = 1_000_000_000;
/// The minimum delay of the demo deployment: one minute.
const DEMO_MIN_DELAY: u64 = 60 * 1000;
/// The fee the demo deployment starts with: 100 basis points, 1%.
const DEMO_FEE_BPS: u32 = 100;

/// Deploys `Timelock`, then `FeeConfig` owned by it, or loads them if they are deployed already.
///
/// The demo timelock lets anyone propose and execute, so visitors of the web app can try it;
/// the deployer may cancel. A real deployment lists its own proposers and executors.
pub struct TimelockDeployScript;

impl DeployScript for TimelockDeployScript {
    fn deploy(
        &self,
        env: &HostEnv,
        container: &mut DeployedContractsContainer,
    ) -> Result<(), odra_cli::deploy::Error> {
        let timelock = Timelock::load_or_deploy(
            env,
            TimelockInitArgs {
                min_delay: DEMO_MIN_DELAY,
                proposers: vec![anyone()],
                executors: vec![anyone()],
                cancellers: vec![env.caller()],
            },
            container,
            TIMELOCK_DEPLOY_GAS,
        )?;
        FeeConfig::load_or_deploy(
            env,
            FeeConfigInitArgs {
                owner: timelock.address(),
                fee_bps: DEMO_FEE_BPS,
            },
            container,
            FEE_CONFIG_DEPLOY_GAS,
        )?;
        Ok(())
    }
}

/// Gas limits of the two deploys. Unused gas is refunded only in part, so they are set close
/// to what the deploys need; see "Deploying to the testnet" in the README.
const TIMELOCK_DEPLOY_GAS: u64 = 345 * CSPR;
const FEE_CONFIG_DEPLOY_GAS: u64 = 275 * CSPR;

/// The local clock, in milliseconds since the Unix epoch, like block time.
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("the clock is set before 1970")
        .as_millis() as u64
}

/// Proposes a fee change through the timelock; run again once the delay has passed, it executes it.
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
        let mut timelock = container.contract_ref::<Timelock>(env)?;
        let config = container.contract_ref::<FeeConfig>(env)?;
        odra_cli::log(format!(
            "The fee is {} basis points.",
            config.try_fee_bps()?
        ));

        // A fee change proposed before and still open: execute it once its delay has passed.
        let count = timelock.try_operations_count()?;
        if count > 0 {
            let id = count - 1;
            let operation = timelock.try_operation(id)?;
            let open = !operation.executed && !operation.cancelled;
            if open && operation.target == config.address() && operation.entry_point == "set_fee" {
                let now = now();
                if now < operation.ready_at {
                    odra_cli::log(format!(
                        "Operation {id} can be executed in {} seconds. Run the scenario again then.",
                        (operation.ready_at - now).div_ceil(1000)
                    ));
                    return Ok(());
                }
                env.set_gas(10 * CSPR);
                timelock.try_execute(id)?;
                odra_cli::log(format!(
                    "Executed operation {id}. The fee is {} basis points now.",
                    config.try_fee_bps()?
                ));
                return Ok(());
            }
        }

        let fee_bps = args.get_single::<u32>("fee_bps").unwrap_or(250);
        let delay = timelock.try_min_delay()?;
        env.set_gas(5 * CSPR);
        timelock.try_schedule(
            config.address(),
            "set_fee".to_string(),
            serialize(runtime_args! { "fee_bps" => fee_bps }),
            delay,
        )?;
        odra_cli::log(format!(
            "Proposed operation {count}: set the fee to {fee_bps} basis points. \
             Run the scenario again in {} seconds to execute it.",
            delay.div_ceil(1000)
        ));
        Ok(())
    }
}

impl ScenarioMetadata for DemoScenario {
    const NAME: &'static str = "demo";
    const DESCRIPTION: &'static str =
        "Proposes a fee change through the timelock; run again after the delay to execute it";
}

/// Proposes a call of any entry point of any contract through the timelock.
pub struct ProposeScenario;

/// The types `--arg` accepts.
fn arg_type(name: &str) -> Option<NamedCLType> {
    Some(match name {
        "bool" => NamedCLType::Bool,
        "u8" => NamedCLType::U8,
        "u32" => NamedCLType::U32,
        "u64" => NamedCLType::U64,
        "u128" => NamedCLType::U128,
        "u256" => NamedCLType::U256,
        "u512" => NamedCLType::U512,
        "i32" => NamedCLType::I32,
        "i64" => NamedCLType::I64,
        "string" => NamedCLType::String,
        "key" | "address" => NamedCLType::Key,
        "public_key" => NamedCLType::PublicKey,
        _ => return None,
    })
}

/// Reads `name:type=value` into a named argument of `args`.
fn parse_arg(text: &str, args: &mut RuntimeArgs) -> Result<(), Error> {
    let invalid = |reason: &str| Error::OdraError {
        message: format!("--arg {text}: {reason}"),
    };
    let (name, rest) = text
        .split_once(':')
        .ok_or_else(|| invalid("expected name:type=value"))?;
    let (ty, value) = rest
        .split_once('=')
        .ok_or_else(|| invalid("expected name:type=value"))?;
    let ty = arg_type(ty).ok_or_else(|| {
        invalid("the type is one of bool, u8, u32, u64, u128, u256, u512, i32, i64, string, key, public_key")
    })?;
    let bytes = codec::into_bytes(&ty, value).map_err(|e| invalid(&e.to_string()))?;
    args.insert_cl_value(
        name,
        CLValue::from_components(codec::named_cl_type_to_cl_type(&ty), bytes),
    );
    Ok(())
}

fn serialize(args: RuntimeArgs) -> Bytes {
    Bytes::from(args.to_bytes().expect("arguments serialize"))
}

impl Scenario for ProposeScenario {
    fn args(&self) -> Vec<CommandArg> {
        vec![
            CommandArg::new("target", "The contract to call", NamedCLType::Key).required(),
            CommandArg::new(
                "entry_point",
                "The entry point of the contract to call",
                NamedCLType::String,
            )
            .required(),
            CommandArg::new(
                "arg",
                "An argument of the call as name:type=value, e.g. fee_bps:u32=250; repeatable",
                NamedCLType::String,
            )
            .list(),
            CommandArg::new(
                "delay",
                "Milliseconds until the call can be executed; the minimum delay by default",
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
        let mut timelock = container.contract_ref::<Timelock>(env)?;
        let target = args.get_single::<Address>("target")?;
        let entry_point = args.get_single::<String>("entry_point")?;
        let mut call_args = RuntimeArgs::new();
        for text in args.get_many::<String>("arg").unwrap_or_default() {
            parse_arg(&text, &mut call_args)?;
        }
        let delay = match args.get_single::<u64>("delay") {
            Ok(delay) => delay,
            Err(_) => timelock.try_min_delay()?,
        };

        let id = timelock.try_operations_count()?;
        env.set_gas(5 * CSPR);
        timelock.try_schedule(target, entry_point.clone(), serialize(call_args), delay)?;
        odra_cli::log(format!(
            "Proposed operation {id}: {entry_point} on {target:?}, executable in {} seconds. \
             Execute it with: contract Timelock execute --operation_id {id}",
            delay.div_ceil(1000)
        ));
        Ok(())
    }
}

impl ScenarioMetadata for ProposeScenario {
    const NAME: &'static str = "propose";
    const DESCRIPTION: &'static str =
        "Proposes a call of any entry point of any contract through the timelock";
}

/// Runs the command line tool.
pub fn main() {
    OdraCli::new()
        .about("CLI tool for the timelock contract")
        .deploy(TimelockDeployScript)
        .contract::<Timelock>()
        .contract::<FeeConfig>()
        .scenario(DemoScenario)
        .scenario(ProposeScenario)
        .build()
        .run();
}
