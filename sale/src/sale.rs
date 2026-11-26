//! Token sale: a creator sells a CEP-18 token for CSPR at a fixed price, within a time window, up
//! to a total cap and a limit per wallet, optionally only to the addresses of an allowlist.

// `create_sale` takes the seven terms of a sale, and the constructor `#[odra::event]` generates for
// `SaleCreated` takes its nine fields; an attribute on the struct does not reach that constructor.
#![allow(clippy::too_many_arguments)]

use crate::merkle::{leaf_preimage, node_preimage, HASH_LENGTH};
use odra::casper_types::bytesrepr::Bytes;
use odra::casper_types::{U256, U512};
use odra::prelude::*;
use odra::ContractRef;
use odra_modules::cep18_token::Cep18ContractRef;

/// The most decimals a token on sale may have. `10^decimals` times the CSPR of a purchase must
/// fit the contract's arithmetic; real tokens have 18 or fewer.
pub const MAX_DECIMALS: u8 = 30;

/// A sale: tokens the creator put in, sold at a fixed price between `start` and `end`.
#[odra::odra_type]
pub struct Sale {
    /// The account that created the sale, and the only one that takes its CSPR and what is unsold.
    pub creator: Address,
    /// The CEP-18 token on sale.
    pub token: Address,
    /// The decimals of the token, read from it when the sale was created.
    pub decimals: u8,
    /// The price of one whole token (`10^decimals` of its smallest unit), in motes.
    pub price: U512,
    /// The most that can be sold, in the smallest unit of the token. The creator put in this much.
    pub cap: U256,
    /// The most one address can buy over the whole sale, in the smallest unit of the token.
    pub per_wallet: U256,
    /// Block time (milliseconds since the Unix epoch) of the first moment buying is open.
    pub start: u64,
    /// Block time of the first moment buying is closed; from then on the creator may take back
    /// what is unsold.
    pub end: u64,
    /// The Merkle root of the allowlist (see `crate::merkle`), 32 bytes; empty for a sale open to
    /// everyone.
    pub allowlist_root: Bytes,
    /// Tokens sold so far, in the smallest unit.
    pub sold: U256,
    /// CSPR paid so far, in motes.
    pub raised: U512,
    /// The number of different addresses that have bought.
    pub buyers: u32,
    /// CSPR the creator has taken out so far, in motes.
    pub withdrawn: U512,
    /// Unsold tokens the creator has taken back after the end.
    pub reclaimed: U256,
}

/// Errors of the sale contract.
#[odra::odra_error]
pub enum Error {
    /// The price is zero.
    ZeroPrice = 1,
    /// The cap is zero.
    ZeroCap = 2,
    /// The limit per wallet is zero or larger than the cap.
    InvalidWalletLimit = 3,
    /// The end is not after the start.
    InvalidWindow = 4,
    /// The end has already passed.
    EndInPast = 5,
    /// The allowlist root is neither empty nor 32 bytes long.
    InvalidRoot = 6,
    /// The token has more than `MAX_DECIMALS` decimals.
    UnsupportedDecimals = 7,
    /// No sale has this id.
    SaleNotFound = 8,
    /// The sale has not started yet.
    NotStarted = 9,
    /// The sale has ended.
    Ended = 10,
    /// No CSPR was attached to the purchase.
    NothingAttached = 11,
    /// The CSPR attached does not buy a whole number of the token's smallest unit.
    InexactPayment = 12,
    /// The purchase is larger than what is left of the cap.
    ExceedsCap = 13,
    /// The purchase takes the buyer past the limit per wallet.
    ExceedsWalletLimit = 14,
    /// The proof does not show that the buyer is on the allowlist.
    NotOnAllowlist = 15,
    /// Only the creator of the sale may do this.
    NotCreator = 16,
    /// There is no CSPR to take out.
    NothingToWithdraw = 17,
    /// The sale has not ended yet.
    NotEnded = 18,
    /// Everything was sold or taken back already.
    NothingUnsold = 19,
}

/// A sale was created and its tokens put in.
#[odra::event]
pub struct SaleCreated {
    pub sale_id: u64,
    pub creator: Address,
    pub token: Address,
    pub price: U512,
    pub cap: U256,
    pub per_wallet: U256,
    pub start: u64,
    pub end: u64,
    pub allowlist_root: Bytes,
}

/// A buyer paid `paid` motes for `amount` of the token.
#[odra::event]
pub struct TokensBought {
    pub sale_id: u64,
    pub buyer: Address,
    pub amount: U256,
    pub paid: U512,
}

/// The creator took out the CSPR paid so far.
#[odra::event]
pub struct ProceedsWithdrawn {
    pub sale_id: u64,
    pub creator: Address,
    pub amount: U512,
}

/// The creator took back the tokens left unsold after the end.
#[odra::event]
pub struct UnsoldWithdrawn {
    pub sale_id: u64,
    pub creator: Address,
    pub amount: U256,
}

/// Sells CEP-18 tokens for CSPR at a fixed price. Holds every sale, of every token.
///
/// Anyone can create a sale; the contract has no owner and no fees.
#[odra::module(
    events = [SaleCreated, TokensBought, ProceedsWithdrawn, UnsoldWithdrawn],
    errors = Error
)]
pub struct TokenSale {
    /// Sales by id.
    sales: Mapping<u64, Sale>,
    /// The number of sales created; also the id of the next one.
    count: Var<u64>,
    /// What an address has bought from a sale, by sale id and buyer, in the smallest unit.
    bought: Mapping<(u64, Address), U256>,
    /// The ids of the sales an address created, oldest first.
    sales_of_creator: Mapping<Address, Vec<u64>>,
}

#[odra::module]
impl TokenSale {
    /// Creates a sale and pulls `cap` of `token` from the caller, who must have approved this
    /// contract for at least that amount.
    ///
    /// `price` is the price of one whole token in motes; `cap` and `per_wallet` are in the
    /// token's smallest unit. Buying is open from block time `start` until `end` (milliseconds,
    /// `start` may be in the past). `allowlist_root` is the Merkle root of the addresses that may
    /// buy (see `crate::merkle`), or empty for a sale open to everyone.
    ///
    /// The id of the sale is the value `sales_count` returned before the call; the `SaleCreated`
    /// event carries it.
    pub fn create_sale(
        &mut self,
        token: Address,
        price: U512,
        cap: U256,
        per_wallet: U256,
        start: u64,
        end: u64,
        allowlist_root: Bytes,
    ) {
        if price.is_zero() {
            self.env().revert(Error::ZeroPrice);
        }
        if cap.is_zero() {
            self.env().revert(Error::ZeroCap);
        }
        if per_wallet.is_zero() || per_wallet > cap {
            self.env().revert(Error::InvalidWalletLimit);
        }
        if end <= start {
            self.env().revert(Error::InvalidWindow);
        }
        if end <= self.env().get_block_time() {
            self.env().revert(Error::EndInPast);
        }
        if !allowlist_root.is_empty() && allowlist_root.len() != HASH_LENGTH {
            self.env().revert(Error::InvalidRoot);
        }
        let mut token_ref = Cep18ContractRef::new(self.env(), token);
        let decimals = token_ref.decimals();
        if decimals > MAX_DECIMALS {
            self.env().revert(Error::UnsupportedDecimals);
        }

        let creator = self.env().caller();
        let sale_id = self.count.get_or_default();
        self.count.set(sale_id + 1);
        self.sales.set(
            &sale_id,
            Sale {
                creator,
                token,
                decimals,
                price,
                cap,
                per_wallet,
                start,
                end,
                allowlist_root: allowlist_root.clone(),
                sold: U256::zero(),
                raised: U512::zero(),
                buyers: 0,
                withdrawn: U512::zero(),
                reclaimed: U256::zero(),
            },
        );
        let mut ids = self.sales_of_creator.get_or_default(&creator);
        ids.push(sale_id);
        self.sales_of_creator.set(&creator, ids);

        token_ref.transfer_from(&creator, &self.env().self_address(), &cap);

        self.env().emit_event(SaleCreated {
            sale_id,
            creator,
            token,
            price,
            cap,
            per_wallet,
            start,
            end,
            allowlist_root,
        });
    }

    /// Buys tokens of sale `sale_id` with the CSPR attached to the call and sends them to the
    /// caller. The CSPR buys `attached × 10^decimals / price` of the smallest unit, which must
    /// come out whole: the call reverts rather than keep CSPR that buys nothing.
    ///
    /// `proof` shows that the caller is on the allowlist: the nodes one after another, 32 bytes
    /// each. A sale without an allowlist ignores it.
    #[odra(payable)]
    pub fn buy(&mut self, sale_id: u64, proof: Bytes) {
        let mut sale = self.get_sale(sale_id);
        let now = self.env().get_block_time();
        if now < sale.start {
            self.env().revert(Error::NotStarted);
        }
        if now >= sale.end {
            self.env().revert(Error::Ended);
        }
        let buyer = self.env().caller();
        if !sale.allowlist_root.is_empty() && !self.verify(&sale.allowlist_root, &buyer, &proof) {
            self.env().revert(Error::NotOnAllowlist);
        }
        let paid = self.env().attached_value();
        if paid.is_zero() {
            self.env().revert(Error::NothingAttached);
        }

        let amount = self.amount_for(&sale, paid);
        let bought = self.bought.get_or_default(&(sale_id, buyer));
        if bought + amount > sale.per_wallet {
            self.env().revert(Error::ExceedsWalletLimit);
        }

        if bought.is_zero() {
            sale.buyers += 1;
        }
        sale.sold += amount;
        sale.raised += paid;
        self.bought.set(&(sale_id, buyer), bought + amount);
        self.sales.set(&sale_id, sale.clone());

        Cep18ContractRef::new(self.env(), sale.token).transfer(&buyer, &amount);

        self.env().emit_event(TokensBought {
            sale_id,
            buyer,
            amount,
            paid,
        });
    }

    /// Sends the CSPR paid so far and not yet taken out to the creator. At any time, also while
    /// the sale runs. Only the creator may call it.
    pub fn withdraw_proceeds(&mut self, sale_id: u64) {
        let mut sale = self.get_creators_sale(sale_id);
        let amount = sale.raised - sale.withdrawn;
        if amount.is_zero() {
            self.env().revert(Error::NothingToWithdraw);
        }

        sale.withdrawn += amount;
        self.sales.set(&sale_id, sale.clone());

        self.env().transfer_tokens(&sale.creator, &amount);

        self.env().emit_event(ProceedsWithdrawn {
            sale_id,
            creator: sale.creator,
            amount,
        });
    }

    /// Sends the tokens left unsold back to the creator, once the sale has ended. Only the creator
    /// may call it.
    pub fn withdraw_unsold(&mut self, sale_id: u64) {
        let mut sale = self.get_creators_sale(sale_id);
        if self.env().get_block_time() < sale.end {
            self.env().revert(Error::NotEnded);
        }
        let amount = sale.cap - sale.sold - sale.reclaimed;
        if amount.is_zero() {
            self.env().revert(Error::NothingUnsold);
        }

        sale.reclaimed += amount;
        self.sales.set(&sale_id, sale.clone());

        Cep18ContractRef::new(self.env(), sale.token).transfer(&sale.creator, &amount);

        self.env().emit_event(UnsoldWithdrawn {
            sale_id,
            creator: sale.creator,
            amount,
        });
    }

    /// Returns the sale with the given id.
    pub fn sale(&self, sale_id: u64) -> Sale {
        self.get_sale(sale_id)
    }

    /// Returns the number of sales created. Ids run from `0` to `count - 1`.
    pub fn sales_count(&self) -> u64 {
        self.count.get_or_default()
    }

    /// Returns the ids of the sales `creator` created, oldest first.
    pub fn sales_of_creator(&self, creator: Address) -> Vec<u64> {
        self.sales_of_creator.get_or_default(&creator)
    }

    /// Returns what `buyer` has bought from sale `sale_id`, in the smallest unit of the token.
    pub fn bought_by(&self, sale_id: u64, buyer: Address) -> U256 {
        self.bought.get_or_default(&(sale_id, buyer))
    }

    /// Returns what `paid` motes buy from sale `sale_id`, in the smallest unit of the token.
    /// Reverts as `buy` would if the amount is not whole or is more than is left; ignores the
    /// window, the wallet limit and the allowlist.
    pub fn quote(&self, sale_id: u64, paid: U512) -> U256 {
        let sale = self.get_sale(sale_id);
        self.amount_for(&sale, paid)
    }
}

impl TokenSale {
    fn get_sale(&self, sale_id: u64) -> Sale {
        self.sales
            .get(&sale_id)
            .unwrap_or_revert_with(self, Error::SaleNotFound)
    }

    fn get_creators_sale(&self, sale_id: u64) -> Sale {
        let sale = self.get_sale(sale_id);
        if self.env().caller() != sale.creator {
            self.env().revert(Error::NotCreator);
        }
        sale
    }

    /// What `paid` motes buy: `paid × 10^decimals / price`, which must be whole and fit in what
    /// is left of the cap.
    fn amount_for(&self, sale: &Sale, paid: U512) -> U256 {
        // At most 10^30 × the CSPR in existence (about 10^19 motes): far below the U512 limit.
        let scaled = paid * U512::from(10u64).pow(U512::from(sale.decimals));
        if !(scaled % sale.price).is_zero() {
            self.env().revert(Error::InexactPayment);
        }
        let amount = scaled / sale.price;
        let left = sale.cap - sale.sold;
        if amount > to_u512(left) {
            self.env().revert(Error::ExceedsCap);
        }
        to_u256(amount)
    }

    /// Whether `proof` leads from the leaf of `buyer` to `root`.
    fn verify(&self, root: &Bytes, buyer: &Address, proof: &Bytes) -> bool {
        if !proof.len().is_multiple_of(HASH_LENGTH) {
            return false;
        }
        let env = self.env();
        let mut node = env.hash(leaf_preimage(buyer));
        for chunk in proof.chunks_exact(HASH_LENGTH) {
            let mut partner = [0u8; HASH_LENGTH];
            partner.copy_from_slice(chunk);
            node = env.hash(node_preimage(&node, &partner));
        }
        node.as_slice() == root.as_slice()
    }
}

/// A token amount as a U512, for comparing with an amount worked out from CSPR.
fn to_u512(value: U256) -> U512 {
    let mut bytes = [0u8; 32];
    value.to_little_endian(&mut bytes);
    U512::from_little_endian(&bytes)
}

/// A U512 known to be at most a U256 (it was compared with one).
fn to_u256(value: U512) -> U256 {
    let mut bytes = [0u8; 64];
    value.to_little_endian(&mut bytes);
    U256::from_little_endian(&bytes[..32])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::merkle::Tree;
    use crate::token::{TestToken, TestTokenHostRef};
    use odra::host::{Deployer, HostEnv, HostRef, NoArgs};
    use odra_modules::cep18::errors::Error as Cep18Error;

    const DAY: u64 = 24 * 60 * 60 * 1000;
    /// One whole TEST, in its smallest unit.
    const TEST: u64 = 1_000_000_000;
    /// One CSPR, in motes.
    const CSPR: u64 = 1_000_000_000;

    fn on_casper() -> bool {
        std::env::var("ODRA_BACKEND").as_deref() == Ok("casper")
    }

    struct Setup {
        env: HostEnv,
        token: TestTokenHostRef,
        sale: TokenSaleHostRef,
        creator: Address,
    }

    /// Deploys both contracts and gives the creator 1,000 TEST and an allowance for all of them.
    fn setup() -> Setup {
        let env = odra_test::env();
        let creator = env.get_account(1);
        let mut token = TestToken::deploy(&env, NoArgs);
        let sale = TokenSale::deploy(&env, NoArgs);

        env.set_caller(creator);
        token.faucet();
        token.approve(&sale.address(), &TestToken::faucet_amount());
        Setup {
            env,
            token,
            sale,
            creator,
        }
    }

    /// The terms `create` uses unless a test changes them: 2 CSPR per TEST, 100 TEST on sale, 30
    /// per wallet, open from now for 10 days, no allowlist.
    struct Terms {
        price: U512,
        cap: U256,
        per_wallet: U256,
        start: u64,
        end: u64,
        root: Bytes,
    }

    fn terms(s: &Setup) -> Terms {
        let now = s.env.block_time();
        Terms {
            price: U512::from(2 * CSPR),
            cap: U256::from(100 * TEST),
            per_wallet: U256::from(30 * TEST),
            start: now,
            end: now + 10 * DAY,
            root: Bytes::new(),
        }
    }

    fn try_create(s: &mut Setup, t: &Terms) -> OdraResult<u64> {
        let id = s.sale.sales_count();
        s.env.set_caller(s.creator);
        s.sale.try_create_sale(
            s.token.address(),
            t.price,
            t.cap,
            t.per_wallet,
            t.start,
            t.end,
            t.root.clone(),
        )?;
        Ok(id)
    }

    fn create(s: &mut Setup, t: &Terms) -> u64 {
        try_create(s, t).unwrap()
    }

    fn buy(s: &Setup, buyer: Address, id: u64, motes: u64, proof: Bytes) -> OdraResult<()> {
        s.env.set_caller(buyer);
        s.sale.with_tokens(U512::from(motes)).try_buy(id, proof)
    }

    #[test]
    fn creating_a_sale_pulls_the_tokens_and_stores_it() {
        let mut s = setup();
        let t = terms(&s);
        let id = create(&mut s, &t);

        assert_eq!(id, 0);
        assert_eq!(s.sale.sales_count(), 1);
        assert_eq!(
            s.token.balance_of(&s.sale.address()),
            U256::from(100 * TEST)
        );
        assert_eq!(
            s.sale.sale(id),
            Sale {
                creator: s.creator,
                token: s.token.address(),
                decimals: 9,
                price: t.price,
                cap: t.cap,
                per_wallet: t.per_wallet,
                start: t.start,
                end: t.end,
                allowlist_root: Bytes::new(),
                sold: U256::zero(),
                raised: U512::zero(),
                buyers: 0,
                withdrawn: U512::zero(),
                reclaimed: U256::zero(),
            }
        );
        assert!(s.env.emitted_event(
            &s.sale,
            SaleCreated {
                sale_id: 0,
                creator: s.creator,
                token: s.token.address(),
                price: t.price,
                cap: t.cap,
                per_wallet: t.per_wallet,
                start: t.start,
                end: t.end,
                allowlist_root: Bytes::new(),
            }
        ));
        assert_eq!(create(&mut s, &t), 1);
        assert_eq!(s.sale.sales_of_creator(s.creator), vec![0, 1]);
        assert_eq!(
            s.sale.sales_of_creator(s.env.get_account(2)),
            Vec::<u64>::new()
        );
    }

    #[test]
    fn the_attached_cspr_buys_tokens_at_the_price() {
        let mut s = setup();
        let t = terms(&s);
        let id = create(&mut s, &t);
        let buyer = s.env.get_account(2);

        // 2 CSPR per TEST: 5 CSPR buy 2.5 TEST.
        buy(&s, buyer, id, 5 * CSPR, Bytes::new()).unwrap();

        let amount = U256::from(2_500_000_000u64);
        assert_eq!(s.token.balance_of(&buyer), amount);
        assert_eq!(s.sale.bought_by(id, buyer), amount);
        assert_eq!(s.env.balance_of(&s.sale), U512::from(5 * CSPR));
        let sale = s.sale.sale(id);
        assert_eq!(sale.sold, amount);
        assert_eq!(sale.raised, U512::from(5 * CSPR));
        assert_eq!(sale.buyers, 1);
        assert!(s.env.emitted_event(
            &s.sale,
            TokensBought {
                sale_id: id,
                buyer,
                amount,
                paid: U512::from(5 * CSPR)
            }
        ));

        // A second purchase adds up; the number of buyers stays.
        buy(&s, buyer, id, 3 * CSPR, Bytes::new()).unwrap();
        assert_eq!(s.sale.bought_by(id, buyer), U256::from(4 * TEST));
        assert_eq!(s.sale.sale(id).buyers, 1);
        buy(&s, s.env.get_account(3), id, 2 * CSPR, Bytes::new()).unwrap();
        assert_eq!(s.sale.sale(id).buyers, 2);
        assert_eq!(s.sale.sale(id).sold, U256::from(5 * TEST));
    }

    #[test]
    fn cspr_that_does_not_buy_a_whole_unit_is_refused() {
        let mut s = setup();
        // 3 CSPR per TEST: one smallest unit costs 3 motes.
        let t = Terms {
            price: U512::from(3 * CSPR),
            ..terms(&s)
        };
        let id = create(&mut s, &t);
        let buyer = s.env.get_account(2);

        for motes in [1, 2, 4, 5 * CSPR + 2] {
            assert_eq!(
                buy(&s, buyer, id, motes, Bytes::new()),
                Err(Error::InexactPayment.into()),
                "{motes} motes"
            );
        }
        assert_eq!(
            buy(&s, buyer, id, 0, Bytes::new()),
            Err(Error::NothingAttached.into())
        );
        assert_eq!(
            s.sale.try_quote(id, U512::from(4)),
            Err(Error::InexactPayment.into())
        );

        // 3 motes buy one smallest unit, 1 CSPR a third of a TEST.
        assert_eq!(s.sale.quote(id, U512::from(3)), U256::one());
        buy(&s, buyer, id, 3, Bytes::new()).unwrap();
        buy(&s, buyer, id, CSPR + 2, Bytes::new()).unwrap();
        assert_eq!(s.sale.bought_by(id, buyer), U256::from(333_333_335u64));
        assert_eq!(s.env.balance_of(&s.sale), U512::from(CSPR + 5));
    }

    #[test]
    fn a_price_below_one_mote_per_unit_sells_in_steps() {
        let mut s = setup();
        // 0.25 CSPR per TEST: one mote buys 4 smallest units, so any whole number of motes works.
        let t = Terms {
            price: U512::from(CSPR / 4),
            ..terms(&s)
        };
        let id = create(&mut s, &t);
        let buyer = s.env.get_account(2);
        buy(&s, buyer, id, 1, Bytes::new()).unwrap();
        buy(&s, buyer, id, CSPR, Bytes::new()).unwrap();
        assert_eq!(s.token.balance_of(&buyer), U256::from(4 * TEST + 4));
    }

    #[test]
    fn buying_is_open_from_the_start_until_the_end() {
        let mut s = setup();
        let now = s.env.block_time();
        let t = Terms {
            start: now + DAY,
            end: now + 2 * DAY,
            ..terms(&s)
        };
        let id = create(&mut s, &t);
        let buyer = s.env.get_account(2);

        assert_eq!(
            buy(&s, buyer, id, 2 * CSPR, Bytes::new()),
            Err(Error::NotStarted.into())
        );
        s.env.advance_block_time(DAY);
        buy(&s, buyer, id, 2 * CSPR, Bytes::new()).unwrap();
        s.env.advance_block_time(DAY);
        assert_eq!(
            buy(&s, buyer, id, 2 * CSPR, Bytes::new()),
            Err(Error::Ended.into())
        );
        assert_eq!(s.sale.bought_by(id, buyer), U256::from(TEST));
    }

    #[test]
    fn nobody_buys_past_the_cap_or_their_wallet_limit() {
        let mut s = setup();
        // 10 TEST on sale, 6 per wallet, 1 CSPR per TEST.
        let t = Terms {
            price: U512::from(CSPR),
            cap: U256::from(10 * TEST),
            per_wallet: U256::from(6 * TEST),
            ..terms(&s)
        };
        let id = create(&mut s, &t);
        let (alice, bob) = (s.env.get_account(2), s.env.get_account(3));

        assert_eq!(
            buy(&s, alice, id, 7 * CSPR, Bytes::new()),
            Err(Error::ExceedsWalletLimit.into())
        );
        buy(&s, alice, id, 4 * CSPR, Bytes::new()).unwrap();
        assert_eq!(
            buy(&s, alice, id, 3 * CSPR, Bytes::new()),
            Err(Error::ExceedsWalletLimit.into())
        );
        buy(&s, alice, id, 2 * CSPR, Bytes::new()).unwrap();

        assert_eq!(
            buy(&s, bob, id, 5 * CSPR, Bytes::new()),
            Err(Error::ExceedsCap.into())
        );
        buy(&s, bob, id, 4 * CSPR, Bytes::new()).unwrap();
        assert_eq!(s.sale.sale(id).sold, t.cap);
        assert_eq!(
            buy(&s, s.env.get_account(4), id, 1, Bytes::new()),
            Err(Error::ExceedsCap.into())
        );
        assert_eq!(s.token.balance_of(&s.sale.address()), U256::zero());
    }

    #[test]
    fn an_allowlisted_sale_sells_only_to_the_list() {
        let mut s = setup();
        let list = vec![
            s.env.get_account(2),
            s.env.get_account(3),
            s.env.get_account(4),
        ];
        let tree = Tree::new(&list);
        let t = Terms {
            root: tree.root_bytes(),
            ..terms(&s)
        };
        let id = create(&mut s, &t);
        let outsider = s.env.get_account(5);

        let refused = Err(Error::NotOnAllowlist.into());
        assert_eq!(buy(&s, list[1], id, 2 * CSPR, Bytes::new()), refused);
        assert_eq!(buy(&s, list[1], id, 2 * CSPR, tree.proof_bytes(0)), refused);
        let proof = tree.proof_bytes(1);
        assert_eq!(
            buy(&s, list[1], id, 2 * CSPR, Bytes::from(proof[..40].to_vec())),
            refused
        );
        // Someone else's proof does not let an outsider in.
        assert_eq!(buy(&s, outsider, id, 2 * CSPR, proof.clone()), refused);

        for (index, buyer) in list.iter().enumerate() {
            buy(&s, *buyer, id, 2 * CSPR, tree.proof_bytes(index)).unwrap();
            assert_eq!(s.token.balance_of(buyer), U256::from(TEST));
        }
        assert_eq!(s.sale.sale(id).buyers, 3);
    }

    #[test]
    fn a_sale_without_an_allowlist_ignores_the_proof() {
        let mut s = setup();
        let t = terms(&s);
        let id = create(&mut s, &t);
        buy(
            &s,
            s.env.get_account(2),
            id,
            2 * CSPR,
            Bytes::from(vec![7u8; 33]),
        )
        .unwrap();
    }

    #[test]
    fn the_creator_takes_out_the_cspr_at_any_time() {
        let mut s = setup();
        let t = terms(&s);
        let id = create(&mut s, &t);
        buy(&s, s.env.get_account(2), id, 6 * CSPR, Bytes::new()).unwrap();

        s.env.set_caller(s.env.get_account(2));
        assert_eq!(
            s.sale.try_withdraw_proceeds(id),
            Err(Error::NotCreator.into())
        );

        let before = s.env.balance_of(&s.creator);
        s.env.set_caller(s.creator);
        s.sale.withdraw_proceeds(id);
        assert_eq!(s.env.balance_of(&s.sale), U512::zero());
        if !on_casper() {
            // On CasperVM the creator also pays for the transaction.
            assert_eq!(s.env.balance_of(&s.creator), before + U512::from(6 * CSPR));
        }
        assert_eq!(s.sale.sale(id).withdrawn, U512::from(6 * CSPR));
        assert!(s.env.emitted_event(
            &s.sale,
            ProceedsWithdrawn {
                sale_id: id,
                creator: s.creator,
                amount: U512::from(6 * CSPR)
            }
        ));
        assert_eq!(
            s.sale.try_withdraw_proceeds(id),
            Err(Error::NothingToWithdraw.into())
        );

        // Only what was paid since.
        buy(&s, s.env.get_account(3), id, 4 * CSPR, Bytes::new()).unwrap();
        s.env.set_caller(s.creator);
        s.sale.withdraw_proceeds(id);
        assert_eq!(s.sale.sale(id).withdrawn, U512::from(10 * CSPR));
        assert_eq!(s.env.balance_of(&s.sale), U512::zero());
    }

    #[test]
    fn the_creator_takes_back_what_is_unsold_after_the_end() {
        let mut s = setup();
        let t = terms(&s);
        let id = create(&mut s, &t);
        buy(&s, s.env.get_account(2), id, 50 * CSPR, Bytes::new()).unwrap();

        s.env.set_caller(s.creator);
        assert_eq!(s.sale.try_withdraw_unsold(id), Err(Error::NotEnded.into()));
        s.env.advance_block_time(10 * DAY);

        s.env.set_caller(s.env.get_account(2));
        assert_eq!(
            s.sale.try_withdraw_unsold(id),
            Err(Error::NotCreator.into())
        );

        let before = s.token.balance_of(&s.creator);
        s.env.set_caller(s.creator);
        s.sale.withdraw_unsold(id);
        assert_eq!(s.token.balance_of(&s.creator), before + 75 * TEST);
        assert_eq!(s.token.balance_of(&s.sale.address()), U256::zero());
        assert_eq!(s.sale.sale(id).reclaimed, U256::from(75 * TEST));
        assert!(s.env.emitted_event(
            &s.sale,
            UnsoldWithdrawn {
                sale_id: id,
                creator: s.creator,
                amount: U256::from(75 * TEST)
            }
        ));
        assert_eq!(
            s.sale.try_withdraw_unsold(id),
            Err(Error::NothingUnsold.into())
        );
        // The CSPR can still be taken out.
        s.sale.withdraw_proceeds(id);
    }

    #[test]
    fn sales_keep_their_tokens_and_cspr_apart() {
        let mut s = setup();
        let t = terms(&s);
        let first = create(&mut s, &t);
        let small = Terms {
            cap: U256::from(10 * TEST),
            per_wallet: U256::from(10 * TEST),
            ..terms(&s)
        };
        let second = create(&mut s, &small);
        buy(&s, s.env.get_account(2), first, 20 * CSPR, Bytes::new()).unwrap();
        buy(&s, s.env.get_account(2), second, 20 * CSPR, Bytes::new()).unwrap();

        // The second sale is sold out; the first one's tokens are not for it.
        assert_eq!(
            buy(&s, s.env.get_account(3), second, 2 * CSPR, Bytes::new()),
            Err(Error::ExceedsCap.into())
        );
        s.env.set_caller(s.creator);
        s.sale.withdraw_proceeds(second);
        assert_eq!(s.env.balance_of(&s.sale), U512::from(20 * CSPR));
        s.env.advance_block_time(10 * DAY);
        assert_eq!(
            s.sale.try_withdraw_unsold(second),
            Err(Error::NothingUnsold.into())
        );
        s.sale.withdraw_unsold(first);
        assert_eq!(s.token.balance_of(&s.sale.address()), U256::zero());
    }

    #[test]
    fn invalid_sales_are_rejected() {
        let mut s = setup();
        s.env.advance_block_time(3 * DAY);
        let now = s.env.block_time();
        let mut check = |t: Terms, error: OdraError| {
            assert_eq!(try_create(&mut s, &t).map(|_| ()), Err(error));
        };
        let base = |at: u64| Terms {
            price: U512::from(CSPR),
            cap: U256::from(10 * TEST),
            per_wallet: U256::from(TEST),
            start: at,
            end: at + DAY,
            root: Bytes::new(),
        };
        check(
            Terms {
                price: U512::zero(),
                ..base(now)
            },
            Error::ZeroPrice.into(),
        );
        check(
            Terms {
                cap: U256::zero(),
                ..base(now)
            },
            Error::ZeroCap.into(),
        );
        check(
            Terms {
                per_wallet: U256::zero(),
                ..base(now)
            },
            Error::InvalidWalletLimit.into(),
        );
        check(
            Terms {
                per_wallet: U256::from(10 * TEST + 1),
                ..base(now)
            },
            Error::InvalidWalletLimit.into(),
        );
        check(
            Terms {
                end: now + DAY,
                start: now + DAY,
                ..base(now)
            },
            Error::InvalidWindow.into(),
        );
        check(
            Terms {
                start: now - 2 * DAY,
                end: now,
                ..base(now)
            },
            Error::EndInPast.into(),
        );
        check(
            Terms {
                root: Bytes::from(vec![1; 31]),
                ..base(now)
            },
            Error::InvalidRoot.into(),
        );
        // More than the creator approved.
        check(
            Terms {
                cap: U256::from(1001 * TEST),
                per_wallet: U256::from(TEST),
                ..base(now)
            },
            Cep18Error::InsufficientAllowance.into(),
        );
        // A start in the past is fine: the sale opens at once.
        create(
            &mut s,
            &Terms {
                start: now - DAY,
                ..base(now)
            },
        );
    }

    #[test]
    fn unknown_sales_are_reported() {
        let mut s = setup();
        let missing: OdraResult<()> = Err(Error::SaleNotFound.into());
        assert_eq!(s.sale.try_sale(7).map(|_| ()), missing);
        assert_eq!(
            buy(&s, s.env.get_account(2), 7, CSPR, Bytes::new()),
            missing
        );
        s.env.set_caller(s.creator);
        assert_eq!(s.sale.try_withdraw_proceeds(7), missing);
        assert_eq!(s.sale.try_withdraw_unsold(7), missing);
    }

    /// Prints the gas report on CasperVM (`cargo odra test -b casper`); does nothing on OdraVM.
    fn print_gas_report(env: &HostEnv, what: &str) {
        if on_casper() {
            println!("Gas report of {what}:\n{}", env.gas_report());
        }
    }

    /// The gas of a purchase with a proof of 10 nodes (an allowlist of 1,000), and of taking back
    /// what is unsold.
    #[test]
    fn gas_of_a_deep_proof_and_of_taking_back_the_rest() {
        let mut s = setup();
        let buyer = s.env.get_account(2);
        let mut list: Vec<Address> = (0..1000u64)
            .map(|i| {
                Address::from(odra::casper_types::account::AccountHash::new(
                    [(i % 251) as u8; 32],
                ))
            })
            .collect();
        list[517] = buyer;
        let tree = Tree::new(&list);
        assert_eq!(tree.proof(517).len(), 10);
        let t = Terms {
            root: tree.root_bytes(),
            ..terms(&s)
        };
        let id = create(&mut s, &t);
        buy(&s, buyer, id, 4 * CSPR, tree.proof_bytes(517)).unwrap();
        assert_eq!(s.token.balance_of(&buyer), U256::from(2 * TEST));
        s.env.advance_block_time(10 * DAY);
        s.env.set_caller(s.creator);
        s.sale.withdraw_unsold(id);
        print_gas_report(&s.env, "a purchase at depth 10 and a withdraw_unsold");
    }

    /// The demo of the command line tool, call for call with its gas limits, from the deploy on.
    #[test]
    fn the_demo_runs_to_the_end() {
        let env = odra_test::env();
        let mut token = TestToken::deploy(&env, NoArgs);
        env.set_gas(crate::demo::DEPLOY_GAS);
        let mut sale = TokenSale::deploy(&env, NoArgs);
        let caller = env.caller();
        let now = env.block_time();

        let demo = crate::demo::run(&env, &mut token, &mut sale, now).unwrap();

        assert_eq!(demo.id, 0);
        let stored = sale.sale(0);
        assert_eq!(stored.sold, crate::demo::BOUGHT.into());
        assert_eq!(stored.raised, crate::demo::PAID.into());
        assert_eq!(stored.withdrawn, crate::demo::PAID.into());
        assert_eq!(stored.end, now + crate::demo::OPEN_FOR);
        assert_eq!(sale.bought_by(0, caller), crate::demo::BOUGHT.into());
        assert_eq!(sale.sales_of_creator(caller), vec![0]);
        assert_eq!(env.balance_of(&sale), U512::zero());
        assert_eq!(
            token.balance_of(&caller),
            TestToken::faucet_amount() - U256::from(crate::demo::CAP) + crate::demo::BOUGHT
        );
        assert_eq!(demo.list_text.lines().count(), 3);
        assert!(demo
            .list_text
            .lines()
            .all(|line| line.starts_with("account-hash-")));
        print_gas_report(&env, "the demo");
    }
}
