//! Two CEP-18 tokens anyone can mint, for trying the swap contract on a test network.
//!
//! `TestToken` is the token of `vesting/`, deployed once and shared by the demos. `TestDollar` is
//! the second token a swap needs. Both keep the state of Odra's `Cep18` module in a field called
//! `token`, so the web app reads either with one schema.

use odra::casper_types::U256;
use odra::prelude::*;
use odra_modules::cep18_token::Cep18;

/// Number of decimals of the test token.
pub const DECIMALS: u8 = 9;
/// Whole tokens a single `faucet` call mints.
pub const FAUCET_TOKENS: u64 = 1_000;

/// Number of decimals of the test dollar: six, as the dollar tokens of other chains have.
pub const DOLLAR_DECIMALS: u8 = 6;
/// Whole test dollars a single `faucet` call mints.
pub const DOLLAR_FAUCET_TOKENS: u64 = 1_000;

/// A CEP-18 token with a public faucet. It has no value: never use it outside of tests.
#[odra::module]
pub struct TestToken {
    token: SubModule<Cep18>,
}

#[odra::module]
impl TestToken {
    /// Sets the token metadata. Nothing is minted up front.
    pub fn init(&mut self) {
        self.token.init(
            String::from("TEST"),
            String::from("Vesting Test Token"),
            DECIMALS,
            U256::zero(),
        );
    }

    /// Mints `FAUCET_TOKENS` whole tokens to the caller.
    pub fn faucet(&mut self) {
        let caller = self.env().caller();
        self.token.raw_mint(&caller, &Self::faucet_amount());
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

impl TestToken {
    /// The amount a single `faucet` call mints, in the smallest unit.
    pub fn faucet_amount() -> U256 {
        U256::from(FAUCET_TOKENS) * U256::from(10u64.pow(DECIMALS as u32))
    }
}

/// A second CEP-18 token with a public faucet, with six decimals: the other side of a test swap.
/// It has no value: never use it outside of tests.
#[odra::module]
pub struct TestDollar {
    token: SubModule<Cep18>,
}

#[odra::module]
impl TestDollar {
    /// Sets the token metadata. Nothing is minted up front.
    pub fn init(&mut self) {
        self.token.init(
            String::from("TUSD"),
            String::from("Odra Test Dollar"),
            DOLLAR_DECIMALS,
            U256::zero(),
        );
    }

    /// Mints `DOLLAR_FAUCET_TOKENS` whole test dollars to the caller.
    pub fn faucet(&mut self) {
        let caller = self.env().caller();
        self.token.raw_mint(&caller, &Self::faucet_amount());
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

impl TestDollar {
    /// The amount a single `faucet` call mints, in the smallest unit.
    pub fn faucet_amount() -> U256 {
        U256::from(DOLLAR_FAUCET_TOKENS) * U256::from(10u64.pow(DOLLAR_DECIMALS as u32))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use odra::host::{Deployer, NoArgs};

    #[test]
    fn faucet_mints_to_the_caller() {
        let env = odra_test::env();
        let mut token = TestToken::deploy(&env, NoArgs);
        let alice = env.get_account(1);

        env.set_caller(alice);
        token.faucet();
        token.faucet();

        assert_eq!(token.balance_of(&alice), TestToken::faucet_amount() * 2);
        assert_eq!(token.total_supply(), TestToken::faucet_amount() * 2);
        assert_eq!(token.decimals(), DECIMALS);
    }

    #[test]
    fn the_dollar_faucet_mints_six_decimal_dollars() {
        let env = odra_test::env();
        let mut dollar = TestDollar::deploy(&env, NoArgs);
        let alice = env.get_account(1);

        env.set_caller(alice);
        dollar.faucet();

        assert_eq!(dollar.balance_of(&alice), U256::from(1_000_000_000u64));
        assert_eq!(dollar.symbol(), "TUSD");
        assert_eq!(dollar.decimals(), DOLLAR_DECIMALS);
    }
}
