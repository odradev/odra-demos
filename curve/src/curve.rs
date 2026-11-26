//! A CEP-18 token that sells itself on a linear bonding curve.

use crate::math::Line;
use odra::casper_types::{U256, U512};
use odra::prelude::*;
use odra_modules::cep18_token::Cep18;

/// The most decimals the token may have: `unit^2` must leave room in the arithmetic.
pub const MAX_DECIMALS: u8 = 18;

/// Errors of the curve. The token's own errors (`InsufficientBalance` is 60001) are those of
/// Odra's CEP-18 module.
#[odra::odra_error]
pub enum Error {
    /// The base price and the slope are both zero: the token would be free.
    FreeCurve = 1,
    /// The token has more than `MAX_DECIMALS` decimals.
    TooManyDecimals = 2,
    /// No CSPR is attached to a purchase, or a sale of zero tokens.
    ZeroAmount = 3,
    /// The attached CSPR does not buy a single unit of the token.
    NothingBought = 4,
    /// The attached CSPR buys fewer tokens than `min_tokens`: the price moved.
    TooFewTokens = 5,
    /// The sale pays less than `min_cspr`: the price moved.
    TooLittleCspr = 6,
    /// A value does not fit in the arithmetic of the curve.
    Overflow = 7,
}

/// Tokens were bought.
#[odra::event]
pub struct Bought {
    pub buyer: Address,
    /// Tokens minted to the buyer, in the smallest unit.
    pub tokens: U256,
    /// What they cost, in motes. Attached CSPR above it went back to the buyer.
    pub cost: U512,
    /// The supply after the purchase.
    pub supply: U256,
    /// The reserve after the purchase, in motes.
    pub reserve: U512,
}

/// Tokens were sold back to the curve.
#[odra::event]
pub struct Sold {
    pub seller: Address,
    /// Tokens burned, in the smallest unit.
    pub tokens: U256,
    /// What the seller was paid, in motes.
    pub proceeds: U512,
    /// The supply after the sale.
    pub supply: U256,
    /// The reserve after the sale, in motes.
    pub reserve: U512,
}

/// A CEP-18 token whose only issuer is a price line.
///
/// Anyone may buy: the CSPR paid goes to the contract's reserve and the token is minted to the
/// buyer at a price that rises with the supply. Anyone holding the token may sell it back: it is
/// burned and paid for out of the reserve, at the price the supply has after the sale. There is no
/// owner, no fee and no way to take the reserve other than selling tokens.
#[odra::module(events = [Bought, Sold], errors = Error)]
pub struct Curve {
    token: SubModule<Cep18>,
    base_price: Var<U512>,
    slope: Var<U512>,
    reserve: Var<U512>,
}

#[odra::module]
impl Curve {
    /// Creates the token with no supply. `base_price` is the price of a whole token in motes when
    /// none exists; `slope` is how many motes the price of a whole token rises with each whole
    /// token of supply.
    pub fn init(
        &mut self,
        name: String,
        symbol: String,
        decimals: u8,
        base_price: U512,
        slope: U512,
    ) {
        if base_price.is_zero() && slope.is_zero() {
            self.env().revert(Error::FreeCurve);
        }
        if decimals > MAX_DECIMALS {
            self.env().revert(Error::TooManyDecimals);
        }
        self.token.init(symbol, name, decimals, U256::zero());
        self.base_price.set(base_price);
        self.slope.set(slope);
        self.reserve.set(U512::zero());
    }

    /// Mints to the caller as many tokens as the attached CSPR buys, and sends back what is left
    /// of it. Reverts if that is fewer than `min_tokens`.
    #[odra(payable)]
    pub fn buy(&mut self, min_tokens: U256) {
        let paid = self.env().attached_value();
        if paid.is_zero() {
            self.env().revert(Error::ZeroAmount);
        }
        let supply = self.supply();
        let line = self.line();
        let tokens = line
            .tokens_for(supply, paid)
            .unwrap_or_revert_with(self, Error::Overflow);
        if tokens.is_zero() {
            self.env().revert(Error::NothingBought);
        }
        let cost = line
            .cost(supply, tokens)
            .unwrap_or_revert_with(self, Error::Overflow);
        if tokens < min_tokens {
            self.env().revert(Error::TooFewTokens);
        }

        let buyer = self.env().caller();
        let reserve = self.reserve.get_or_default() + cost;
        self.reserve.set(reserve);
        self.token.raw_mint(&buyer, &tokens);
        let change = paid - cost;
        if !change.is_zero() {
            self.env().transfer_tokens(&buyer, &change);
        }

        self.env().emit_event(Bought {
            buyer,
            tokens,
            cost,
            supply: self.token.total_supply(),
            reserve,
        });
    }

    /// Burns `amount` of the caller's tokens and pays the caller for them out of the reserve.
    /// Reverts if that pays less than `min_cspr`.
    pub fn sell(&mut self, amount: U256, min_cspr: U512) {
        if amount.is_zero() {
            self.env().revert(Error::ZeroAmount);
        }
        let seller = self.env().caller();
        // Reverts with the token's `InsufficientBalance` if the caller holds less.
        self.token.raw_burn(&seller, &amount);
        let proceeds = self
            .line()
            .proceeds(self.supply() + amount, amount)
            .unwrap_or_revert_with(self, Error::Overflow);
        if proceeds < min_cspr {
            self.env().revert(Error::TooLittleCspr);
        }
        // The reserve holds at least the area under the line up to the supply (see `math`), so
        // this subtraction cannot fail; it is checked all the same.
        let reserve = self
            .reserve
            .get_or_default()
            .checked_sub(proceeds)
            .unwrap_or_revert_with(self, Error::Overflow);
        self.reserve.set(reserve);
        if !proceeds.is_zero() {
            self.env().transfer_tokens(&seller, &proceeds);
        }

        self.env().emit_event(Sold {
            seller,
            tokens: amount,
            proceeds,
            supply: self.token.total_supply(),
            reserve,
        });
    }

    /// The price of a whole token now, in motes, rounded down.
    pub fn price(&self) -> U512 {
        self.line()
            .price(self.supply())
            .unwrap_or_revert_with(self, Error::Overflow)
    }

    /// How many tokens `cspr` motes would buy now.
    pub fn tokens_for(&self, cspr: U512) -> U256 {
        self.line()
            .tokens_for(self.supply(), cspr)
            .unwrap_or_revert_with(self, Error::Overflow)
    }

    /// What buying `amount` tokens would cost now, in motes.
    pub fn cost_of(&self, amount: U256) -> U512 {
        self.line()
            .cost(self.supply(), amount)
            .unwrap_or_revert_with(self, Error::Overflow)
    }

    /// What selling `amount` tokens would pay now, in motes. Reverts with `Overflow` for more than
    /// the supply.
    pub fn proceeds_of(&self, amount: U256) -> U512 {
        self.line()
            .proceeds(self.supply(), amount)
            .unwrap_or_revert_with(self, Error::Overflow)
    }

    /// The CSPR the contract holds to buy tokens back, in motes.
    pub fn reserve(&self) -> U512 {
        self.reserve.get_or_default()
    }

    /// The price of a whole token at zero supply, in motes.
    pub fn base_price(&self) -> U512 {
        self.base_price.get_or_default()
    }

    /// How many motes the price of a whole token rises with each whole token of supply.
    pub fn slope(&self) -> U512 {
        self.slope.get_or_default()
    }

    delegate! {
        to self.token {
            fn name(&self) -> String;
            fn symbol(&self) -> String;
            fn decimals(&self) -> u8;
            fn total_supply(&self) -> U256;
            fn balance_of(&self, address: &Address) -> U256;
            fn allowance(&self, owner: &Address, spender: &Address) -> U256;
            fn approve(&mut self, spender: &Address, amount: &U256);
            fn decrease_allowance(&mut self, spender: &Address, decr_by: &U256);
            fn increase_allowance(&mut self, spender: &Address, inc_by: &U256);
            fn transfer(&mut self, recipient: &Address, amount: &U256);
            fn transfer_from(&mut self, owner: &Address, recipient: &Address, amount: &U256);
        }
    }
}

impl Curve {
    fn line(&self) -> Line {
        Line::new(
            self.base_price.get_or_default(),
            self.slope.get_or_default(),
            self.token.decimals(),
        )
        .unwrap_or_revert_with(self, Error::Overflow)
    }

    fn supply(&self) -> U256 {
        self.token.total_supply()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use odra::host::{Deployer, HostEnv, HostRef};
    use odra_modules::cep18::errors::Error as Cep18Error;

    const CSPR: u64 = 1_000_000_000;

    fn motes(value: u64) -> U512 {
        U512::from(value)
    }

    fn tokens(whole: u64) -> U256 {
        U256::from(whole) * U256::from(CSPR)
    }

    fn args(base_price: u64, slope: u64, decimals: u8) -> CurveInitArgs {
        CurveInitArgs {
            name: String::from("Curve Token"),
            symbol: String::from("CURVE"),
            decimals,
            base_price: motes(base_price),
            slope: motes(slope),
        }
    }

    /// The curve of the demo: 0.1 CSPR a token, rising by 0.001 CSPR with each token.
    fn setup() -> (HostEnv, CurveHostRef) {
        let env = odra_test::env();
        let curve = Curve::deploy(&env, args(CSPR / 10, CSPR / 1000, 9));
        (env, curve)
    }

    #[test]
    fn starts_empty_at_the_base_price() {
        let (_, curve) = setup();
        assert_eq!(curve.total_supply(), U256::zero());
        assert_eq!(curve.reserve(), U512::zero());
        assert_eq!(curve.price(), motes(CSPR / 10));
        assert_eq!(curve.base_price(), motes(CSPR / 10));
        assert_eq!(curve.slope(), motes(CSPR / 1000));
        assert_eq!(curve.symbol(), "CURVE");
        assert_eq!(curve.name(), "Curve Token");
        assert_eq!(curve.decimals(), 9);
    }

    #[test]
    fn rejects_a_free_curve_and_too_many_decimals() {
        let env = odra_test::env();
        assert_eq!(
            Curve::try_deploy(&env, args(0, 0, 9)).err(),
            Some(Error::FreeCurve.into())
        );
        assert_eq!(
            Curve::try_deploy(&env, args(1, 1, MAX_DECIMALS + 1)).err(),
            Some(Error::TooManyDecimals.into())
        );
        assert!(Curve::try_deploy(&env, args(0, 1, MAX_DECIMALS)).is_ok());
    }

    #[test]
    fn buy_mints_what_the_cspr_buys_and_keeps_the_cost() {
        let (env, curve) = setup();
        let buyer = env.get_account(1);
        env.set_caller(buyer);

        // The first 100 tokens cost 100 * (0.1 + 0.2) / 2 = 15 CSPR.
        curve.with_tokens(motes(15 * CSPR)).buy(tokens(100));

        assert_eq!(curve.balance_of(&buyer), tokens(100));
        assert_eq!(curve.total_supply(), tokens(100));
        assert_eq!(curve.reserve(), motes(15 * CSPR));
        assert_eq!(env.balance_of(&curve), motes(15 * CSPR));
        assert_eq!(curve.price(), motes(CSPR / 5));
        assert!(env.emitted_event(
            &curve,
            Bought {
                buyer,
                tokens: tokens(100),
                cost: motes(15 * CSPR),
                supply: tokens(100),
                reserve: motes(15 * CSPR),
            }
        ));
    }

    #[test]
    fn buy_sends_back_what_the_cspr_does_not_buy() {
        // Whole tokens only, 2 CSPR each and flat: 5 CSPR buys two, 1 CSPR comes back.
        let env = odra_test::env();
        let curve = Curve::deploy(&env, args(2 * CSPR, 0, 0));
        let buyer = env.get_account(1);
        env.set_caller(buyer);

        curve.with_tokens(motes(5 * CSPR)).buy(U256::zero());

        assert_eq!(curve.balance_of(&buyer), U256::from(2));
        assert_eq!(curve.reserve(), motes(4 * CSPR));
        // The contract holds only the cost: the rest went back.
        assert_eq!(env.balance_of(&curve), motes(4 * CSPR));
    }

    #[test]
    fn the_price_rises_for_the_next_buyer() {
        let (env, curve) = setup();
        env.set_caller(env.get_account(1));
        curve.with_tokens(motes(15 * CSPR)).buy(U256::zero());
        env.set_caller(env.get_account(2));
        curve.with_tokens(motes(15 * CSPR)).buy(U256::zero());

        let first = curve.balance_of(&env.get_account(1));
        let second = curve.balance_of(&env.get_account(2));
        assert_eq!(first, tokens(100));
        assert!(second < first);
        assert_eq!(curve.reserve(), motes(30 * CSPR));
    }

    #[test]
    fn buy_reports_what_it_cannot_do() {
        let (env, mut curve) = setup();
        env.set_caller(env.get_account(1));
        assert_eq!(curve.try_buy(U256::zero()), Err(Error::ZeroAmount.into()));
        assert_eq!(
            curve.with_tokens(motes(15 * CSPR)).try_buy(tokens(100) + 1),
            Err(Error::TooFewTokens.into())
        );

        let whole = Curve::deploy(&env, args(2 * CSPR, 0, 0));
        assert_eq!(
            whole.with_tokens(motes(CSPR)).try_buy(U256::zero()),
            Err(Error::NothingBought.into())
        );
        // Nothing moved.
        assert_eq!(curve.total_supply(), U256::zero());
        assert_eq!(env.balance_of(&curve), U512::zero());
    }

    #[test]
    fn sell_burns_and_pays_from_the_reserve() {
        let (env, mut curve) = setup();
        let seller = env.get_account(1);
        env.set_caller(seller);
        curve.with_tokens(motes(40 * CSPR)).buy(U256::zero());
        assert_eq!(curve.total_supply(), tokens(200));

        // The top 100 of 200 tokens pay 100 * (0.2 + 0.3) / 2 = 25 CSPR.
        curve.sell(tokens(100), motes(25 * CSPR));

        assert_eq!(curve.balance_of(&seller), tokens(100));
        assert_eq!(curve.total_supply(), tokens(100));
        assert_eq!(curve.reserve(), motes(15 * CSPR));
        assert_eq!(env.balance_of(&curve), motes(15 * CSPR));
        assert!(env.emitted_event(
            &curve,
            Sold {
                seller,
                tokens: tokens(100),
                proceeds: motes(25 * CSPR),
                supply: tokens(100),
                reserve: motes(15 * CSPR),
            }
        ));
    }

    #[test]
    fn sell_reports_what_it_cannot_do() {
        let (env, mut curve) = setup();
        env.set_caller(env.get_account(1));
        curve.with_tokens(motes(15 * CSPR)).buy(U256::zero());

        assert_eq!(
            curve.try_sell(U256::zero(), U512::zero()),
            Err(Error::ZeroAmount.into())
        );
        assert_eq!(
            curve.try_sell(tokens(100), motes(15 * CSPR) + 1),
            Err(Error::TooLittleCspr.into())
        );
        assert_eq!(
            curve.try_sell(tokens(100) + 1, U512::zero()),
            Err(Cep18Error::InsufficientBalance.into())
        );
        env.set_caller(env.get_account(2));
        assert_eq!(
            curve.try_sell(U256::one(), U512::zero()),
            Err(Cep18Error::InsufficientBalance.into())
        );
        assert_eq!(curve.total_supply(), tokens(100));
        assert_eq!(curve.reserve(), motes(15 * CSPR));
    }

    #[test]
    fn buying_and_selling_back_never_returns_more_than_was_paid() {
        // Odd prices and amounts, so that every result is rounded.
        for (base, slope, decimals, paid) in [
            (3u64, 7u64, 0u8, 1_000u64),
            (0, 1, 3, 77_777),
            (1, 3, 9, 123_456_789),
            (CSPR / 10, CSPR / 1000, 9, 7 * CSPR + 3),
        ] {
            let env = odra_test::env();
            let mut curve = Curve::deploy(&env, args(base, slope, decimals));
            // Someone bought first, so the round trip starts mid-curve.
            env.set_caller(env.get_account(2));
            curve.with_tokens(motes(paid / 3 + 1)).buy(U256::zero());

            let trader = env.get_account(1);
            env.set_caller(trader);
            let held = env.balance_of(&curve);
            curve.with_tokens(motes(paid)).buy(U256::zero());
            let cost = env.balance_of(&curve) - held;
            curve.sell(curve.balance_of(&trader), U512::zero());
            let proceeds = cost + held - env.balance_of(&curve);

            // The trader got back no more than the round trip cost them, the contract kept what
            // it held before, and never by more than a mote of rounding.
            assert!(proceeds <= cost);
            assert!(env.balance_of(&curve) >= held);
            assert!(cost - proceeds <= motes(1));
            // The contract always holds what it says it does.
            assert_eq!(env.balance_of(&curve), curve.reserve());
        }
    }

    #[test]
    fn everyone_can_sell_out_in_any_order() {
        let (env, mut curve) = setup();
        let paid = [3 * CSPR + 1, 50 * CSPR, 7 * CSPR + 333, CSPR / 3];
        for (index, amount) in paid.iter().enumerate() {
            env.set_caller(env.get_account(index + 1));
            curve.with_tokens(motes(*amount)).buy(U256::zero());
        }
        // One holder passes tokens to another, who sells them.
        env.set_caller(env.get_account(2));
        curve.transfer(&env.get_account(5), &tokens(10));

        for index in [3usize, 1, 5, 2, 4] {
            let holder = env.get_account(index);
            env.set_caller(holder);
            let balance = curve.balance_of(&holder);
            let quote = curve.proceeds_of(balance);
            curve.sell(balance, quote);
        }

        assert_eq!(curve.total_supply(), U256::zero());
        assert_eq!(curve.price(), motes(CSPR / 10));
        // What is left is rounding, a few motes at most.
        assert!(curve.reserve() < motes(10));
        assert_eq!(env.balance_of(&curve), curve.reserve());
    }

    #[test]
    fn views_quote_what_the_calls_do() {
        let (env, mut curve) = setup();
        let buyer = env.get_account(1);
        env.set_caller(buyer);
        curve.with_tokens(motes(9 * CSPR)).buy(U256::zero());
        let reserve = curve.reserve();

        let quoted = curve.tokens_for(motes(12 * CSPR + 5));
        let cost = curve.cost_of(quoted);
        assert!(cost <= motes(12 * CSPR + 5));
        let before = curve.balance_of(&buyer);
        curve.with_tokens(motes(12 * CSPR + 5)).buy(quoted);
        assert_eq!(curve.balance_of(&buyer) - before, quoted);
        assert_eq!(curve.reserve(), reserve + cost);

        let proceeds = curve.proceeds_of(quoted);
        curve.sell(quoted, proceeds);
        assert!(proceeds <= cost);
        assert_eq!(
            curve.try_proceeds_of(curve.total_supply() + 1),
            Err(Error::Overflow.into())
        );
    }

    #[test]
    fn a_flat_curve_sells_at_one_price() {
        let env = odra_test::env();
        let curve = Curve::deploy(&env, args(CSPR, 0, 9));
        env.set_caller(env.get_account(1));
        curve.with_tokens(motes(10 * CSPR)).buy(tokens(10));
        assert_eq!(curve.price(), motes(CSPR));
        assert_eq!(curve.proceeds_of(tokens(10)), motes(10 * CSPR));
    }

    #[test]
    fn the_token_moves_like_any_cep18() {
        let (env, mut curve) = setup();
        let (alice, bob) = (env.get_account(1), env.get_account(2));
        env.set_caller(alice);
        curve.with_tokens(motes(15 * CSPR)).buy(U256::zero());
        curve.approve(&bob, &tokens(30));

        env.set_caller(bob);
        curve.transfer_from(&alice, &bob, &tokens(30));
        assert_eq!(curve.balance_of(&bob), tokens(30));
        assert_eq!(curve.allowance(&alice, &bob), U256::zero());
        curve.sell(tokens(30), U512::zero());
        assert_eq!(curve.total_supply(), tokens(70));
    }

    #[test]
    fn the_demo_runs_and_reports_its_gas() {
        let env = odra_test::env();
        env.set_gas(crate::demo::gas::DEPLOY);
        let mut curve = Curve::deploy(&env, crate::demo::init_args());

        let outcome = crate::demo::run(&mut curve, motes(crate::demo::CSPR_TO_SPEND)).unwrap();
        assert_eq!(outcome.reserve, curve.reserve());
        assert!(outcome.received <= outcome.paid);
        assert_eq!(
            curve.balance_of(&env.caller()),
            outcome.bought - outcome.sold
        );
        // A later purchase and sale of the same account.
        env.set_gas(crate::demo::gas::BUY);
        curve.with_tokens(motes(5 * CSPR)).buy(U256::zero());
        env.set_gas(crate::demo::gas::SELL);
        curve.sell(curve.balance_of(&env.caller()), U512::zero());

        // A unit of the demo token costs less than a mote, so a purchase never has change to send
        // back. On a curve of whole tokens at 2 CSPR, 4 CSPR buy two exactly and 5 CSPR buy two
        // and send 1 CSPR back: the gas of that transfer.
        let whole = Curve::deploy(&env, args(2 * CSPR, 0, 0));
        env.set_gas(crate::demo::gas::BUY);
        whole.with_tokens(motes(4 * CSPR)).buy(U256::zero());
        env.set_gas(crate::demo::gas::BUY);
        whole.with_tokens(motes(5 * CSPR)).buy(U256::zero());
        assert_eq!(whole.reserve(), motes(8 * CSPR));

        // `cargo test -- --nocapture` shows it; with ODRA_BACKEND=casper it is the gas used.
        println!("{}", env.gas_report());
    }
}
