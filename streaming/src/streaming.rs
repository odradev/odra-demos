//! Payment streaming: CEP-18 tokens paid to a recipient continuously, by the millisecond.

use odra::casper_types::U256;
use odra::prelude::*;
use odra::ContractRef;
use odra_modules::cep18_token::Cep18ContractRef;

/// A stream. All times are block times: milliseconds since the Unix epoch.
#[odra::odra_type]
pub struct Stream {
    /// The account that funded the stream and may cancel it.
    pub sender: Address,
    /// The account the tokens are paid to.
    pub recipient: Address,
    /// The CEP-18 token being paid.
    pub token: Address,
    /// The amount the sender deposited: what the stream pays out in total if nobody cancels it.
    pub deposit: U256,
    /// The amount already paid out to the recipient.
    pub withdrawn: U256,
    /// The moment the stream starts paying.
    pub start: u64,
    /// The moment the whole deposit has been paid.
    pub stop: u64,
    /// Whether the sender has cancelled the stream.
    pub cancelled: bool,
    /// The amount that went back to the sender when the stream was cancelled.
    pub refunded: U256,
}

/// Errors of the streaming contract.
#[odra::odra_error]
pub enum Error {
    /// The deposit or the amount to withdraw is zero.
    ZeroAmount = 1,
    /// The times do not satisfy `start < stop`.
    InvalidTimes = 2,
    /// The deposit is too large to compute an accrued share of.
    AmountTooLarge = 3,
    /// No stream has this id.
    StreamNotFound = 4,
    /// Only the recipient of the stream may do this.
    NotRecipient = 5,
    /// Only the sender of the stream may do this.
    NotSender = 6,
    /// The amount is more than has accrued and was not withdrawn yet.
    AmountExceedsBalance = 7,
    /// The stream has been cancelled already.
    AlreadyCancelled = 8,
}

/// A stream was created and funded.
#[odra::event]
pub struct StreamCreated {
    pub stream_id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub token: Address,
    pub deposit: U256,
    pub start: u64,
    pub stop: u64,
}

/// The recipient withdrew accrued tokens.
#[odra::event]
pub struct Withdrawn {
    pub stream_id: u64,
    pub recipient: Address,
    pub amount: U256,
}

/// The sender cancelled a stream: the recipient got what had accrued, the sender the rest.
#[odra::event]
pub struct StreamCancelled {
    pub stream_id: u64,
    pub sender: Address,
    pub recipient: Address,
    /// What the recipient received at the moment of cancelling.
    pub paid: U256,
    /// What went back to the sender.
    pub refunded: U256,
}

/// Holds CEP-18 deposits and pays them out to recipients as time passes.
///
/// Anyone can stream any CEP-18 token; the contract has no owner and no fees.
#[odra::module(events = [StreamCreated, Withdrawn, StreamCancelled], errors = Error)]
pub struct Streaming {
    /// Streams by id.
    streams: Mapping<u64, Stream>,
    /// The number of streams created; also the id of the next one.
    count: Var<u64>,
    /// Ids of the streams an account sends.
    by_sender: Mapping<Address, Vec<u64>>,
    /// Ids of the streams an account receives.
    by_recipient: Mapping<Address, Vec<u64>>,
}

#[odra::module]
impl Streaming {
    /// Creates a stream and pulls `deposit` of `token` from the caller, who must have approved
    /// this contract for at least that amount. The id of the stream is the value `streams_count`
    /// returned before the call; the `StreamCreated` event carries it.
    ///
    /// The deposit accrues to the recipient linearly from `start` to `stop`, both in
    /// milliseconds since the Unix epoch, with `start < stop`. A `start` in the past is allowed.
    pub fn create_stream(
        &mut self,
        recipient: Address,
        token: Address,
        deposit: U256,
        start: u64,
        stop: u64,
    ) {
        if deposit.is_zero() {
            self.env().revert(Error::ZeroAmount);
        }
        if start >= stop {
            self.env().revert(Error::InvalidTimes);
        }
        // The accrued share is `deposit * elapsed / duration`: the product must fit in a U256.
        if deposit.checked_mul(U256::from(stop - start)).is_none() {
            self.env().revert(Error::AmountTooLarge);
        }

        let sender = self.env().caller();
        let stream_id = self.count.get_or_default();
        self.count.set(stream_id + 1);
        self.streams.set(
            &stream_id,
            Stream {
                sender,
                recipient,
                token,
                deposit,
                withdrawn: U256::zero(),
                start,
                stop,
                cancelled: false,
                refunded: U256::zero(),
            },
        );
        push_id(&mut self.by_sender, &sender, stream_id);
        push_id(&mut self.by_recipient, &recipient, stream_id);

        Cep18ContractRef::new(self.env(), token).transfer_from(
            &sender,
            &self.env().self_address(),
            &deposit,
        );

        self.env().emit_event(StreamCreated {
            stream_id,
            sender,
            recipient,
            token,
            deposit,
            start,
            stop,
        });
    }

    /// Pays `amount` of what has accrued and was not withdrawn yet to the recipient. Only the
    /// recipient may call it.
    pub fn withdraw(&mut self, stream_id: u64, amount: U256) {
        let mut stream = self.get_stream(stream_id);
        if self.env().caller() != stream.recipient {
            self.env().revert(Error::NotRecipient);
        }
        if amount.is_zero() {
            self.env().revert(Error::ZeroAmount);
        }
        if amount > self.accrued_of(&stream) - stream.withdrawn {
            self.env().revert(Error::AmountExceedsBalance);
        }

        stream.withdrawn += amount;
        self.streams.set(&stream_id, stream.clone());

        Cep18ContractRef::new(self.env(), stream.token).transfer(&stream.recipient, &amount);

        self.env().emit_event(Withdrawn {
            stream_id,
            recipient: stream.recipient,
            amount,
        });
    }

    /// Stops the stream: what has accrued and was not withdrawn goes to the recipient, the rest
    /// back to the sender. Only the sender may call it.
    pub fn cancel(&mut self, stream_id: u64) {
        let mut stream = self.get_stream(stream_id);
        if self.env().caller() != stream.sender {
            self.env().revert(Error::NotSender);
        }
        if stream.cancelled {
            self.env().revert(Error::AlreadyCancelled);
        }

        let accrued = self.accrued_of(&stream);
        let paid = accrued - stream.withdrawn;
        let refunded = stream.deposit - accrued;
        stream.withdrawn = accrued;
        stream.refunded = refunded;
        stream.cancelled = true;
        self.streams.set(&stream_id, stream.clone());

        let mut token = Cep18ContractRef::new(self.env(), stream.token);
        if !paid.is_zero() {
            token.transfer(&stream.recipient, &paid);
        }
        if !refunded.is_zero() {
            token.transfer(&stream.sender, &refunded);
        }

        self.env().emit_event(StreamCancelled {
            stream_id,
            sender: stream.sender,
            recipient: stream.recipient,
            paid,
            refunded,
        });
    }

    /// Returns the stream with the given id.
    pub fn stream(&self, stream_id: u64) -> Stream {
        self.get_stream(stream_id)
    }

    /// Returns what `who` would get out of the stream now: for the recipient, what has accrued
    /// and was not withdrawn; for the sender, what has not accrued yet; for anyone else, zero.
    pub fn balance_of(&self, stream_id: u64, who: Address) -> U256 {
        let stream = self.get_stream(stream_id);
        let accrued = self.accrued_of(&stream);
        let mut balance = U256::zero();
        if who == stream.recipient {
            balance += accrued - stream.withdrawn;
        }
        if who == stream.sender && !stream.cancelled {
            balance += stream.deposit - accrued;
        }
        balance
    }

    /// Returns the number of streams created. Ids run from `0` to `count - 1`.
    pub fn streams_count(&self) -> u64 {
        self.count.get_or_default()
    }

    /// Returns the ids of the streams `sender` sends.
    pub fn streams_of_sender(&self, sender: Address) -> Vec<u64> {
        self.by_sender.get_or_default(&sender)
    }

    /// Returns the ids of the streams `recipient` receives.
    pub fn streams_of_recipient(&self, recipient: Address) -> Vec<u64> {
        self.by_recipient.get_or_default(&recipient)
    }
}

impl Streaming {
    fn get_stream(&self, stream_id: u64) -> Stream {
        self.streams
            .get(&stream_id)
            .unwrap_or_revert_with(self, Error::StreamNotFound)
    }

    /// The amount accrued to the recipient at the current block time, withdrawn or not.
    fn accrued_of(&self, stream: &Stream) -> U256 {
        // A cancelled stream stopped at the moment of cancelling, and everything accrued was paid.
        if stream.cancelled {
            return stream.withdrawn;
        }
        let now = self.env().get_block_time();
        if now <= stream.start {
            U256::zero()
        } else if now >= stream.stop {
            stream.deposit
        } else {
            stream.deposit * U256::from(now - stream.start) / U256::from(stream.stop - stream.start)
        }
    }
}

fn push_id(index: &mut Mapping<Address, Vec<u64>>, account: &Address, stream_id: u64) {
    let mut ids = index.get_or_default(account);
    ids.push(stream_id);
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
        streaming: StreamingHostRef,
        sender: Address,
        recipient: Address,
    }

    /// Deploys both contracts and gives the sender tokens and an allowance for all of them.
    fn setup() -> Setup {
        let env = odra_test::env();
        let sender = env.get_account(1);
        let recipient = env.get_account(2);
        let mut token = TestToken::deploy(&env, NoArgs);
        let streaming = Streaming::deploy(&env, NoArgs);

        env.set_caller(sender);
        token.faucet();
        token.approve(&streaming.address(), &TestToken::faucet_amount());

        Setup {
            env,
            token,
            streaming,
            sender,
            recipient,
        }
    }

    /// Creates a stream of 1000 units that starts now and runs for 100 days.
    fn create(s: &mut Setup) -> u64 {
        let now = s.env.block_time();
        let id = s.streaming.streams_count();
        s.env.set_caller(s.sender);
        s.streaming.create_stream(
            s.recipient,
            s.token.address(),
            U256::from(1000),
            now,
            now + 100 * DAY,
        );
        id
    }

    #[test]
    fn creating_a_stream_pulls_the_deposit() {
        let mut s = setup();
        let now = s.env.block_time();
        let id = create(&mut s);

        assert_eq!(id, 0);
        assert_eq!(s.streaming.streams_count(), 1);
        assert_eq!(s.token.balance_of(&s.streaming.address()), U256::from(1000));
        assert_eq!(
            s.token.balance_of(&s.sender),
            TestToken::faucet_amount() - 1000
        );
        assert_eq!(
            s.streaming.stream(id),
            Stream {
                sender: s.sender,
                recipient: s.recipient,
                token: s.token.address(),
                deposit: U256::from(1000),
                withdrawn: U256::zero(),
                start: now,
                stop: now + 100 * DAY,
                cancelled: false,
                refunded: U256::zero(),
            }
        );
        assert_eq!(s.streaming.streams_of_sender(s.sender), vec![0]);
        assert_eq!(s.streaming.streams_of_recipient(s.recipient), vec![0]);
        assert!(s.streaming.streams_of_sender(s.recipient).is_empty());
        assert!(s.env.emitted_event(
            &s.streaming,
            StreamCreated {
                stream_id: 0,
                sender: s.sender,
                recipient: s.recipient,
                token: s.token.address(),
                deposit: U256::from(1000),
                start: now,
                stop: now + 100 * DAY,
            }
        ));
    }

    #[test]
    fn streams_get_consecutive_ids() {
        let mut s = setup();
        assert_eq!(create(&mut s), 0);
        assert_eq!(create(&mut s), 1);
        assert_eq!(s.streaming.streams_count(), 2);
        assert_eq!(s.streaming.streams_of_recipient(s.recipient), vec![0, 1]);
        assert_eq!(s.streaming.streams_of_sender(s.sender), vec![0, 1]);
    }

    #[test]
    fn the_deposit_accrues_linearly() {
        let mut s = setup();
        let id = create(&mut s);
        let balance = |s: &Setup| {
            (
                s.streaming.balance_of(id, s.recipient),
                s.streaming.balance_of(id, s.sender),
            )
        };

        assert_eq!(balance(&s), (U256::zero(), U256::from(1000)));
        s.env.advance_block_time(DAY);
        assert_eq!(balance(&s), (U256::from(10), U256::from(990)));
        s.env.advance_block_time(49 * DAY);
        assert_eq!(balance(&s), (U256::from(500), U256::from(500)));
        s.env.advance_block_time(50 * DAY);
        assert_eq!(balance(&s), (U256::from(1000), U256::zero()));
        s.env.advance_block_time(1000 * DAY);
        assert_eq!(balance(&s), (U256::from(1000), U256::zero()));
        assert_eq!(
            s.streaming.balance_of(id, s.env.get_account(5)),
            U256::zero()
        );
    }

    #[test]
    fn the_accrued_share_is_rounded_down() {
        let mut s = setup();
        let id = create(&mut s);
        // 1000 units over 100 days: one unit every 2.4 hours.
        s.env.advance_block_time(DAY / 10 - 1);
        assert_eq!(s.streaming.balance_of(id, s.recipient), U256::zero());
        s.env.advance_block_time(1);
        assert_eq!(s.streaming.balance_of(id, s.recipient), U256::one());
    }

    #[test]
    fn nothing_accrues_before_a_future_start() {
        let mut s = setup();
        let now = s.env.block_time();
        s.env.set_caller(s.sender);
        s.streaming.create_stream(
            s.recipient,
            s.token.address(),
            U256::from(1000),
            now + 10 * DAY,
            now + 20 * DAY,
        );

        s.env.advance_block_time(10 * DAY);
        assert_eq!(s.streaming.balance_of(0, s.recipient), U256::zero());
        s.env.advance_block_time(5 * DAY);
        assert_eq!(s.streaming.balance_of(0, s.recipient), U256::from(500));
    }

    #[test]
    fn a_stream_may_start_in_the_past() {
        let mut s = setup();
        s.env.advance_block_time(50 * DAY);
        let now = s.env.block_time();
        s.env.set_caller(s.sender);
        s.streaming.create_stream(
            s.recipient,
            s.token.address(),
            U256::from(1000),
            now - 50 * DAY,
            now + 50 * DAY,
        );

        assert_eq!(s.streaming.balance_of(0, s.recipient), U256::from(500));
    }

    #[test]
    fn withdraw_pays_the_recipient_part_of_what_has_accrued() {
        let mut s = setup();
        let id = create(&mut s);

        s.env.advance_block_time(25 * DAY);
        s.env.set_caller(s.recipient);
        s.streaming.withdraw(id, U256::from(100));
        assert_eq!(s.token.balance_of(&s.recipient), U256::from(100));
        assert_eq!(s.streaming.stream(id).withdrawn, U256::from(100));
        assert_eq!(s.streaming.balance_of(id, s.recipient), U256::from(150));
        assert!(s.env.emitted_event(
            &s.streaming,
            Withdrawn {
                stream_id: id,
                recipient: s.recipient,
                amount: U256::from(100)
            }
        ));

        s.streaming.withdraw(id, U256::from(150));
        assert_eq!(s.token.balance_of(&s.recipient), U256::from(250));
        assert_eq!(
            s.streaming.try_withdraw(id, U256::one()),
            Err(Error::AmountExceedsBalance.into())
        );

        s.env.advance_block_time(75 * DAY);
        s.streaming.withdraw(id, U256::from(750));
        assert_eq!(s.token.balance_of(&s.recipient), U256::from(1000));
        assert_eq!(s.token.balance_of(&s.streaming.address()), U256::zero());
    }

    #[test]
    fn withdraw_is_guarded() {
        let mut s = setup();
        let id = create(&mut s);
        s.env.advance_block_time(50 * DAY);

        s.env.set_caller(s.sender);
        assert_eq!(
            s.streaming.try_withdraw(id, U256::one()),
            Err(Error::NotRecipient.into())
        );
        s.env.set_caller(s.recipient);
        assert_eq!(
            s.streaming.try_withdraw(id, U256::zero()),
            Err(Error::ZeroAmount.into())
        );
        assert_eq!(
            s.streaming.try_withdraw(id, U256::from(501)),
            Err(Error::AmountExceedsBalance.into())
        );
    }

    #[test]
    fn cancel_pays_the_accrued_part_and_refunds_the_rest() {
        let mut s = setup();
        let id = create(&mut s);
        let sender_balance = s.token.balance_of(&s.sender);

        s.env.advance_block_time(30 * DAY);
        s.env.set_caller(s.recipient);
        s.streaming.withdraw(id, U256::from(100));
        s.env.advance_block_time(10 * DAY);
        s.env.set_caller(s.sender);
        s.streaming.cancel(id);

        assert_eq!(s.token.balance_of(&s.recipient), U256::from(400));
        assert_eq!(s.token.balance_of(&s.sender), sender_balance + 600);
        assert_eq!(s.token.balance_of(&s.streaming.address()), U256::zero());
        assert!(s.env.emitted_event(
            &s.streaming,
            StreamCancelled {
                stream_id: id,
                sender: s.sender,
                recipient: s.recipient,
                paid: U256::from(300),
                refunded: U256::from(600)
            }
        ));
        let stream = s.streaming.stream(id);
        assert!(stream.cancelled);
        assert_eq!(stream.withdrawn, U256::from(400));
        assert_eq!(stream.refunded, U256::from(600));

        // Nothing accrues after cancelling.
        s.env.advance_block_time(100 * DAY);
        assert_eq!(s.streaming.balance_of(id, s.recipient), U256::zero());
        assert_eq!(s.streaming.balance_of(id, s.sender), U256::zero());
        s.env.set_caller(s.recipient);
        assert_eq!(
            s.streaming.try_withdraw(id, U256::one()),
            Err(Error::AmountExceedsBalance.into())
        );
    }

    #[test]
    fn cancel_before_the_start_refunds_everything() {
        let mut s = setup();
        let now = s.env.block_time();
        s.env.set_caller(s.sender);
        s.streaming.create_stream(
            s.recipient,
            s.token.address(),
            U256::from(1000),
            now + DAY,
            now + 2 * DAY,
        );

        s.streaming.cancel(0);
        assert_eq!(s.token.balance_of(&s.sender), TestToken::faucet_amount());
        assert_eq!(s.token.balance_of(&s.recipient), U256::zero());
    }

    #[test]
    fn cancel_after_the_stop_pays_the_recipient_everything_left() {
        let mut s = setup();
        let id = create(&mut s);
        let sender_balance = s.token.balance_of(&s.sender);

        s.env.advance_block_time(100 * DAY);
        s.streaming.cancel(id);
        assert_eq!(s.token.balance_of(&s.recipient), U256::from(1000));
        assert_eq!(s.token.balance_of(&s.sender), sender_balance);
    }

    #[test]
    fn cancel_is_guarded() {
        let mut s = setup();
        let id = create(&mut s);

        s.env.set_caller(s.recipient);
        assert_eq!(s.streaming.try_cancel(id), Err(Error::NotSender.into()));

        s.env.set_caller(s.sender);
        s.streaming.cancel(id);
        assert_eq!(
            s.streaming.try_cancel(id),
            Err(Error::AlreadyCancelled.into())
        );
    }

    #[test]
    fn invalid_streams_are_rejected() {
        let s = setup();
        let mut streaming = s.streaming;
        let token = s.token.address();
        s.env.set_caller(s.sender);

        let mut try_create = |deposit: U256, start: u64, stop: u64| {
            streaming.try_create_stream(s.recipient, token, deposit, start, stop)
        };

        assert_eq!(
            try_create(U256::zero(), 0, 100),
            Err(Error::ZeroAmount.into())
        );
        assert_eq!(
            try_create(U256::one(), 100, 100),
            Err(Error::InvalidTimes.into())
        );
        assert_eq!(
            try_create(U256::one(), 100, 50),
            Err(Error::InvalidTimes.into())
        );
        assert_eq!(
            try_create(U256::MAX, 0, 100),
            Err(Error::AmountTooLarge.into())
        );
        // More than the sender approved.
        assert_eq!(
            try_create(TestToken::faucet_amount() + 1, 0, 100),
            Err(Cep18Error::InsufficientAllowance.into())
        );
    }

    #[test]
    fn unknown_streams_are_reported() {
        let mut s = setup();
        assert_eq!(s.streaming.try_stream(7), Err(Error::StreamNotFound.into()));
        assert_eq!(
            s.streaming.try_withdraw(7, U256::one()),
            Err(Error::StreamNotFound.into())
        );
        assert_eq!(s.streaming.try_cancel(7), Err(Error::StreamNotFound.into()));
        assert_eq!(
            s.streaming.try_balance_of(7, s.sender),
            Err(Error::StreamNotFound.into())
        );
    }
}
