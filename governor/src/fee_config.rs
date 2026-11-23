// A copy of ../timelock/src/fee_config.rs: the FeeConfig deployed on the testnet, the setting the proposals change.
//! A contract for the timelock to govern: one setting, a fee, that only its owner may change.

use odra::prelude::*;

/// The highest fee: 10,000 basis points, 100%.
pub const MAX_FEE_BPS: u32 = 10_000;

/// Errors of the fee setting.
#[odra::odra_error]
pub enum Error {
    /// Only the owner may do this.
    NotOwner = 100,
    /// The fee is higher than `MAX_FEE_BPS`.
    FeeTooHigh = 101,
}

/// The fee changed.
#[odra::event]
pub struct FeeChanged {
    pub old_fee_bps: u32,
    pub new_fee_bps: u32,
}

/// The contract has a new owner.
#[odra::event]
pub struct OwnershipTransferred {
    pub previous_owner: Address,
    pub new_owner: Address,
}

/// The fee of an imaginary service, in basis points (1/100 of a percent). Deployed with the
/// timelock as its owner, so every change of the fee waits out the timelock's delay.
#[odra::module(events = [FeeChanged, OwnershipTransferred], errors = Error)]
pub struct FeeConfig {
    /// The account or contract that may change the fee.
    owner: Var<Address>,
    /// The fee, in basis points.
    fee_bps: Var<u32>,
}

#[odra::module]
impl FeeConfig {
    /// Sets the owner and the first fee.
    pub fn init(&mut self, owner: Address, fee_bps: u32) {
        self.check_fee(fee_bps);
        self.owner.set(owner);
        self.fee_bps.set(fee_bps);
        self.env().emit_event(FeeChanged {
            old_fee_bps: 0,
            new_fee_bps: fee_bps,
        });
    }

    /// Changes the fee. Only the owner may call it.
    pub fn set_fee(&mut self, fee_bps: u32) {
        self.only_owner();
        self.check_fee(fee_bps);
        let old_fee_bps = self.fee_bps.get_or_default();
        self.fee_bps.set(fee_bps);
        self.env().emit_event(FeeChanged {
            old_fee_bps,
            new_fee_bps: fee_bps,
        });
    }

    /// Hands the contract to a new owner. Only the owner may call it.
    pub fn transfer_ownership(&mut self, new_owner: Address) {
        let previous_owner = self.only_owner();
        self.owner.set(new_owner);
        self.env().emit_event(OwnershipTransferred {
            previous_owner,
            new_owner,
        });
    }

    /// Returns the fee, in basis points.
    pub fn fee_bps(&self) -> u32 {
        self.fee_bps.get_or_default()
    }

    /// Returns the owner.
    pub fn owner(&self) -> Address {
        self.owner.get_or_revert_with(Error::NotOwner)
    }
}

impl FeeConfig {
    /// Reverts unless the caller is the owner; returns the owner.
    fn only_owner(&self) -> Address {
        let owner = self.owner();
        if self.env().caller() != owner {
            self.env().revert(Error::NotOwner);
        }
        owner
    }

    fn check_fee(&self, fee_bps: u32) {
        if fee_bps > MAX_FEE_BPS {
            self.env().revert(Error::FeeTooHigh);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use odra::host::Deployer;

    #[test]
    fn only_the_owner_changes_the_fee() {
        let env = odra_test::env();
        let owner = env.get_account(1);
        let mut config = FeeConfig::deploy(
            &env,
            FeeConfigInitArgs {
                owner,
                fee_bps: 100,
            },
        );
        assert_eq!(config.fee_bps(), 100);
        assert_eq!(config.owner(), owner);

        assert_eq!(config.try_set_fee(200), Err(Error::NotOwner.into()));
        env.set_caller(owner);
        config.set_fee(200);
        assert_eq!(config.fee_bps(), 200);
        assert!(env.emitted_event(
            &config,
            FeeChanged {
                old_fee_bps: 100,
                new_fee_bps: 200
            }
        ));
        assert_eq!(
            config.try_set_fee(MAX_FEE_BPS + 1),
            Err(Error::FeeTooHigh.into())
        );

        let next = env.get_account(2);
        config.transfer_ownership(next);
        assert_eq!(config.owner(), next);
        assert_eq!(config.try_set_fee(300), Err(Error::NotOwner.into()));
    }
}
