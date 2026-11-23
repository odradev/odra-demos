# Ideas

The five projects to build first. Each one fills a gap in the Casper ecosystem and fits in a single contract.

## 1. Token vesting

Locks CEP-18 tokens for a beneficiary and releases them over time: nothing until the cliff, then linearly until the end date.

**Why:** every project that launches a token needs to vest team, investor and advisor allocations. Casper has a token creator and a DEX, but no vesting contract to go with them.

Built: [vesting/](vesting/).

**Scope:**
- `create_schedule(beneficiary, token, amount, start, cliff, end, revocable)`
- `release(schedule_id)`: transfers what has vested so far
- `revoke(schedule_id)`: the creator takes back the unvested part, if the schedule is revocable
- `releasable(schedule_id)`, `vested(schedule_id)` views

## 2. Multisend

Sends CSPR or a CEP-18 token to many recipients in one transaction.

**Why:** airdrops, payroll and reward payouts otherwise mean one transaction, and one signature, per recipient. This is the simplest tool on the list and the one most people can use on day one. It saves signing, not fees: see the measurements in [multisend/README.md](multisend/README.md).

**Scope:**
- `send_cspr(recipients, amounts)`: payable, the attached amount must equal the sum
- `send_token(token, recipients, amounts)`: moves each amount from the caller to its recipient with `transfer_from`
- Reverts as a whole if any transfer fails or the sums do not match

Built: [multisend/](multisend/).

## 3. Payment streaming

Pays a recipient continuously: the sender deposits tokens, and the recipient can withdraw the share that has accrued up to the current block time.

**Why:** salaries, grants and subscriptions paid by the second, with no trust needed after the deposit. Nothing on Casper does this on-chain today.

Built: [streaming/](streaming/).

**Scope:**
- `create_stream(recipient, token, deposit, start, stop)`
- `withdraw(stream_id, amount)`: the recipient takes accrued funds
- `cancel(stream_id)`: the accrued part goes to the recipient, the rest back to the sender
- `balance_of(stream_id, who)` view

## 4. Liquidity locker

Locks DEX liquidity-pool tokens until a set date, so everyone can check on-chain that a project cannot pull its liquidity.

**Why:** CSPR.trade is new and new tokens are listing on it. A public lock is the standard way for a project to show it will not remove liquidity, and Casper has no locker yet.

Built: [locker/](locker/).

**Scope:**
- `lock(token, amount, unlock_time)`
- `extend(lock_id, new_unlock_time)`: later only, never earlier
- `withdraw(lock_id)`: the owner, after the unlock time
- `transfer_ownership(lock_id, new_owner)`
- `locks_of(owner)`, `locked_amount(token)` views

## 5. Timelock controller

Holds admin rights over other contracts and executes each operation only after a public delay.

**Why:** Casper contracts are upgradable, so users have to trust whoever holds the upgrade key. With a timelock as the owner, every upgrade or parameter change is visible in advance and users have time to exit.

Built: [timelock/](timelock/).

**Scope:**
- `schedule(target, entry_point, args, delay)`: proposer role
- `execute(operation_id)`: executor role, once the delay has passed
- `cancel(operation_id)`: canceller role
- A minimum delay that only the timelock itself can change
