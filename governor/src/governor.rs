//! Governor: token holders vote on a new fee, and a fee that wins is set through a timelock.

use odra::casper_types::bytesrepr::{Bytes, ToBytes};
use odra::casper_types::{runtime_args, U256};
use odra::prelude::*;
use odra::ContractRef;

use crate::fee_config::MAX_FEE_BPS;
use crate::timelock::TimelockContractRef;
use crate::token::TestTokenContractRef;

/// A proposal: set the fee of the governed contract to `fee_bps`.
/// Times are block times: milliseconds since the Unix epoch.
#[odra::odra_type]
pub struct Proposal {
    /// The account that made the proposal.
    pub proposer: Address,
    /// The fee the proposal sets, in basis points.
    pub fee_bps: u32,
    /// When the proposal was made; voting starts at once.
    pub created_at: u64,
    /// Voting ends at this moment. A vote is accepted only before it.
    pub vote_end: u64,
    /// Tokens deposited in favour.
    pub votes_for: U256,
    /// Tokens deposited against.
    pub votes_against: U256,
    /// Whether the proposal has been handed to the timelock.
    pub queued: bool,
    /// The id of the timelock operation, once queued.
    pub operation_id: u64,
    /// The timelock may run the operation from this moment on, once queued.
    pub ready_at: u64,
    /// Whether the governor has executed the operation.
    pub executed: bool,
}

/// The tokens one account deposited on one proposal.
#[odra::odra_type]
pub struct Ballot {
    /// For (`true`) or against (`false`) the proposal.
    pub support: bool,
    /// The tokens deposited, all on one side.
    pub amount: U256,
    /// Whether the tokens have been taken back.
    pub withdrawn: bool,
}

/// Where a proposal stands. It follows from the stored proposal and the clock.
#[odra::odra_type]
pub enum ProposalState {
    /// Voting has not ended.
    Voting = 0,
    /// Voting ended without enough tokens in favour.
    Defeated = 1,
    /// Voting ended and the proposal passed; it can be queued.
    Succeeded = 2,
    /// Handed to the timelock; it can be executed from `ready_at` on.
    Queued = 3,
    /// The new fee has been set.
    Executed = 4,
}

/// Errors of the governor. Numbered from 200, so they do not overlap the errors of the timelock
/// (1–12), the fee contract (100, 101) and the token (60000 and up).
#[odra::odra_error]
pub enum Error {
    /// The proposer holds fewer tokens than the proposal threshold.
    BelowProposalThreshold = 200,
    /// The fee is above 10,000 basis points.
    FeeTooHigh = 201,
    /// No proposal has this id.
    ProposalNotFound = 202,
    /// Voting on this proposal has ended.
    VotingClosed = 203,
    /// The amount of tokens is zero.
    ZeroAmount = 204,
    /// The caller voted the other way on this proposal already.
    OtherSide = 205,
    /// Voting has not ended yet, so the tokens are still locked.
    VotingNotOver = 206,
    /// The caller has no tokens to take back from this proposal.
    NothingToWithdraw = 207,
    /// The proposal did not pass.
    NotPassed = 208,
    /// The proposal has been queued already.
    AlreadyQueued = 209,
    /// The proposal has not been queued.
    NotQueued = 210,
    /// The timelock's delay has not passed yet.
    NotReady = 211,
    /// The proposal has been executed already.
    AlreadyExecuted = 212,
    /// The voting period is zero.
    InvalidVotingPeriod = 213,
}

/// A fee was proposed. Voting runs until `vote_end`.
#[odra::event]
pub struct ProposalCreated {
    pub proposal_id: u64,
    pub proposer: Address,
    pub fee_bps: u32,
    pub vote_end: u64,
}

/// Tokens were deposited for or against a proposal.
#[odra::event]
pub struct VoteCast {
    pub proposal_id: u64,
    pub voter: Address,
    pub support: bool,
    pub amount: U256,
}

/// A passed proposal was handed to the timelock as operation `operation_id`.
#[odra::event]
pub struct ProposalQueued {
    pub proposal_id: u64,
    pub operation_id: u64,
    pub ready_at: u64,
}

/// The timelock ran a proposal: the fee is set.
#[odra::event]
pub struct ProposalExecuted {
    pub proposal_id: u64,
    pub executor: Address,
}

/// A voter took back the tokens deposited on a proposal.
#[odra::event]
pub struct VoteWithdrawn {
    pub proposal_id: u64,
    pub voter: Address,
    pub amount: U256,
}

/// Lets the holders of a token decide the fee of a contract that a timelock owns.
///
/// Anyone holding at least the proposal threshold proposes a fee. Voters deposit tokens for or
/// against it; the deposit is the vote, so the same tokens cannot vote twice on one proposal, and
/// they come back once voting ends. A proposal passes with at least `quorum` tokens in favour and
/// more in favour than against. Then anyone queues it in the timelock, and after the timelock's
/// delay anyone executes it.
#[odra::module(
    events = [ProposalCreated, VoteCast, ProposalQueued, ProposalExecuted, VoteWithdrawn],
    errors = Error
)]
pub struct Governor {
    /// The token votes are counted in.
    token: Var<Address>,
    /// The timelock that runs passed proposals.
    timelock: Var<Address>,
    /// The contract whose `set_fee` the proposals call. Its owner is the timelock.
    fee_config: Var<Address>,
    /// How long voting on a proposal lasts, in milliseconds.
    voting_period: Var<u64>,
    /// The tokens in favour a proposal needs to pass.
    quorum: Var<U256>,
    /// The tokens an account must hold to propose.
    proposal_threshold: Var<U256>,
    /// Proposals by id.
    proposals: Mapping<u64, Proposal>,
    /// The number of proposals; also the id of the next one.
    count: Var<u64>,
    /// The deposit of each voter on each proposal.
    ballots: Mapping<(u64, Address), Ballot>,
}

#[odra::module]
impl Governor {
    /// Sets the token, the timelock, the governed fee contract and the rules of voting.
    /// `voting_period` is in milliseconds; `quorum` and `proposal_threshold` in the smallest unit
    /// of the token.
    pub fn init(
        &mut self,
        token: Address,
        timelock: Address,
        fee_config: Address,
        voting_period: u64,
        quorum: U256,
        proposal_threshold: U256,
    ) {
        if voting_period == 0 {
            self.env().revert(Error::InvalidVotingPeriod);
        }
        self.token.set(token);
        self.timelock.set(timelock);
        self.fee_config.set(fee_config);
        self.voting_period.set(voting_period);
        self.quorum.set(quorum);
        self.proposal_threshold.set(proposal_threshold);
    }

    /// Proposes to set the fee to `fee_bps` basis points. Voting starts at once. The caller must
    /// hold at least the proposal threshold. The id of the proposal is the value
    /// `proposals_count` returned before the call; the `ProposalCreated` event carries it.
    pub fn propose(&mut self, fee_bps: u32) {
        if fee_bps > MAX_FEE_BPS {
            self.env().revert(Error::FeeTooHigh);
        }
        let proposer = self.env().caller();
        if self.token().balance_of(&proposer) < self.proposal_threshold.get_or_default() {
            self.env().revert(Error::BelowProposalThreshold);
        }

        let now = self.env().get_block_time();
        let vote_end = now + self.voting_period.get_or_default();
        let proposal_id = self.count.get_or_default();
        self.count.set(proposal_id + 1);
        self.proposals.set(
            &proposal_id,
            Proposal {
                proposer,
                fee_bps,
                created_at: now,
                vote_end,
                votes_for: U256::zero(),
                votes_against: U256::zero(),
                queued: false,
                operation_id: 0,
                ready_at: 0,
                executed: false,
            },
        );
        self.env().emit_event(ProposalCreated {
            proposal_id,
            proposer,
            fee_bps,
            vote_end,
        });
    }

    /// Votes for (`support`) or against a proposal with `amount` tokens, which the governor takes
    /// with `transfer_from`: approve it first. The tokens stay locked until voting ends. A voter
    /// may add tokens to their vote, on the side they chose first.
    pub fn vote(&mut self, proposal_id: u64, support: bool, amount: U256) {
        let mut proposal = self.get_proposal(proposal_id);
        if self.env().get_block_time() >= proposal.vote_end {
            self.env().revert(Error::VotingClosed);
        }
        if amount.is_zero() {
            self.env().revert(Error::ZeroAmount);
        }
        let voter = self.env().caller();
        let mut ballot = self.ballots.get(&(proposal_id, voter)).unwrap_or(Ballot {
            support,
            amount: U256::zero(),
            withdrawn: false,
        });
        if ballot.support != support {
            self.env().revert(Error::OtherSide);
        }

        ballot.amount += amount;
        if support {
            proposal.votes_for += amount;
        } else {
            proposal.votes_against += amount;
        }
        self.ballots.set(&(proposal_id, voter), ballot);
        self.proposals.set(&proposal_id, proposal);

        let governor = self.env().self_address();
        self.token().transfer_from(&voter, &governor, &amount);
        self.env().emit_event(VoteCast {
            proposal_id,
            voter,
            support,
            amount,
        });
    }

    /// Gives the caller back the tokens they deposited on a proposal. Allowed once voting has
    /// ended, whatever the result.
    pub fn withdraw(&mut self, proposal_id: u64) {
        let proposal = self.get_proposal(proposal_id);
        if self.env().get_block_time() < proposal.vote_end {
            self.env().revert(Error::VotingNotOver);
        }
        let voter = self.env().caller();
        let mut ballot = match self.ballots.get(&(proposal_id, voter)) {
            Some(ballot) if !ballot.withdrawn => ballot,
            _ => self.env().revert(Error::NothingToWithdraw),
        };

        ballot.withdrawn = true;
        let amount = ballot.amount;
        self.ballots.set(&(proposal_id, voter), ballot);
        self.token().transfer(&voter, &amount);
        self.env().emit_event(VoteWithdrawn {
            proposal_id,
            voter,
            amount,
        });
    }

    /// Hands a passed proposal to the timelock: schedules `set_fee` on the fee contract with the
    /// timelock's minimum delay. Anyone may call it.
    pub fn queue(&mut self, proposal_id: u64) {
        let mut proposal = self.get_proposal(proposal_id);
        match self.state_of(&proposal) {
            ProposalState::Voting => self.env().revert(Error::VotingNotOver),
            ProposalState::Defeated => self.env().revert(Error::NotPassed),
            ProposalState::Succeeded => {}
            ProposalState::Queued | ProposalState::Executed => {
                self.env().revert(Error::AlreadyQueued)
            }
        }

        let mut timelock = self.timelock_ref();
        let operation_id = timelock.operations_count();
        let delay = timelock.min_delay();
        let args = runtime_args! { "fee_bps" => proposal.fee_bps };
        let args = Bytes::from(args.to_bytes().unwrap_or_revert(self));
        timelock.schedule(
            self.fee_config.get().unwrap_or_revert(self),
            String::from("set_fee"),
            args,
            delay,
        );

        let ready_at = self.env().get_block_time() + delay;
        proposal.queued = true;
        proposal.operation_id = operation_id;
        proposal.ready_at = ready_at;
        self.proposals.set(&proposal_id, proposal);
        self.env().emit_event(ProposalQueued {
            proposal_id,
            operation_id,
            ready_at,
        });
    }

    /// Has the timelock run a queued proposal once its delay has passed: the fee is set. Anyone
    /// may call it.
    pub fn execute(&mut self, proposal_id: u64) {
        let mut proposal = self.get_proposal(proposal_id);
        if !proposal.queued {
            self.env().revert(Error::NotQueued);
        }
        if proposal.executed {
            self.env().revert(Error::AlreadyExecuted);
        }
        if self.env().get_block_time() < proposal.ready_at {
            self.env().revert(Error::NotReady);
        }

        proposal.executed = true;
        let operation_id = proposal.operation_id;
        self.proposals.set(&proposal_id, proposal);
        self.timelock_ref().execute(operation_id);
        self.env().emit_event(ProposalExecuted {
            proposal_id,
            executor: self.env().caller(),
        });
    }

    /// Returns the proposal with the given id.
    pub fn proposal(&self, proposal_id: u64) -> Proposal {
        self.get_proposal(proposal_id)
    }

    /// Returns where the proposal stands now.
    pub fn state(&self, proposal_id: u64) -> ProposalState {
        self.state_of(&self.get_proposal(proposal_id))
    }

    /// Returns the number of proposals. Ids run from `0` to `count - 1`.
    pub fn proposals_count(&self) -> u64 {
        self.count.get_or_default()
    }

    /// Returns what `voter` deposited on a proposal, if anything.
    pub fn ballot(&self, proposal_id: u64, voter: Address) -> Option<Ballot> {
        self.ballots.get(&(proposal_id, voter))
    }
}

impl Governor {
    fn token(&self) -> TestTokenContractRef {
        let token = self.token.get().unwrap_or_revert(self);
        TestTokenContractRef::new(self.env(), token)
    }

    fn timelock_ref(&self) -> TimelockContractRef {
        let timelock = self.timelock.get().unwrap_or_revert(self);
        TimelockContractRef::new(self.env(), timelock)
    }

    fn get_proposal(&self, proposal_id: u64) -> Proposal {
        self.proposals
            .get(&proposal_id)
            .unwrap_or_revert_with(self, Error::ProposalNotFound)
    }

    fn state_of(&self, proposal: &Proposal) -> ProposalState {
        if proposal.executed {
            ProposalState::Executed
        } else if proposal.queued {
            ProposalState::Queued
        } else if self.env().get_block_time() < proposal.vote_end {
            ProposalState::Voting
        } else if proposal.votes_for >= self.quorum.get_or_default()
            && proposal.votes_for > proposal.votes_against
        {
            ProposalState::Succeeded
        } else {
            ProposalState::Defeated
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fee_config::{FeeConfig, FeeConfigHostRef, FeeConfigInitArgs};
    use crate::timelock::{anyone, Error as TimelockError, Timelock, TimelockHostRef};
    use crate::timelock::{Operation, TimelockInitArgs};
    use crate::token::{TestToken, TestTokenHostRef};
    use odra::host::{Deployer, HostEnv, NoArgs};

    const MINUTE: u64 = 60 * 1000;
    const VOTING_PERIOD: u64 = 3 * MINUTE;

    /// Whole tokens in the smallest unit (9 decimals).
    fn tokens(whole: u64) -> U256 {
        U256::from(whole) * U256::from(1_000_000_000u64)
    }

    struct Setup {
        env: HostEnv,
        governor: GovernorHostRef,
        timelock: TimelockHostRef,
        config: FeeConfigHostRef,
        token: TestTokenHostRef,
    }

    /// The demo deployment: an open timelock with a one minute delay that owns a fee of 1%, and
    /// a governor with a 3 minute vote, a quorum of 500 TEST and a threshold of 100 TEST.
    fn setup() -> Setup {
        let env = odra_test::env();
        let timelock = Timelock::deploy(
            &env,
            TimelockInitArgs {
                min_delay: MINUTE,
                proposers: vec![anyone()],
                executors: vec![anyone()],
                cancellers: vec![env.get_account(0)],
            },
        );
        let config = FeeConfig::deploy(
            &env,
            FeeConfigInitArgs {
                owner: timelock.address(),
                fee_bps: 100,
            },
        );
        let token = TestToken::deploy(&env, NoArgs);
        let governor = Governor::deploy(
            &env,
            GovernorInitArgs {
                token: token.address(),
                timelock: timelock.address(),
                fee_config: config.address(),
                voting_period: VOTING_PERIOD,
                quorum: tokens(500),
                proposal_threshold: tokens(100),
            },
        );
        Setup {
            env,
            governor,
            timelock,
            config,
            token,
        }
    }

    /// Takes tokens from the faucet `times` times and lets the governor take all of them, as `who`.
    fn fund_times(s: &mut Setup, who: Address, times: u64) {
        s.env.set_caller(who);
        for _ in 0..times {
            s.token.faucet();
        }
        s.token
            .approve(&s.governor.address(), &(TestToken::faucet_amount() * times));
    }

    /// One faucet call, 1,000 TEST, for the governor to take.
    fn fund(s: &mut Setup, who: Address) {
        fund_times(s, who, 1);
    }

    fn vote(s: &mut Setup, who: Address, id: u64, support: bool, amount: U256) {
        s.env.set_caller(who);
        s.governor.vote(id, support, amount);
    }

    #[test]
    fn a_fee_that_wins_the_vote_is_set_through_the_timelock() {
        // The sequence of the `demo` scenario of bin/cli.rs.
        let mut s = setup();
        let voter = s.env.get_account(1);
        fund(&mut s, voter);

        let now = s.env.block_time();
        s.governor.propose(250);
        assert_eq!(s.governor.proposals_count(), 1);
        assert!(s.env.emitted_event(
            &s.governor,
            ProposalCreated {
                proposal_id: 0,
                proposer: voter,
                fee_bps: 250,
                vote_end: now + VOTING_PERIOD
            }
        ));
        s.governor.vote(0, true, TestToken::faucet_amount());
        assert_eq!(s.governor.state(0), ProposalState::Voting);
        assert_eq!(s.token.balance_of(&voter), U256::zero());
        assert_eq!(s.governor.try_withdraw(0), Err(Error::VotingNotOver.into()));

        s.env.advance_block_time(VOTING_PERIOD);
        assert_eq!(s.governor.state(0), ProposalState::Succeeded);
        s.governor.queue(0);
        let proposal = s.governor.proposal(0);
        assert_eq!(s.governor.state(0), ProposalState::Queued);
        assert_eq!(proposal.operation_id, 0);
        let operation: Operation = s.timelock.operation(0);
        assert_eq!(operation.proposer, s.governor.address());
        assert_eq!(operation.target, s.config.address());
        assert_eq!(operation.ready_at, proposal.ready_at);
        assert_eq!(proposal.ready_at, s.env.block_time() + MINUTE);
        assert_eq!(s.governor.try_execute(0), Err(Error::NotReady.into()));

        s.env.advance_block_time(MINUTE);
        s.governor.execute(0);
        assert_eq!(s.config.fee_bps(), 250);
        assert_eq!(s.governor.state(0), ProposalState::Executed);
        assert!(s.timelock.operation(0).executed);
        assert_eq!(
            s.governor.try_execute(0),
            Err(Error::AlreadyExecuted.into())
        );

        s.governor.withdraw(0);
        assert_eq!(s.token.balance_of(&voter), TestToken::faucet_amount());
        assert!(s.env.emitted_event(
            &s.governor,
            VoteWithdrawn {
                proposal_id: 0,
                voter,
                amount: TestToken::faucet_amount()
            }
        ));
        assert_eq!(
            s.governor.try_withdraw(0),
            Err(Error::NothingToWithdraw.into())
        );

        // On CasperVM, the gas of each transaction, for the limits in bin/cli.rs and the web app.
        println!("{}", s.env.gas_report());
    }

    #[test]
    fn proposing_needs_the_threshold_and_a_valid_fee() {
        let mut s = setup();
        let proposer = s.env.get_account(1);
        s.env.set_caller(proposer);
        assert_eq!(
            s.governor.try_propose(250),
            Err(Error::BelowProposalThreshold.into())
        );
        s.token.faucet();
        assert_eq!(
            s.governor.try_propose(MAX_FEE_BPS + 1),
            Err(Error::FeeTooHigh.into())
        );
        s.governor.propose(MAX_FEE_BPS);
        // Proposing locks nothing: the same tokens may propose again.
        s.governor.propose(0);
        assert_eq!(s.governor.proposals_count(), 2);
    }

    #[test]
    fn a_proposal_needs_the_quorum_and_a_majority() {
        let mut s = setup();
        let (a, b) = (s.env.get_account(1), s.env.get_account(2));
        fund_times(&mut s, a, 2);
        fund_times(&mut s, b, 2);
        s.env.set_caller(a);
        s.governor.propose(200); // 0: below the quorum
        s.governor.propose(300); // 1: more against than for
        s.governor.propose(400); // 2: a tie
        s.governor.propose(500); // 3: passes

        vote(&mut s, a, 0, true, tokens(499));
        vote(&mut s, a, 1, true, tokens(600));
        vote(&mut s, b, 1, false, tokens(601));
        vote(&mut s, a, 2, true, tokens(600));
        vote(&mut s, b, 2, false, tokens(600));
        vote(&mut s, b, 3, true, tokens(300));
        vote(&mut s, b, 3, true, tokens(200));

        let ballot = s.governor.ballot(3, b).unwrap();
        assert_eq!(ballot.amount, tokens(500));
        assert!(ballot.support && !ballot.withdrawn);
        assert_eq!(s.governor.ballot(3, a), None);
        assert_eq!(s.governor.try_queue(3), Err(Error::VotingNotOver.into()));

        s.env.advance_block_time(VOTING_PERIOD);
        for id in 0..3 {
            assert_eq!(s.governor.state(id), ProposalState::Defeated);
            assert_eq!(s.governor.try_queue(id), Err(Error::NotPassed.into()));
        }
        assert_eq!(s.governor.state(3), ProposalState::Succeeded);
        s.governor.queue(3);
        assert_eq!(s.governor.try_queue(3), Err(Error::AlreadyQueued.into()));
    }

    #[test]
    fn votes_are_deposits_on_one_side_until_the_end() {
        let mut s = setup();
        let voter = s.env.get_account(1);
        fund(&mut s, voter);
        s.governor.propose(250);

        assert_eq!(
            s.governor.try_vote(0, true, U256::zero()),
            Err(Error::ZeroAmount.into())
        );
        s.governor.vote(0, false, tokens(10));
        assert_eq!(
            s.governor.try_vote(0, true, tokens(10)),
            Err(Error::OtherSide.into())
        );
        // More than was approved: the token refuses, and nothing is counted.
        assert!(s.governor.try_vote(0, false, tokens(991)).is_err());
        assert_eq!(s.governor.proposal(0).votes_against, tokens(10));
        assert_eq!(
            s.governor.try_vote(1, true, tokens(10)),
            Err(Error::ProposalNotFound.into())
        );

        s.env.advance_block_time(VOTING_PERIOD - 1);
        s.governor.vote(0, false, tokens(5));
        s.env.advance_block_time(1);
        assert_eq!(
            s.governor.try_vote(0, false, tokens(5)),
            Err(Error::VotingClosed.into())
        );

        // A defeated proposal returns the deposits too; a stranger has nothing to take back.
        assert_eq!(s.governor.state(0), ProposalState::Defeated);
        s.env.set_caller(s.env.get_account(2));
        assert_eq!(
            s.governor.try_withdraw(0),
            Err(Error::NothingToWithdraw.into())
        );
        s.env.set_caller(voter);
        s.governor.withdraw(0);
        assert_eq!(s.token.balance_of(&voter), TestToken::faucet_amount());
    }

    #[test]
    fn only_a_queued_proposal_is_executed() {
        let mut s = setup();
        let voter = s.env.get_account(1);
        fund(&mut s, voter);
        s.governor.propose(250);
        s.governor.vote(0, true, tokens(500));
        assert_eq!(s.governor.try_execute(0), Err(Error::NotQueued.into()));
        assert_eq!(
            s.governor.try_execute(9),
            Err(Error::ProposalNotFound.into())
        );

        s.env.advance_block_time(VOTING_PERIOD);
        s.governor.queue(0);
        s.env.advance_block_time(MINUTE);
        // The timelock is open: anyone may run the operation directly. The governor then
        // reports the error of the timelock.
        s.env.set_caller(s.env.get_account(3));
        s.timelock.execute(0);
        assert_eq!(s.config.fee_bps(), 250);
        assert_eq!(
            s.governor.try_execute(0),
            Err(TimelockError::AlreadyExecuted.into())
        );
    }

    #[test]
    fn the_voting_period_is_not_zero() {
        let env = odra_test::env();
        let any = env.get_account(1);
        let result = Governor::try_deploy(
            &env,
            GovernorInitArgs {
                token: any,
                timelock: any,
                fee_config: any,
                voting_period: 0,
                quorum: U256::zero(),
                proposal_threshold: U256::zero(),
            },
        );
        assert_eq!(result.err(), Some(Error::InvalidVotingPeriod.into()));
    }
}
