//! Crowdfunding with a goal: backers pledge CEP-18 tokens to a campaign until its deadline. If the
//! pledges reach the goal, the creator claims them; if not, every backer takes their pledge back.

use odra::casper_types::U256;
use odra::prelude::*;
use odra::ContractRef;
use odra_modules::cep18_token::Cep18ContractRef;

/// The longest title a campaign may have, in characters.
pub const MAX_TITLE_LENGTH: usize = 64;

/// A campaign. All times are block times: milliseconds since the Unix epoch.
#[odra::odra_type]
pub struct Campaign {
    /// The account that created the campaign and may claim the pledges.
    pub creator: Address,
    /// The CEP-18 token pledged.
    pub token: Address,
    /// A short title, chosen by the creator.
    pub title: String,
    /// The amount the pledges must reach by the deadline.
    pub goal: U256,
    /// The moment the campaign was created.
    pub created_at: u64,
    /// Pledges are accepted until this moment, not at it.
    pub deadline: u64,
    /// The sum of every pledge. Taking a pledge back does not lower it.
    pub pledged: U256,
    /// Whether the creator has claimed the pledges.
    pub claimed: bool,
}

/// Errors of the crowdfunding contract.
#[odra::odra_error]
pub enum Error {
    /// The goal is zero.
    ZeroGoal = 1,
    /// The deadline is not in the future.
    DeadlineNotInFuture = 2,
    /// The title is empty or longer than `MAX_TITLE_LENGTH` characters.
    InvalidTitle = 3,
    /// No campaign has this id.
    CampaignNotFound = 4,
    /// The amount to pledge is zero.
    ZeroAmount = 5,
    /// The deadline has passed: the campaign takes no more pledges.
    CampaignEnded = 6,
    /// The deadline has not come yet.
    CampaignNotEnded = 7,
    /// Only the creator of the campaign may do this.
    NotCreator = 8,
    /// The pledges did not reach the goal: the creator cannot claim them.
    GoalNotReached = 9,
    /// The creator has claimed the pledges already.
    AlreadyClaimed = 10,
    /// The pledges reached the goal: they belong to the creator and cannot be taken back.
    GoalReached = 11,
    /// The caller has no pledge to take back in this campaign.
    NothingToRefund = 12,
}

/// A campaign was created.
#[odra::event]
pub struct CampaignCreated {
    pub campaign_id: u64,
    pub creator: Address,
    pub token: Address,
    pub title: String,
    pub goal: U256,
    pub deadline: u64,
}

/// A backer pledged tokens to a campaign.
#[odra::event]
pub struct Pledged {
    pub campaign_id: u64,
    pub backer: Address,
    pub amount: U256,
    /// The sum of every pledge of the campaign after this one.
    pub pledged: U256,
}

/// The creator of a campaign that reached its goal took the pledges.
#[odra::event]
pub struct Claimed {
    pub campaign_id: u64,
    pub creator: Address,
    pub amount: U256,
}

/// A backer of a campaign that missed its goal took their pledge back.
#[odra::event]
pub struct Refunded {
    pub campaign_id: u64,
    pub backer: Address,
    pub amount: U256,
}

/// Holds the pledges of crowdfunding campaigns until their deadline.
///
/// Anyone can create a campaign for any CEP-18 token; the contract has no owner and no fees.
#[odra::module(
    events = [CampaignCreated, Pledged, Claimed, Refunded],
    errors = Error
)]
pub struct Crowdfunding {
    /// Campaigns by id.
    campaigns: Mapping<u64, Campaign>,
    /// The number of campaigns created; also the id of the next one.
    count: Var<u64>,
    /// Ids of the campaigns an account created.
    by_creator: Mapping<Address, Vec<u64>>,
    /// Ids of the campaigns an account pledged to, in the order of their first pledge.
    by_backer: Mapping<Address, Vec<u64>>,
    /// What a backer has pledged to a campaign and not taken back, by (campaign id, backer).
    pledges: Mapping<(u64, Address), U256>,
}

#[odra::module]
impl Crowdfunding {
    /// Creates a campaign that collects `token` towards `goal` until `deadline`, in milliseconds
    /// since the Unix epoch. The caller is its creator. Its id is the value `campaigns_count`
    /// returned before the call; the `CampaignCreated` event carries it.
    pub fn create_campaign(&mut self, token: Address, title: String, goal: U256, deadline: u64) {
        let length = title.chars().count();
        if title.trim().is_empty() || length > MAX_TITLE_LENGTH {
            self.env().revert(Error::InvalidTitle);
        }
        if goal.is_zero() {
            self.env().revert(Error::ZeroGoal);
        }
        let now = self.env().get_block_time();
        if deadline <= now {
            self.env().revert(Error::DeadlineNotInFuture);
        }

        let creator = self.env().caller();
        let campaign_id = self.count.get_or_default();
        self.count.set(campaign_id + 1);
        self.campaigns.set(
            &campaign_id,
            Campaign {
                creator,
                token,
                title: title.clone(),
                goal,
                created_at: now,
                deadline,
                pledged: U256::zero(),
                claimed: false,
            },
        );
        push_id(&mut self.by_creator, &creator, campaign_id);

        self.env().emit_event(CampaignCreated {
            campaign_id,
            creator,
            token,
            title,
            goal,
            deadline,
        });
    }

    /// Pledges `amount` of the campaign's token, pulling it from the caller, who must have
    /// approved this contract for at least that amount. Allowed until the deadline, also once the
    /// goal is reached; a backer may pledge more than once.
    pub fn pledge(&mut self, campaign_id: u64, amount: U256) {
        let mut campaign = self.get_campaign(campaign_id);
        if amount.is_zero() {
            self.env().revert(Error::ZeroAmount);
        }
        if self.env().get_block_time() >= campaign.deadline {
            self.env().revert(Error::CampaignEnded);
        }

        let backer = self.env().caller();
        let key = (campaign_id, backer);
        let previous = self.pledges.get(&key);
        if previous.is_none() {
            push_id(&mut self.by_backer, &backer, campaign_id);
        }
        self.pledges
            .set(&key, previous.unwrap_or_default() + amount);
        campaign.pledged += amount;
        self.campaigns.set(&campaign_id, campaign.clone());

        Cep18ContractRef::new(self.env(), campaign.token).transfer_from(
            &backer,
            &self.env().self_address(),
            &amount,
        );

        self.env().emit_event(Pledged {
            campaign_id,
            backer,
            amount,
            pledged: campaign.pledged,
        });
    }

    /// Sends every pledge to the creator, once the deadline has passed with the goal reached.
    /// Only the creator may call it.
    pub fn claim(&mut self, campaign_id: u64) {
        let mut campaign = self.get_campaign(campaign_id);
        if self.env().caller() != campaign.creator {
            self.env().revert(Error::NotCreator);
        }
        if self.env().get_block_time() < campaign.deadline {
            self.env().revert(Error::CampaignNotEnded);
        }
        if campaign.pledged < campaign.goal {
            self.env().revert(Error::GoalNotReached);
        }
        if campaign.claimed {
            self.env().revert(Error::AlreadyClaimed);
        }

        campaign.claimed = true;
        self.campaigns.set(&campaign_id, campaign.clone());

        Cep18ContractRef::new(self.env(), campaign.token)
            .transfer(&campaign.creator, &campaign.pledged);

        self.env().emit_event(Claimed {
            campaign_id,
            creator: campaign.creator,
            amount: campaign.pledged,
        });
    }

    /// Gives the caller their pledge back, once the deadline has passed with the goal missed.
    pub fn refund(&mut self, campaign_id: u64) {
        let campaign = self.get_campaign(campaign_id);
        if self.env().get_block_time() < campaign.deadline {
            self.env().revert(Error::CampaignNotEnded);
        }
        if campaign.pledged >= campaign.goal {
            self.env().revert(Error::GoalReached);
        }
        let backer = self.env().caller();
        let key = (campaign_id, backer);
        let amount = self.pledges.get_or_default(&key);
        if amount.is_zero() {
            self.env().revert(Error::NothingToRefund);
        }

        self.pledges.set(&key, U256::zero());

        Cep18ContractRef::new(self.env(), campaign.token).transfer(&backer, &amount);

        self.env().emit_event(Refunded {
            campaign_id,
            backer,
            amount,
        });
    }

    /// Returns the campaign with the given id.
    pub fn campaign(&self, campaign_id: u64) -> Campaign {
        self.get_campaign(campaign_id)
    }

    /// Returns the number of campaigns created. Ids run from `0` to `count - 1`.
    pub fn campaigns_count(&self) -> u64 {
        self.count.get_or_default()
    }

    /// Returns the ids of the campaigns `creator` created.
    pub fn campaigns_of_creator(&self, creator: Address) -> Vec<u64> {
        self.by_creator.get_or_default(&creator)
    }

    /// Returns the ids of the campaigns `backer` pledged to.
    pub fn campaigns_of_backer(&self, backer: Address) -> Vec<u64> {
        self.by_backer.get_or_default(&backer)
    }

    /// Returns what `backer` has pledged to the campaign and not taken back.
    pub fn pledge_of(&self, campaign_id: u64, backer: Address) -> U256 {
        self.pledges.get_or_default(&(campaign_id, backer))
    }
}

impl Crowdfunding {
    fn get_campaign(&self, campaign_id: u64) -> Campaign {
        self.campaigns
            .get(&campaign_id)
            .unwrap_or_revert_with(self, Error::CampaignNotFound)
    }
}

fn push_id(index: &mut Mapping<Address, Vec<u64>>, account: &Address, campaign_id: u64) {
    let mut ids = index.get_or_default(account);
    ids.push(campaign_id);
    index.set(account, ids);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::token::{TestToken, TestTokenHostRef};
    use odra::host::{Deployer, HostEnv, NoArgs};
    use odra_modules::cep18::errors::Error as Cep18Error;

    const DAY: u64 = 24 * 60 * 60 * 1000;

    struct Setup {
        env: HostEnv,
        token: TestTokenHostRef,
        crowdfunding: CrowdfundingHostRef,
        creator: Address,
        alice: Address,
        bob: Address,
    }

    /// Deploys both contracts; the two backers get tokens and allow the contract to take them.
    fn setup() -> Setup {
        let env = odra_test::env();
        let creator = env.get_account(1);
        let alice = env.get_account(2);
        let bob = env.get_account(3);
        let mut token = TestToken::deploy(&env, NoArgs);
        let crowdfunding = Crowdfunding::deploy(&env, NoArgs);

        for backer in [alice, bob] {
            env.set_caller(backer);
            token.faucet();
            token.approve(&crowdfunding.address(), &TestToken::faucet_amount());
        }

        Setup {
            env,
            token,
            crowdfunding,
            creator,
            alice,
            bob,
        }
    }

    /// Creates a campaign with a goal of 1000 units and a deadline 10 days away.
    fn create(s: &mut Setup) -> u64 {
        let deadline = s.env.block_time() + 10 * DAY;
        let id = s.crowdfunding.campaigns_count();
        s.env.set_caller(s.creator);
        s.crowdfunding.create_campaign(
            s.token.address(),
            String::from("A new roof"),
            U256::from(1000),
            deadline,
        );
        id
    }

    impl Setup {
        fn pledge(&mut self, backer: Address, id: u64, amount: u64) {
            self.env.set_caller(backer);
            self.crowdfunding.pledge(id, U256::from(amount));
        }
    }

    #[test]
    fn creating_a_campaign_stores_it() {
        let mut s = setup();
        let now = s.env.block_time();
        let id = create(&mut s);

        assert_eq!(id, 0);
        assert_eq!(s.crowdfunding.campaigns_count(), 1);
        assert_eq!(
            s.crowdfunding.campaign(id),
            Campaign {
                creator: s.creator,
                token: s.token.address(),
                title: String::from("A new roof"),
                goal: U256::from(1000),
                created_at: now,
                deadline: now + 10 * DAY,
                pledged: U256::zero(),
                claimed: false,
            }
        );
        assert_eq!(s.crowdfunding.campaigns_of_creator(s.creator), vec![0]);
        assert!(s.crowdfunding.campaigns_of_backer(s.creator).is_empty());
        assert!(s.env.emitted_event(
            &s.crowdfunding,
            CampaignCreated {
                campaign_id: 0,
                creator: s.creator,
                token: s.token.address(),
                title: String::from("A new roof"),
                goal: U256::from(1000),
                deadline: now + 10 * DAY,
            }
        ));
        assert_eq!(create(&mut s), 1);
        assert_eq!(s.crowdfunding.campaigns_of_creator(s.creator), vec![0, 1]);
    }

    #[test]
    fn pledges_are_pulled_and_recorded() {
        let mut s = setup();
        let id = create(&mut s);

        s.pledge(s.alice, id, 300);
        s.pledge(s.bob, id, 200);
        s.pledge(s.alice, id, 100);

        assert_eq!(s.crowdfunding.campaign(id).pledged, U256::from(600));
        assert_eq!(s.crowdfunding.pledge_of(id, s.alice), U256::from(400));
        assert_eq!(s.crowdfunding.pledge_of(id, s.bob), U256::from(200));
        assert_eq!(s.crowdfunding.pledge_of(id, s.creator), U256::zero());
        assert_eq!(
            s.token.balance_of(&s.crowdfunding.address()),
            U256::from(600)
        );
        assert_eq!(
            s.token.balance_of(&s.alice),
            TestToken::faucet_amount() - 400
        );
        // A campaign is listed once per backer, however often they pledge.
        assert_eq!(s.crowdfunding.campaigns_of_backer(s.alice), vec![id]);
        assert_eq!(s.crowdfunding.campaigns_of_backer(s.bob), vec![id]);
        assert!(s.env.emitted_event(
            &s.crowdfunding,
            Pledged {
                campaign_id: id,
                backer: s.alice,
                amount: U256::from(100),
                pledged: U256::from(600),
            }
        ));
    }

    #[test]
    fn pledges_are_accepted_past_the_goal_until_the_deadline() {
        let mut s = setup();
        let id = create(&mut s);

        s.pledge(s.alice, id, 1000);
        s.env.advance_block_time(10 * DAY - 1);
        s.pledge(s.bob, id, 500);
        assert_eq!(s.crowdfunding.campaign(id).pledged, U256::from(1500));

        s.env.advance_block_time(1);
        assert_eq!(
            s.crowdfunding.try_pledge(id, U256::one()),
            Err(Error::CampaignEnded.into())
        );
    }

    #[test]
    fn the_creator_claims_everything_once_the_goal_is_met_by_the_deadline() {
        let mut s = setup();
        let id = create(&mut s);
        s.pledge(s.alice, id, 700);
        s.pledge(s.bob, id, 500);

        // Not before the deadline, even with the goal met.
        s.env.set_caller(s.creator);
        assert_eq!(
            s.crowdfunding.try_claim(id),
            Err(Error::CampaignNotEnded.into())
        );

        s.env.advance_block_time(10 * DAY);
        s.env.set_caller(s.alice);
        assert_eq!(s.crowdfunding.try_claim(id), Err(Error::NotCreator.into()));
        assert_eq!(
            s.crowdfunding.try_refund(id),
            Err(Error::GoalReached.into())
        );

        s.env.set_caller(s.creator);
        s.crowdfunding.claim(id);
        assert_eq!(s.token.balance_of(&s.creator), U256::from(1200));
        assert_eq!(s.token.balance_of(&s.crowdfunding.address()), U256::zero());
        assert!(s.crowdfunding.campaign(id).claimed);
        assert!(s.env.emitted_event(
            &s.crowdfunding,
            Claimed {
                campaign_id: id,
                creator: s.creator,
                amount: U256::from(1200),
            }
        ));
        assert_eq!(
            s.crowdfunding.try_claim(id),
            Err(Error::AlreadyClaimed.into())
        );
    }

    #[test]
    fn backers_take_their_pledges_back_when_the_goal_is_missed() {
        let mut s = setup();
        let id = create(&mut s);
        s.pledge(s.alice, id, 600);
        s.pledge(s.bob, id, 399);

        // Not before the deadline.
        s.env.set_caller(s.alice);
        assert_eq!(
            s.crowdfunding.try_refund(id),
            Err(Error::CampaignNotEnded.into())
        );

        s.env.advance_block_time(10 * DAY);
        s.env.set_caller(s.creator);
        assert_eq!(
            s.crowdfunding.try_claim(id),
            Err(Error::GoalNotReached.into())
        );
        assert_eq!(
            s.crowdfunding.try_refund(id),
            Err(Error::NothingToRefund.into())
        );

        s.env.set_caller(s.alice);
        s.crowdfunding.refund(id);
        assert_eq!(s.token.balance_of(&s.alice), TestToken::faucet_amount());
        assert_eq!(s.crowdfunding.pledge_of(id, s.alice), U256::zero());
        assert!(s.env.emitted_event(
            &s.crowdfunding,
            Refunded {
                campaign_id: id,
                backer: s.alice,
                amount: U256::from(600),
            }
        ));
        assert_eq!(
            s.crowdfunding.try_refund(id),
            Err(Error::NothingToRefund.into())
        );
        // The total stays what was pledged; the backer's list keeps the campaign.
        assert_eq!(s.crowdfunding.campaign(id).pledged, U256::from(999));
        assert_eq!(s.crowdfunding.campaigns_of_backer(s.alice), vec![id]);

        s.env.set_caller(s.bob);
        s.crowdfunding.refund(id);
        assert_eq!(s.token.balance_of(&s.bob), TestToken::faucet_amount());
        assert_eq!(s.token.balance_of(&s.crowdfunding.address()), U256::zero());
    }

    #[test]
    fn campaigns_keep_their_pledges_apart() {
        let mut s = setup();
        let first = create(&mut s);
        let second = create(&mut s);
        s.pledge(s.alice, first, 1000);
        s.pledge(s.alice, second, 10);

        assert_eq!(s.crowdfunding.campaigns_of_backer(s.alice), vec![0, 1]);
        s.env.advance_block_time(10 * DAY);

        s.env.set_caller(s.creator);
        s.crowdfunding.claim(first);
        assert_eq!(s.token.balance_of(&s.creator), U256::from(1000));

        s.env.set_caller(s.alice);
        s.crowdfunding.refund(second);
        assert_eq!(
            s.token.balance_of(&s.alice),
            TestToken::faucet_amount() - 1000
        );
    }

    /// The sequence of the CLI's `demo` scenario, sent by one account: a campaign that reaches its
    /// goal and is claimed after its deadline, and one left open. On CasperVM
    /// (`cargo odra test -b casper -- --nocapture`) it prints the gas of every transaction.
    #[test]
    fn demo_scenario() {
        let env = odra_test::env();
        let me = env.get_account(0);
        env.set_caller(me);
        let mut token = TestToken::deploy(&env, NoArgs);
        let mut crowdfunding = Crowdfunding::deploy(&env, NoArgs);
        let unit = U256::from(10u64.pow(crate::token::DECIMALS as u32));
        let minute = 60 * 1000;

        token.faucet();
        token.approve(&crowdfunding.address(), &(unit * 140));
        let now = env.block_time();
        crowdfunding.create_campaign(
            token.address(),
            String::from("A coffee machine for the hackerspace"),
            unit * 100,
            now + 3 * minute,
        );
        crowdfunding.pledge(0, unit * 100);
        crowdfunding.create_campaign(
            token.address(),
            String::from("A community garden by the river"),
            unit * 1000,
            now + 14 * DAY,
        );
        crowdfunding.pledge(1, unit * 40);

        env.advance_block_time(3 * minute);
        crowdfunding.claim(0);

        assert!(crowdfunding.campaign(0).claimed);
        assert_eq!(crowdfunding.campaign(1).pledged, unit * 40);
        assert_eq!(crowdfunding.campaigns_of_creator(me), vec![0, 1]);
        assert_eq!(crowdfunding.campaigns_of_backer(me), vec![0, 1]);
        assert_eq!(
            token.balance_of(&me),
            TestToken::faucet_amount() - unit * 40
        );
        println!("{}", env.gas_report());
    }

    #[test]
    fn invalid_campaigns_and_pledges_are_rejected() {
        let mut s = setup();
        let token = s.token.address();
        let now = s.env.block_time();
        s.env.set_caller(s.creator);

        let mut try_create = |title: &str, goal: u64, deadline: u64| {
            s.crowdfunding.try_create_campaign(
                token,
                String::from(title),
                U256::from(goal),
                deadline,
            )
        };
        assert_eq!(
            try_create("", 1, now + DAY),
            Err(Error::InvalidTitle.into())
        );
        assert_eq!(
            try_create("   ", 1, now + DAY),
            Err(Error::InvalidTitle.into())
        );
        let long = "x".repeat(MAX_TITLE_LENGTH + 1);
        assert_eq!(
            try_create(&long, 1, now + DAY),
            Err(Error::InvalidTitle.into())
        );
        assert_eq!(
            try_create("Roof", 0, now + DAY),
            Err(Error::ZeroGoal.into())
        );
        assert_eq!(
            try_create("Roof", 1, now),
            Err(Error::DeadlineNotInFuture.into())
        );
        // The longest title, in characters that take more than one byte each.
        let longest = "ż".repeat(MAX_TITLE_LENGTH);
        assert_eq!(try_create(&longest, 1, now + DAY), Ok(()));

        assert_eq!(
            s.crowdfunding.try_pledge(7, U256::one()),
            Err(Error::CampaignNotFound.into())
        );
        assert_eq!(
            s.crowdfunding.try_pledge(0, U256::zero()),
            Err(Error::ZeroAmount.into())
        );
        // More than the backer approved.
        s.env.set_caller(s.alice);
        assert_eq!(
            s.crowdfunding.try_pledge(0, TestToken::faucet_amount() + 1),
            Err(Cep18Error::InsufficientAllowance.into())
        );
        assert_eq!(
            s.crowdfunding.try_claim(7),
            Err(Error::CampaignNotFound.into())
        );
        assert_eq!(
            s.crowdfunding.try_refund(7),
            Err(Error::CampaignNotFound.into())
        );
    }
}
