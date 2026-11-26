//! Command line tool of the auction project: deploys the contracts and runs scenarios on a network.

use auction::auction::Auction;
use auction::demo::{self, gas, Options};
use auction::nft::TestNft;
use odra::casper_types::U512;
use odra::host::{HostEnv, NoArgs};
use odra::schema::casper_contract_schema::NamedCLType;
use odra_cli::{
    deploy::DeployScript,
    scenario::{Args, Error, Scenario, ScenarioMetadata},
    CommandArg, ContractProvider, DeployedContractsContainer, DeployerExt, OdraCli,
};

const CSPR: u64 = 1_000_000_000;

/// Deploys `Auction` and `TestNft`, or loads them if they are deployed already.
pub struct AuctionDeployScript;

impl DeployScript for AuctionDeployScript {
    fn deploy(
        &self,
        env: &HostEnv,
        container: &mut DeployedContractsContainer,
    ) -> Result<(), odra_cli::deploy::Error> {
        Auction::load_or_deploy(env, NoArgs, container, gas::DEPLOY_AUCTION)?;
        TestNft::load_or_deploy(env, NoArgs, container, gas::DEPLOY_NFT)?;
        Ok(())
    }
}

/// Mints a test NFT, auctions it, bids twice, takes the outbid stake back and settles.
pub struct DemoScenario;

impl Scenario for DemoScenario {
    fn args(&self) -> Vec<CommandArg> {
        vec![
            CommandArg::new(
                "name",
                "The name of the test NFT to mint; \"Demo lot\" by default",
                NamedCLType::String,
            ),
            CommandArg::new(
                "minutes",
                "How long the auction runs before a bid moves its end; 3 by default",
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
        let mut nft = container.contract_ref::<TestNft>(env)?;
        let mut auction = container.contract_ref::<Auction>(env)?;
        let mut options = Options::default();
        if let Ok(name) = args.get_single::<String>("name") {
            options.name = name;
        }
        if let Ok(minutes) = args.get_single::<u64>("minutes") {
            options.duration = minutes * 60 * 1000;
        }

        odra_cli::log(
            "Minting, auctioning and bidding; then the scenario waits for the end, about six minutes.",
        );
        let outcome = demo::run(&mut nft, &mut auction, options)?;
        odra_cli::log(format!(
            "Auction {}: NFT {} sold for {} CSPR; the first bid, {} CSPR, was outbid and taken back. \
             The late bids moved the end by {} seconds.",
            outcome.auction_id,
            outcome.token_id,
            cspr(outcome.price),
            cspr(outcome.withdrawn),
            outcome.end.saturating_sub(outcome.first_end) / 1000,
        ));
        Ok(())
    }
}

impl ScenarioMetadata for DemoScenario {
    const NAME: &'static str = "demo";
    const DESCRIPTION: &'static str =
        "Mints a test NFT, auctions it, bids twice, takes the outbid stake back and settles";
}

/// An amount of motes as CSPR, with the fraction.
fn cspr(motes: U512) -> String {
    let whole = motes / U512::from(CSPR);
    let fraction = (motes % U512::from(CSPR)).as_u64();
    if fraction == 0 {
        whole.to_string()
    } else {
        format!("{whole}.{}", format!("{fraction:09}").trim_end_matches('0'))
    }
}

/// Runs the command line tool.
pub fn main() {
    OdraCli::new()
        .about("CLI tool for the auction contract")
        .deploy(AuctionDeployScript)
        .contract::<Auction>()
        .contract::<TestNft>()
        .scenario(DemoScenario)
        .build()
        .run();
}
