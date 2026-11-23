//! Merkle airdrop: a drop of CEP-18 tokens that each recipient claims with a proof.

use crate::merkle::{leaf_preimage, node_preimage, HASH_LENGTH};
use odra::casper_types::bytesrepr::Bytes;
use odra::casper_types::U256;
use odra::prelude::*;
use odra::ContractRef;
use odra_modules::cep18_token::Cep18ContractRef;

/// A drop: tokens held for the recipients of a list the contract knows only by its root.
#[odra::odra_type]
pub struct Drop {
    /// The account that funded the drop and may take back what is left after the deadline.
    pub creator: Address,
    /// The CEP-18 token being dropped.
    pub token: Address,
    /// The Merkle root of the list of recipients and amounts: 32 bytes.
    pub root: Bytes,
    /// The amount the creator put in: the sum of the list.
    pub total: U256,
    /// The amount claimed so far.
    pub claimed: U256,
    /// The number of entries on the list, as the creator stated it. Shown, never checked.
    pub recipients: u32,
    /// The number of claims made so far.
    pub claims: u32,
    /// Block time (milliseconds since the Unix epoch) from which nothing more can be claimed and
    /// the creator may take back the rest. Zero for a drop that stays open for ever.
    pub deadline: u64,
    /// The amount the creator took back after the deadline.
    pub reclaimed: U256,
}

/// Errors of the airdrop contract.
#[odra::odra_error]
pub enum Error {
    /// The total of the drop is zero.
    ZeroAmount = 1,
    /// The drop has no recipients.
    NoRecipients = 2,
    /// The root is not 32 bytes long.
    InvalidRoot = 3,
    /// The deadline has already passed.
    DeadlineInPast = 4,
    /// No drop has this id.
    DropNotFound = 5,
    /// The deadline of the drop has passed: nothing more can be claimed.
    ClaimsClosed = 6,
    /// The recipient has already claimed from this drop.
    AlreadyClaimed = 7,
    /// The proof does not show that the recipient and amount are on the list.
    InvalidProof = 8,
    /// The claim is larger than what is left of the drop.
    ExceedsDrop = 9,
    /// Only the creator of the drop may do this.
    NotCreator = 10,
    /// The drop has no deadline, so nothing can be taken back.
    NoDeadline = 11,
    /// The deadline of the drop has not passed yet.
    DeadlineNotReached = 12,
    /// Everything has been claimed or taken back already.
    NothingToReclaim = 13,
}

/// A drop was created and funded.
#[odra::event]
pub struct DropCreated {
    pub drop_id: u64,
    pub creator: Address,
    pub token: Address,
    pub root: Bytes,
    pub total: U256,
    pub recipients: u32,
    pub deadline: u64,
}

/// A recipient claimed their amount.
#[odra::event]
pub struct TokensClaimed {
    pub drop_id: u64,
    pub recipient: Address,
    pub amount: U256,
}

/// The creator took back what was left after the deadline.
#[odra::event]
pub struct DropReclaimed {
    pub drop_id: u64,
    pub creator: Address,
    pub amount: U256,
}

/// Holds drops of CEP-18 tokens and pays each recipient who proves they are on the list.
///
/// Anyone can create a drop for any CEP-18 token; the contract has no owner and no fees.
#[odra::module(
    events = [DropCreated, TokensClaimed, DropReclaimed],
    errors = Error
)]
pub struct Airdrop {
    /// Drops by id.
    drops: Mapping<u64, Drop>,
    /// The number of drops created; also the id of the next one.
    count: Var<u64>,
    /// Whether a recipient has claimed from a drop, by drop id and recipient.
    claimed: Mapping<(u64, Address), bool>,
}

#[odra::module]
impl Airdrop {
    /// Creates a drop and pulls `total` of `token` from the caller, who must have approved this
    /// contract for at least that amount. `root` is the Merkle root of the list (see
    /// `crate::merkle`), whose amounts should add up to `total`; `recipients` is the length of
    /// the list, kept for display. `deadline` is a block time in milliseconds, or zero for none.
    ///
    /// The id of the drop is the value `drops_count` returned before the call; the
    /// `DropCreated` event carries it.
    pub fn create_drop(
        &mut self,
        token: Address,
        root: Bytes,
        total: U256,
        recipients: u32,
        deadline: u64,
    ) {
        if total.is_zero() {
            self.env().revert(Error::ZeroAmount);
        }
        if recipients == 0 {
            self.env().revert(Error::NoRecipients);
        }
        if root.len() != HASH_LENGTH {
            self.env().revert(Error::InvalidRoot);
        }
        if deadline != 0 && deadline <= self.env().get_block_time() {
            self.env().revert(Error::DeadlineInPast);
        }

        let creator = self.env().caller();
        let drop_id = self.count.get_or_default();
        self.count.set(drop_id + 1);
        self.drops.set(
            &drop_id,
            Drop {
                creator,
                token,
                root: root.clone(),
                total,
                claimed: U256::zero(),
                recipients,
                claims: 0,
                deadline,
                reclaimed: U256::zero(),
            },
        );

        Cep18ContractRef::new(self.env(), token).transfer_from(
            &creator,
            &self.env().self_address(),
            &total,
        );

        self.env().emit_event(DropCreated {
            drop_id,
            creator,
            token,
            root,
            total,
            recipients,
            deadline,
        });
    }

    /// Pays `amount` of drop `drop_id` to `recipient`, if `proof` shows that the pair is on the
    /// list and the recipient has not claimed before. `proof` is the nodes of the proof one after
    /// another, 32 bytes each. Anyone may call it; the tokens always go to `recipient`.
    pub fn claim(&mut self, drop_id: u64, recipient: Address, amount: U256, proof: Bytes) {
        let mut drop = self.get_drop(drop_id);
        if drop.deadline != 0 && self.env().get_block_time() >= drop.deadline {
            self.env().revert(Error::ClaimsClosed);
        }
        if self.claimed.get_or_default(&(drop_id, recipient)) {
            self.env().revert(Error::AlreadyClaimed);
        }
        if !self.verify(&drop.root, &recipient, &amount, &proof) {
            self.env().revert(Error::InvalidProof);
        }
        // A list that adds up to more than the drop holds must not reach other drops' tokens.
        if amount > drop.total - drop.claimed {
            self.env().revert(Error::ExceedsDrop);
        }

        self.claimed.set(&(drop_id, recipient), true);
        drop.claimed += amount;
        drop.claims += 1;
        self.drops.set(&drop_id, drop.clone());

        Cep18ContractRef::new(self.env(), drop.token).transfer(&recipient, &amount);

        self.env().emit_event(TokensClaimed {
            drop_id,
            recipient,
            amount,
        });
    }

    /// Sends what was not claimed back to the creator, once the deadline has passed. Only the
    /// creator may call it.
    pub fn reclaim(&mut self, drop_id: u64) {
        let mut drop = self.get_drop(drop_id);
        if self.env().caller() != drop.creator {
            self.env().revert(Error::NotCreator);
        }
        if drop.deadline == 0 {
            self.env().revert(Error::NoDeadline);
        }
        if self.env().get_block_time() < drop.deadline {
            self.env().revert(Error::DeadlineNotReached);
        }
        let amount = drop.total - drop.claimed - drop.reclaimed;
        if amount.is_zero() {
            self.env().revert(Error::NothingToReclaim);
        }

        drop.reclaimed += amount;
        self.drops.set(&drop_id, drop.clone());

        Cep18ContractRef::new(self.env(), drop.token).transfer(&drop.creator, &amount);

        self.env().emit_event(DropReclaimed {
            drop_id,
            creator: drop.creator,
            amount,
        });
    }

    /// Returns the drop with the given id.
    pub fn drop(&self, drop_id: u64) -> Drop {
        self.get_drop(drop_id)
    }

    /// Returns the number of drops created. Ids run from `0` to `count - 1`.
    pub fn drops_count(&self) -> u64 {
        self.count.get_or_default()
    }

    /// Returns whether `recipient` has claimed from drop `drop_id`.
    pub fn is_claimed(&self, drop_id: u64, recipient: Address) -> bool {
        self.claimed.get_or_default(&(drop_id, recipient))
    }
}

impl Airdrop {
    fn get_drop(&self, drop_id: u64) -> Drop {
        self.drops
            .get(&drop_id)
            .unwrap_or_revert_with(self, Error::DropNotFound)
    }

    /// Whether `proof` leads from the leaf of `recipient` and `amount` to `root`.
    fn verify(&self, root: &Bytes, recipient: &Address, amount: &U256, proof: &Bytes) -> bool {
        if !proof.len().is_multiple_of(HASH_LENGTH) {
            return false;
        }
        let env = self.env();
        let mut node = env.hash(leaf_preimage(recipient, amount));
        for chunk in proof.chunks_exact(HASH_LENGTH) {
            let mut partner = [0u8; HASH_LENGTH];
            partner.copy_from_slice(chunk);
            node = env.hash(node_preimage(&node, &partner));
        }
        node.as_slice() == root.as_slice()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::merkle::Tree;
    use crate::token::{TestToken, TestTokenHostRef};
    use odra::host::{Deployer, HostEnv, NoArgs};
    use odra_modules::cep18::errors::Error as Cep18Error;

    const DAY: u64 = 24 * 60 * 60 * 1000;

    struct Setup {
        env: HostEnv,
        token: TestTokenHostRef,
        airdrop: AirdropHostRef,
        creator: Address,
        /// The list of the drop `create` makes: accounts 2, 3 and 4.
        list: Vec<(Address, U256)>,
        tree: Tree,
    }

    /// Deploys both contracts and gives the creator tokens and an allowance for all of them.
    fn setup() -> Setup {
        let env = odra_test::env();
        let creator = env.get_account(1);
        let mut token = TestToken::deploy(&env, NoArgs);
        let airdrop = Airdrop::deploy(&env, NoArgs);

        env.set_caller(creator);
        token.faucet();
        token.approve(&airdrop.address(), &TestToken::faucet_amount());

        let list = vec![
            (env.get_account(2), U256::from(100)),
            (env.get_account(3), U256::from(250)),
            (env.get_account(4), U256::from(650)),
        ];
        let tree = Tree::new(&list);
        Setup {
            env,
            token,
            airdrop,
            creator,
            list,
            tree,
        }
    }

    fn root_of(tree: &Tree) -> Bytes {
        Bytes::from(tree.root().to_vec())
    }

    /// Creates a drop of the setup's list, 1000 units, with the given deadline.
    fn create(s: &mut Setup, deadline: u64) -> u64 {
        let id = s.airdrop.drops_count();
        s.env.set_caller(s.creator);
        s.airdrop.create_drop(
            s.token.address(),
            root_of(&s.tree),
            U256::from(1000),
            3,
            deadline,
        );
        id
    }

    fn claim(s: &mut Setup, id: u64, index: usize) -> Result<(), OdraError> {
        let (recipient, amount) = s.list[index];
        s.airdrop
            .try_claim(id, recipient, amount, s.tree.proof_bytes(index))
    }

    #[test]
    fn creating_a_drop_pulls_the_tokens() {
        let mut s = setup();
        let deadline = s.env.block_time() + 30 * DAY;
        let id = create(&mut s, deadline);

        assert_eq!(id, 0);
        assert_eq!(s.airdrop.drops_count(), 1);
        assert_eq!(s.token.balance_of(&s.airdrop.address()), U256::from(1000));
        assert_eq!(
            s.airdrop.drop(id),
            Drop {
                creator: s.creator,
                token: s.token.address(),
                root: root_of(&s.tree),
                total: U256::from(1000),
                claimed: U256::zero(),
                recipients: 3,
                claims: 0,
                deadline,
                reclaimed: U256::zero(),
            }
        );
        assert!(s.env.emitted_event(
            &s.airdrop,
            DropCreated {
                drop_id: 0,
                creator: s.creator,
                token: s.token.address(),
                root: root_of(&s.tree),
                total: U256::from(1000),
                recipients: 3,
                deadline,
            }
        ));
        assert_eq!(create(&mut s, 0), 1);
    }

    #[test]
    fn each_recipient_claims_their_amount_once() {
        let mut s = setup();
        let id = create(&mut s, 0);

        // Anyone may send the claim; the tokens go to the recipient.
        s.env.set_caller(s.env.get_account(7));
        for index in 0..3 {
            let (recipient, amount) = s.list[index];
            assert!(!s.airdrop.is_claimed(id, recipient));
            claim(&mut s, id, index).unwrap();
            assert_eq!(s.token.balance_of(&recipient), amount);
            assert!(s.airdrop.is_claimed(id, recipient));
            assert!(s.env.emitted_event(
                &s.airdrop,
                TokensClaimed {
                    drop_id: id,
                    recipient,
                    amount
                }
            ));
            assert_eq!(claim(&mut s, id, index), Err(Error::AlreadyClaimed.into()));
        }
        let drop = s.airdrop.drop(id);
        assert_eq!(drop.claimed, U256::from(1000));
        assert_eq!(drop.claims, 3);
        assert_eq!(s.token.balance_of(&s.airdrop.address()), U256::zero());
        assert_eq!(s.token.balance_of(&s.env.get_account(7)), U256::zero());
    }

    #[test]
    fn a_wrong_claim_is_rejected() {
        let mut s = setup();
        let id = create(&mut s, 0);
        let (recipient, amount) = s.list[1];
        let proof = s.tree.proof_bytes(1);

        // Another amount, another recipient, another entry's proof, a cut proof.
        let mut try_claim = |recipient: Address, amount: U256, proof: Bytes| {
            s.airdrop.try_claim(id, recipient, amount, proof)
        };
        let invalid = Err(Error::InvalidProof.into());
        assert_eq!(try_claim(recipient, amount + 1, proof.clone()), invalid);
        assert_eq!(try_claim(s.list[0].0, amount, proof.clone()), invalid);
        assert_eq!(try_claim(recipient, amount, s.tree.proof_bytes(0)), invalid);
        assert_eq!(
            try_claim(recipient, amount, Bytes::from(proof[..32].to_vec())),
            invalid
        );
        assert_eq!(
            try_claim(recipient, amount, Bytes::from(proof[..40].to_vec())),
            invalid
        );
        assert_eq!(try_claim(recipient, amount, Bytes::new()), invalid);
        assert_eq!(
            s.airdrop.try_claim(7, recipient, amount, proof.clone()),
            Err(Error::DropNotFound.into())
        );
        s.airdrop.claim(id, recipient, amount, proof);
    }

    #[test]
    fn a_list_worth_more_than_the_drop_cannot_take_other_drops_tokens() {
        let mut s = setup();
        // Drop 0 is funded with 1000 for the list. Drop 1 claims a list of 1000 but holds 10.
        create(&mut s, 0);
        s.env.set_caller(s.creator);
        s.airdrop
            .create_drop(s.token.address(), root_of(&s.tree), U256::from(10), 3, 0);

        assert_eq!(claim(&mut s, 1, 0), Err(Error::ExceedsDrop.into()));
        assert_eq!(s.token.balance_of(&s.airdrop.address()), U256::from(1010));
    }

    #[test]
    fn claims_close_at_the_deadline_and_the_creator_takes_back_the_rest() {
        let mut s = setup();
        let deadline = s.env.block_time() + 10 * DAY;
        let id = create(&mut s, deadline);
        claim(&mut s, id, 0).unwrap();

        s.env.set_caller(s.creator);
        assert_eq!(
            s.airdrop.try_reclaim(id),
            Err(Error::DeadlineNotReached.into())
        );

        s.env.advance_block_time(10 * DAY);
        assert_eq!(claim(&mut s, id, 1), Err(Error::ClaimsClosed.into()));

        s.env.set_caller(s.list[0].0);
        assert_eq!(s.airdrop.try_reclaim(id), Err(Error::NotCreator.into()));

        let before = s.token.balance_of(&s.creator);
        s.env.set_caller(s.creator);
        s.airdrop.reclaim(id);
        assert_eq!(s.token.balance_of(&s.creator), before + 900);
        assert_eq!(s.airdrop.drop(id).reclaimed, U256::from(900));
        assert!(s.env.emitted_event(
            &s.airdrop,
            DropReclaimed {
                drop_id: id,
                creator: s.creator,
                amount: U256::from(900)
            }
        ));
        assert_eq!(
            s.airdrop.try_reclaim(id),
            Err(Error::NothingToReclaim.into())
        );
    }

    #[test]
    fn a_drop_without_a_deadline_stays_open() {
        let mut s = setup();
        let id = create(&mut s, 0);
        s.env.advance_block_time(1000 * DAY);
        s.env.set_caller(s.creator);
        assert_eq!(s.airdrop.try_reclaim(id), Err(Error::NoDeadline.into()));
        claim(&mut s, id, 2).unwrap();
    }

    #[test]
    fn invalid_drops_are_rejected() {
        let s = setup();
        let mut airdrop = s.airdrop;
        let token = s.token.address();
        let root = root_of(&s.tree);
        s.env.advance_block_time(DAY);
        let now = s.env.block_time();
        s.env.set_caller(s.creator);

        let mut try_create = |root: Bytes, total: u64, recipients: u32, deadline: u64| {
            airdrop.try_create_drop(token, root, U256::from(total), recipients, deadline)
        };
        assert_eq!(
            try_create(root.clone(), 0, 3, 0),
            Err(Error::ZeroAmount.into())
        );
        assert_eq!(
            try_create(root.clone(), 1000, 0, 0),
            Err(Error::NoRecipients.into())
        );
        assert_eq!(
            try_create(Bytes::from(vec![1; 31]), 1000, 3, 0),
            Err(Error::InvalidRoot.into())
        );
        assert_eq!(
            try_create(root.clone(), 1000, 3, now),
            Err(Error::DeadlineInPast.into())
        );
        // More than the creator approved.
        assert_eq!(
            try_create(root, 1_000_000_000_000_000, 3, 0),
            Err(Cep18Error::InsufficientAllowance.into())
        );
    }

    #[test]
    fn unknown_drops_are_reported() {
        let mut s = setup();
        assert_eq!(s.airdrop.try_drop(7), Err(Error::DropNotFound.into()));
        assert_eq!(s.airdrop.try_reclaim(7), Err(Error::DropNotFound.into()));
    }

    #[test]
    fn a_recipient_may_be_a_contract() {
        let mut s = setup();
        let contract = s.token.address();
        let list = vec![
            (s.env.get_account(2), U256::from(5)),
            (contract, U256::from(7)),
        ];
        let tree = Tree::new(&list);
        s.env.set_caller(s.creator);
        s.airdrop
            .create_drop(contract, root_of(&tree), U256::from(12), 2, 0);
        s.airdrop
            .claim(0, contract, U256::from(7), tree.proof_bytes(1));
        assert_eq!(s.token.balance_of(&contract), U256::from(7));
    }

    /// Prints the gas report on CasperVM (`cargo odra test -b casper`); does nothing on OdraVM.
    fn print_gas_report(env: &HostEnv, what: &str) {
        if std::env::var("ODRA_BACKEND").as_deref() == Ok("casper") {
            println!("Gas report of {what}:\n{}", env.gas_report());
        }
    }

    /// The gas of a claim with a proof of 10 nodes: a list of 1,000 recipients.
    #[test]
    fn gas_of_a_claim_from_a_list_of_a_thousand() {
        let mut s = setup();
        let list: Vec<(Address, U256)> = (0..1000u64)
            .map(|i| (s.env.get_account((2 + i % 8) as usize), U256::from(i + 1)))
            .collect();
        let tree = Tree::new(&list);
        let total = list
            .iter()
            .fold(U256::zero(), |sum, (_, amount)| sum + amount);
        s.env.set_caller(s.creator);
        s.airdrop
            .create_drop(s.token.address(), root_of(&tree), total, 1000, 0);
        let index = 517;
        assert_eq!(tree.proof(index).len(), 10);
        let (recipient, amount) = list[index];
        s.airdrop
            .claim(0, recipient, amount, tree.proof_bytes(index));
        assert_eq!(s.token.balance_of(&recipient), amount);
        print_gas_report(&s.env, "a claim at depth 10");
    }

    /// The gas of taking back what is left after the deadline.
    #[test]
    fn gas_of_a_reclaim() {
        let mut s = setup();
        let deadline = s.env.block_time() + DAY;
        let id = create(&mut s, deadline);
        claim(&mut s, id, 0).unwrap();
        s.env.advance_block_time(DAY);
        s.env.set_caller(s.creator);
        s.airdrop.reclaim(id);
        assert_eq!(s.airdrop.drop(id).reclaimed, U256::from(900));
        print_gas_report(&s.env, "a reclaim");
    }

    /// The demo of the command line tool, call for call with its gas limits, from the deploy on.
    #[test]
    fn the_demo_runs_to_the_end() {
        let env = odra_test::env();
        let mut token = TestToken::deploy(&env, NoArgs);
        env.set_gas(crate::demo::DEPLOY_GAS);
        let mut airdrop = Airdrop::deploy(&env, NoArgs);
        let caller = env.caller();
        let now = env.block_time();

        let drop = crate::demo::run(&env, &mut token, &mut airdrop, now).unwrap();

        assert_eq!(drop.id, 0);
        assert_eq!(
            token.balance_of(&caller),
            TestToken::faucet_amount() - 15_000_000_000u64
        );
        let stored = airdrop.drop(0);
        assert_eq!(stored.claimed, U256::from(25_000_000_000u64));
        assert_eq!(stored.deadline, now + crate::demo::OPEN_FOR);
        assert!(airdrop.is_claimed(0, caller));
        assert_eq!(drop.list_text.lines().count(), 3);
        // The list is printed the way the web app reads it.
        assert!(drop
            .list_text
            .lines()
            .all(|line| line.starts_with("account-hash-")));
        print_gas_report(&env, "the demo");
    }
}
