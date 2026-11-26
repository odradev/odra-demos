//! A CEP-95 NFT collection anyone can mint into, for trying the auction contract on a test network.

use odra::casper_types::U256;
use odra::prelude::*;
use odra_modules::cep95::{CEP95Interface, Cep95};

/// The longest name a test NFT may have, in characters.
pub const MAX_NAME_LENGTH: usize = 40;

/// Errors of the test NFT. They start at 100, apart from the auction's: an auction calls the NFT
/// contract, and the errors of every contract called in one transaction share one number space.
#[odra::odra_error]
pub enum Error {
    /// The name is empty or longer than `MAX_NAME_LENGTH` characters.
    InvalidName = 100,
}

/// A CEP-95 collection with open minting. Its tokens have no value: never use it outside of tests.
///
/// Token ids run from `0` up, in the order of minting. Each token has one metadata entry, `name`.
#[odra::module(errors = Error)]
pub struct TestNft {
    token: SubModule<Cep95>,
    /// The number of tokens minted; also the id of the next one.
    count: Var<u64>,
    /// Ids of the tokens an account minted, whether it still owns them or not.
    minted_by: Mapping<Address, Vec<U256>>,
}

#[odra::module]
impl TestNft {
    /// Sets the name and the symbol of the collection. Nothing is minted up front.
    pub fn init(&mut self) {
        self.token
            .init(String::from("Odra Auction Test NFT"), String::from("TNFT"));
    }

    /// Mints the next token to the caller, with `name` as its metadata. Its id is the value
    /// `minted_count` returned before the call; the `Mint` event carries it.
    pub fn mint(&mut self, name: String) {
        let length = name.chars().count();
        if name.trim().is_empty() || length > MAX_NAME_LENGTH {
            self.env().revert(Error::InvalidName);
        }
        let caller = self.env().caller();
        let id = self.count.get_or_default();
        self.count.set(id + 1);
        let token_id = U256::from(id);
        self.token
            .raw_mint(caller, token_id, vec![(String::from("name"), name)]);

        let mut ids = self.minted_by.get_or_default(&caller);
        ids.push(token_id);
        self.minted_by.set(&caller, ids);
    }

    /// Returns the number of tokens minted. Ids run from `0` to `count - 1`.
    pub fn minted_count(&self) -> u64 {
        self.count.get_or_default()
    }

    /// Returns the ids of the tokens `account` minted.
    pub fn minted_by(&self, account: Address) -> Vec<U256> {
        self.minted_by.get_or_default(&account)
    }

    delegate! {
        to self.token {
            fn name(&self) -> String;
            fn symbol(&self) -> String;
            fn balance_of(&self, owner: Address) -> U256;
            fn owner_of(&self, token_id: U256) -> Option<Address>;
            fn safe_transfer_from(
                &mut self,
                from: Address,
                to: Address,
                token_id: U256,
                data: Option<odra::casper_types::bytesrepr::Bytes>
            );
            fn transfer_from(&mut self, from: Address, to: Address, token_id: U256);
            fn approve(&mut self, spender: Address, token_id: U256);
            fn revoke_approval(&mut self, token_id: U256);
            fn approved_for(&self, token_id: U256) -> Option<Address>;
            fn approve_for_all(&mut self, operator: Address);
            fn revoke_approval_for_all(&mut self, operator: Address);
            fn is_approved_for_all(&self, owner: Address, operator: Address) -> bool;
            fn token_metadata(&self, token_id: U256) -> Vec<(String, String)>;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use odra::host::{Deployer, NoArgs};

    #[test]
    fn anyone_mints_the_next_token() {
        let env = odra_test::env();
        let mut nft = TestNft::deploy(&env, NoArgs);
        let alice = env.get_account(1);
        let bob = env.get_account(2);

        env.set_caller(alice);
        nft.mint(String::from("Sunrise"));
        env.set_caller(bob);
        nft.mint(String::from("Harbour"));
        env.set_caller(alice);
        nft.mint(String::from("Żurawie nad Odrą"));

        assert_eq!(nft.minted_count(), 3);
        assert_eq!(nft.owner_of(U256::from(1)), Some(bob));
        assert_eq!(nft.balance_of(alice), U256::from(2));
        assert_eq!(nft.minted_by(alice), vec![U256::from(0), U256::from(2)]);
        assert_eq!(
            nft.token_metadata(U256::from(2)),
            vec![(String::from("name"), String::from("Żurawie nad Odrą"))]
        );
        assert_eq!(nft.symbol(), "TNFT");
    }

    #[test]
    fn a_name_must_be_short_and_not_blank() {
        let env = odra_test::env();
        let mut nft = TestNft::deploy(&env, NoArgs);

        assert_eq!(
            nft.try_mint(String::from(" ")),
            Err(Error::InvalidName.into())
        );
        assert_eq!(
            nft.try_mint("x".repeat(MAX_NAME_LENGTH + 1)),
            Err(Error::InvalidName.into())
        );
        assert_eq!(nft.try_mint("ż".repeat(MAX_NAME_LENGTH)), Ok(()));
        assert_eq!(nft.minted_count(), 1);
    }
}
