//! Multisend: CSPR or a CEP-18 token sent to many recipients in one transaction.

use odra::casper_types::{U256, U512};
use odra::prelude::*;
use odra::ContractRef;
use odra_modules::cep18_token::Cep18ContractRef;

/// Errors of the multisend contract.
#[odra::odra_error]
pub enum Error {
    /// The list of recipients is empty.
    NoRecipients = 1,
    /// There is not exactly one amount for every recipient.
    LengthMismatch = 2,
    /// One of the amounts is zero.
    ZeroAmount = 3,
    /// The CSPR attached to the call is not the sum of the amounts.
    WrongAttachedValue = 4,
    /// The sum of the amounts does not fit in the type of the amounts.
    AmountOverflow = 5,
}

/// CSPR was sent to a list of recipients.
#[odra::event]
pub struct CsprSent {
    pub sender: Address,
    pub recipients: u32,
    pub total: U512,
}

/// A CEP-18 token was sent to a list of recipients.
#[odra::event]
pub struct TokenSent {
    pub sender: Address,
    pub token: Address,
    pub recipients: u32,
    pub total: U256,
}

/// Sends CSPR or a CEP-18 token from the caller to many recipients in one transaction.
///
/// The contract keeps no state and holds no funds between calls: a call either pays everyone or
/// reverts as a whole. It has no owner and no fees.
#[odra::module(events = [CsprSent, TokenSent], errors = Error)]
pub struct Multisend;

#[odra::module]
impl Multisend {
    /// Sends `amounts[i]` motes of CSPR to `recipients[i]`. The CSPR attached to the call must
    /// be exactly the sum of the amounts.
    #[odra(payable)]
    pub fn send_cspr(&mut self, recipients: Vec<Address>, amounts: Vec<U512>) {
        self.check_lists(recipients.len(), amounts.len());
        let mut total = U512::zero();
        for amount in &amounts {
            if amount.is_zero() {
                self.env().revert(Error::ZeroAmount);
            }
            total = total
                .checked_add(*amount)
                .unwrap_or_revert_with(self, Error::AmountOverflow);
        }
        if self.env().attached_value() != total {
            self.env().revert(Error::WrongAttachedValue);
        }

        for (recipient, amount) in recipients.iter().zip(&amounts) {
            self.env().transfer_tokens(recipient, amount);
        }

        self.env().emit_event(CsprSent {
            sender: self.env().caller(),
            recipients: recipients.len() as u32,
            total,
        });
    }

    /// Sends `amounts[i]` of the CEP-18 `token` from the caller to `recipients[i]`. The caller
    /// must have approved this contract for at least the sum of the amounts. The tokens go
    /// straight from the caller to each recipient; the contract never holds them.
    pub fn send_token(&mut self, token: Address, recipients: Vec<Address>, amounts: Vec<U256>) {
        self.check_lists(recipients.len(), amounts.len());
        let mut total = U256::zero();
        for amount in &amounts {
            if amount.is_zero() {
                self.env().revert(Error::ZeroAmount);
            }
            total = total
                .checked_add(*amount)
                .unwrap_or_revert_with(self, Error::AmountOverflow);
        }

        let sender = self.env().caller();
        let mut cep18 = Cep18ContractRef::new(self.env(), token);
        for (recipient, amount) in recipients.iter().zip(&amounts) {
            cep18.transfer_from(&sender, recipient, amount);
        }

        self.env().emit_event(TokenSent {
            sender,
            token,
            recipients: recipients.len() as u32,
            total,
        });
    }
}

impl Multisend {
    fn check_lists(&self, recipients: usize, amounts: usize) {
        if recipients == 0 {
            self.env().revert(Error::NoRecipients);
        }
        if recipients != amounts {
            self.env().revert(Error::LengthMismatch);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::token::{TestToken, TestTokenHostRef};
    use odra::host::{Deployer, HostEnv, HostRef, NoArgs};
    use odra_modules::cep18::errors::Error as Cep18Error;

    struct Setup {
        env: HostEnv,
        token: TestTokenHostRef,
        multisend: MultisendHostRef,
        sender: Address,
    }

    /// Deploys both contracts and gives the sender test tokens.
    fn setup() -> Setup {
        let env = odra_test::env();
        let sender = env.get_account(1);
        let mut token = TestToken::deploy(&env, NoArgs);
        let multisend = Multisend::deploy(&env, NoArgs);

        env.set_caller(sender);
        token.faucet();

        Setup {
            env,
            token,
            multisend,
            sender,
        }
    }

    fn recipients(env: &HostEnv) -> Vec<Address> {
        vec![env.get_account(2), env.get_account(3), env.get_account(4)]
    }

    #[test]
    fn send_cspr_pays_every_recipient() {
        let s = setup();
        let recipients = recipients(&s.env);
        let amounts = vec![U512::from(100), U512::from(250), U512::from(7)];
        let before: Vec<U512> = recipients.iter().map(|r| s.env.balance_of(r)).collect();

        s.multisend
            .with_tokens(U512::from(357))
            .send_cspr(recipients.clone(), amounts.clone());

        for ((recipient, amount), before) in recipients.iter().zip(&amounts).zip(&before) {
            assert_eq!(s.env.balance_of(recipient), *before + *amount);
        }
        // Nothing stays in the contract.
        assert_eq!(s.env.balance_of(&s.multisend), U512::zero());
        assert!(s.env.emitted_event(
            &s.multisend,
            CsprSent {
                sender: s.sender,
                recipients: 3,
                total: U512::from(357)
            }
        ));
    }

    #[test]
    fn send_cspr_may_pay_one_recipient_twice() {
        let s = setup();
        let recipient = s.env.get_account(2);
        let before = s.env.balance_of(&recipient);

        s.multisend.with_tokens(U512::from(30)).send_cspr(
            vec![recipient, recipient],
            vec![U512::from(10), U512::from(20)],
        );

        assert_eq!(s.env.balance_of(&recipient), before + 30);
    }

    #[test]
    fn send_cspr_needs_exactly_the_sum_attached() {
        let s = setup();
        let recipients = recipients(&s.env);
        let amounts = vec![U512::from(100), U512::from(250), U512::from(7)];
        let before = s.env.balance_of(&recipients[0]);

        for attached in [0u64, 356, 358] {
            assert_eq!(
                s.multisend
                    .with_tokens(U512::from(attached))
                    .try_send_cspr(recipients.clone(), amounts.clone()),
                Err(Error::WrongAttachedValue.into())
            );
        }
        // A reverted call pays nobody.
        assert_eq!(s.env.balance_of(&recipients[0]), before);
    }

    #[test]
    fn send_cspr_rejects_bad_lists() {
        let mut s = setup();
        let recipients = recipients(&s.env);

        assert_eq!(
            s.multisend.try_send_cspr(vec![], vec![]),
            Err(Error::NoRecipients.into())
        );
        assert_eq!(
            s.multisend
                .with_tokens(U512::from(3))
                .try_send_cspr(recipients.clone(), vec![U512::from(1), U512::from(2)]),
            Err(Error::LengthMismatch.into())
        );
        assert_eq!(
            s.multisend.with_tokens(U512::from(3)).try_send_cspr(
                recipients.clone(),
                vec![U512::from(1), U512::zero(), U512::from(2)]
            ),
            Err(Error::ZeroAmount.into())
        );
        assert_eq!(
            s.multisend
                .try_send_cspr(recipients, vec![U512::MAX, U512::from(1), U512::from(1)]),
            Err(Error::AmountOverflow.into())
        );
    }

    #[test]
    fn send_token_pays_every_recipient_from_the_sender() {
        let mut s = setup();
        let recipients = recipients(&s.env);
        let amounts = vec![U256::from(100), U256::from(250), U256::from(7)];
        s.token.approve(&s.multisend.address(), &U256::from(357));

        s.multisend
            .send_token(s.token.address(), recipients.clone(), amounts.clone());

        for (recipient, amount) in recipients.iter().zip(&amounts) {
            assert_eq!(s.token.balance_of(recipient), *amount);
        }
        assert_eq!(
            s.token.balance_of(&s.sender),
            TestToken::faucet_amount() - 357
        );
        // The contract never holds the tokens and uses up the allowance.
        assert_eq!(s.token.balance_of(&s.multisend.address()), U256::zero());
        assert_eq!(
            s.token.allowance(&s.sender, &s.multisend.address()),
            U256::zero()
        );
        assert!(s.env.emitted_event(
            &s.multisend,
            TokenSent {
                sender: s.sender,
                token: s.token.address(),
                recipients: 3,
                total: U256::from(357)
            }
        ));
    }

    #[test]
    fn send_token_reverts_as_a_whole_when_the_allowance_runs_out() {
        let mut s = setup();
        let recipients = recipients(&s.env);
        // Enough for the first two recipients only.
        s.token.approve(&s.multisend.address(), &U256::from(350));

        assert_eq!(
            s.multisend.try_send_token(
                s.token.address(),
                recipients.clone(),
                vec![U256::from(100), U256::from(250), U256::from(7)]
            ),
            Err(Cep18Error::InsufficientAllowance.into())
        );

        for recipient in &recipients {
            assert_eq!(s.token.balance_of(recipient), U256::zero());
        }
        assert_eq!(s.token.balance_of(&s.sender), TestToken::faucet_amount());
    }

    #[test]
    fn send_token_reverts_when_the_balance_is_too_low() {
        let mut s = setup();
        let amount = TestToken::faucet_amount();
        s.token.approve(&s.multisend.address(), &(amount * 2));

        assert_eq!(
            s.multisend.try_send_token(
                s.token.address(),
                vec![s.env.get_account(2), s.env.get_account(3)],
                vec![amount, U256::from(1)]
            ),
            Err(Cep18Error::InsufficientBalance.into())
        );
        assert_eq!(s.token.balance_of(&s.env.get_account(2)), U256::zero());
    }

    #[test]
    fn send_token_rejects_bad_lists() {
        let mut s = setup();
        let recipients = recipients(&s.env);
        let token = s.token.address();
        s.token.approve(&s.multisend.address(), &U256::from(1000));

        assert_eq!(
            s.multisend.try_send_token(token, vec![], vec![]),
            Err(Error::NoRecipients.into())
        );
        assert_eq!(
            s.multisend
                .try_send_token(token, recipients.clone(), vec![U256::from(1)]),
            Err(Error::LengthMismatch.into())
        );
        assert_eq!(
            s.multisend.try_send_token(
                token,
                recipients.clone(),
                vec![U256::from(1), U256::from(2), U256::zero()]
            ),
            Err(Error::ZeroAmount.into())
        );
        assert_eq!(
            s.multisend.try_send_token(
                token,
                recipients,
                vec![U256::MAX, U256::from(1), U256::from(1)]
            ),
            Err(Error::AmountOverflow.into())
        );
    }
}
