//! The arithmetic of a linear bonding curve, in integers.
//!
//! The price of one whole token, in motes, when `supply` tokens exist is
//!
//! ```text
//! price(supply) = base_price + slope * supply / unit
//! ```
//!
//! where `unit` is `10^decimals`, the number of the smallest units in a whole token, and `supply`
//! is counted in the smallest units. `base_price` is in motes per whole token and `slope` in motes
//! per whole token for each whole token of supply.
//!
//! What a purchase costs is the area under that line between the supply before and after it:
//!
//! ```text
//! area(from, amount) = (2 * base_price * unit * amount + slope * (2 * from * amount + amount^2))
//!                      / (2 * unit^2)
//! ```
//!
//! The contract rounds every result in its own favour: a purchase costs the area rounded up, a sale
//! pays it rounded down. The reserve therefore never holds less than the exact area under the line
//! up to the supply, and every holder can always sell.
//!
//! The arithmetic runs in `Num`, 512 bits. Each function returns `None` when an intermediate value does not
//! fit in it; the parameters of a real curve are many orders of magnitude below that.

use odra::casper_types::{U256, U512};

/// The integer type the curve computes in.
type Num = U512;

/// A linear price line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Line {
    /// The price of a whole token when no token exists, in motes.
    base_price: Num,
    /// How much the price of a whole token rises with each whole token of supply, in motes.
    slope: Num,
    /// `10^decimals`: the smallest units in a whole token.
    unit: Num,
}

impl Line {
    /// A line for a token of `decimals` decimals. `None` if a value does not fit.
    pub fn new(base_price: U512, slope: U512, decimals: u8) -> Option<Self> {
        Some(Line {
            base_price: from_motes(base_price)?,
            slope: from_motes(slope)?,
            unit: Num::from(10u64).pow(Num::from(decimals)),
        })
    }

    /// The price of a whole token at `supply`, in motes, rounded down.
    pub fn price(&self, supply: U256) -> Option<U512> {
        let price = self
            .base_price
            .checked_add(self.slope.checked_mul(from_tokens(supply)?)? / self.unit)?;
        to_motes(price)
    }

    /// What buying `amount` costs when `supply` tokens exist, in motes, rounded up.
    pub fn cost(&self, supply: U256, amount: U256) -> Option<U512> {
        let area = self.scaled_area(from_tokens(supply)?, from_tokens(amount)?)?;
        let scale = self.scale()?;
        to_motes(area.checked_add(scale - 1)? / scale)
    }

    /// What selling `amount` pays when `supply` tokens exist, in motes, rounded down. `None` if
    /// `amount` is more than the supply.
    pub fn proceeds(&self, supply: U256, amount: U256) -> Option<U512> {
        let from = from_tokens(supply.checked_sub(amount)?)?;
        to_motes(self.scaled_area(from, from_tokens(amount)?)? / self.scale()?)
    }

    /// The most tokens `cspr` motes buy when `supply` tokens exist: the largest `amount` whose
    /// `cost` is at most `cspr`. `None` for a line that is flat at zero.
    pub fn tokens_for(&self, supply: U256, cspr: U512) -> Option<U256> {
        let supply = from_tokens(supply)?;
        let two = Num::from(2);
        // cost(amount) <= cspr exactly when scaled_area(amount) <= cspr * scale.
        let budget = from_motes(cspr)?.checked_mul(self.scale()?)?;
        let fits =
            |amount: Num| -> Option<bool> { Some(self.scaled_area(supply, amount)? <= budget) };

        let mut amount = if self.slope.is_zero() {
            if self.base_price.is_zero() {
                return None;
            }
            // scaled_area = 2 * base_price * unit * amount.
            budget / two.checked_mul(self.base_price)?.checked_mul(self.unit)?
        } else {
            // slope * amount^2 + b * amount - budget <= 0, with
            // b = 2 * base_price * unit + 2 * slope * supply: the positive root, rounded down.
            let b = two
                .checked_mul(self.base_price)?
                .checked_mul(self.unit)?
                .checked_add(two.checked_mul(self.slope)?.checked_mul(supply)?)?;
            let discriminant = b
                .checked_mul(b)?
                .checked_add(Num::from(4).checked_mul(self.slope)?.checked_mul(budget)?)?;
            (discriminant.integer_sqrt() - b) / two.checked_mul(self.slope)?
        };
        // The square root is rounded down: step to the exact answer, at most a unit or two away.
        while fits(amount.checked_add(Num::one())?)? {
            amount += Num::one();
        }
        while !amount.is_zero() && !fits(amount)? {
            amount -= Num::one();
        }
        to_tokens(amount)
    }

    /// The area under the line from `from` to `from + amount`, times `2 * unit^2`, so that it is
    /// a whole number.
    fn scaled_area(&self, from: Num, amount: Num) -> Option<Num> {
        let two = Num::from(2);
        let flat = two
            .checked_mul(self.base_price)?
            .checked_mul(self.unit)?
            .checked_mul(amount)?;
        let rising = two
            .checked_mul(from)?
            .checked_add(amount)?
            .checked_mul(amount)?
            .checked_mul(self.slope)?;
        flat.checked_add(rising)
    }

    /// `2 * unit^2`, the denominator of `scaled_area`.
    fn scale(&self) -> Option<Num> {
        Num::from(2).checked_mul(self.unit.checked_mul(self.unit)?)
    }
}

// Conversions between the types of the contract and `Num`. Motes are a `U512` already.

fn from_tokens(value: U256) -> Option<Num> {
    let mut bytes = [0u8; 64];
    value.to_little_endian(&mut bytes[..32]);
    Some(Num::from_little_endian(&bytes))
}

fn from_motes(value: U512) -> Option<Num> {
    Some(value)
}

fn to_tokens(value: Num) -> Option<U256> {
    if value.bits() > 256 {
        return None;
    }
    let mut bytes = [0u8; 64];
    value.to_little_endian(&mut bytes);
    Some(U256::from_little_endian(&bytes[..32]))
}

fn to_motes(value: Num) -> Option<U512> {
    Some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CSPR: u64 = 1_000_000_000;

    /// Token units.
    fn t(value: u64) -> U256 {
        U256::from(value)
    }

    /// Motes.
    fn m(value: u64) -> U512 {
        U512::from(value)
    }

    fn line(base_price: u64, slope: u64, decimals: u8) -> Line {
        Line::new(m(base_price), m(slope), decimals).unwrap()
    }

    /// The curve of the demo: 0.1 CSPR, rising by 0.001 CSPR with each token, 9 decimals.
    fn demo() -> Line {
        line(CSPR / 10, CSPR / 1000, 9)
    }

    /// Small numbers and deterministic noise, for checks against brute force.
    fn lines() -> Vec<Line> {
        let mut lines = vec![demo(), line(0, 3, 0), line(7, 0, 0)];
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        for _ in 0..40 {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            let decimals = (seed % 4) as u8;
            let base = (seed >> 8) % 50;
            let slope = (seed >> 20) % 20 + u64::from(base == 0);
            lines.push(line(base, slope, decimals));
        }
        lines
    }

    #[test]
    fn the_price_rises_with_the_supply() {
        let line = demo();
        assert_eq!(line.price(t(0)), Some(m(CSPR / 10)));
        // 100 whole tokens: 0.1 + 100 * 0.001 = 0.2 CSPR.
        assert_eq!(line.price(t(100 * CSPR)), Some(m(CSPR / 5)));
    }

    #[test]
    fn cost_is_the_area_under_the_line() {
        let line = demo();
        // The first 100 tokens: 100 * (0.1 + 0.2) / 2 = 15 CSPR.
        assert_eq!(line.cost(t(0), t(100 * CSPR)), Some(m(15 * CSPR)));
        // The next 100: 100 * (0.2 + 0.3) / 2 = 25 CSPR.
        assert_eq!(line.cost(t(100 * CSPR), t(100 * CSPR)), Some(m(25 * CSPR)));
        assert_eq!(
            line.proceeds(t(200 * CSPR), t(100 * CSPR)),
            Some(m(25 * CSPR))
        );
        assert_eq!(line.cost(t(0), t(0)), Some(m(0)));
    }

    #[test]
    fn cost_rounds_up_and_proceeds_round_down() {
        // A token of 0 decimals at 0 base and slope 3: the first token costs 1.5 motes.
        let line = line(0, 3, 0);
        assert_eq!(line.cost(t(0), t(1)), Some(m(2)));
        assert_eq!(line.proceeds(t(1), t(1)), Some(m(1)));
    }

    #[test]
    fn proceeds_of_more_than_the_supply_are_none() {
        assert_eq!(demo().proceeds(t(5), t(6)), None);
    }

    #[test]
    fn tokens_for_is_the_most_the_cspr_buys() {
        for line in lines() {
            for supply in [0u64, 1, 9, 250, 10_007] {
                for cspr in [0u64, 1, 2, 3, 17, 100, 999, 123_456] {
                    let (supply, cspr) = (t(supply), m(cspr));
                    let amount = line.tokens_for(supply, cspr).unwrap();
                    assert!(line.cost(supply, amount).unwrap() <= cspr, "{line:?}");
                    assert!(
                        line.cost(supply, amount + 1).unwrap() > cspr,
                        "{line:?} {supply} {cspr} {amount}"
                    );
                }
            }
        }
    }

    #[test]
    fn tokens_for_matches_the_demo_numbers() {
        let line = demo();
        assert_eq!(line.tokens_for(t(0), m(15 * CSPR)), Some(t(100 * CSPR)));
        assert_eq!(line.tokens_for(t(0), m(0)), Some(t(0)));
        // A realistic purchase at a realistic supply, against the closed form:
        // at 1,000 tokens a token costs 1.1 CSPR, and 10 CSPR buys the root of
        // 0.0005 a^2 + 1.1 a = 10: a = (sqrt(2200^2 + 80000) - 2200) / 2 = 9.0536 tokens.
        let bought = line.tokens_for(t(1000 * CSPR), m(10 * CSPR)).unwrap();
        assert_eq!(bought / t(100_000), t(90_536));
        assert_eq!(
            super::Line::new(m(0), m(0), 9)
                .unwrap()
                .tokens_for(t(0), m(CSPR)),
            None
        );
    }

    #[test]
    fn buying_then_selling_never_pays_out_more_than_was_paid_in() {
        for line in lines() {
            for supply in [0u64, 1, 13, 4_000] {
                for amount in [1u64, 2, 7, 1_001, 65_537] {
                    let (supply, amount) = (t(supply), t(amount));
                    let paid = line.cost(supply, amount).unwrap();
                    let back = line.proceeds(supply + amount, amount).unwrap();
                    assert!(back <= paid, "{line:?}");
                    // And never by more than a mote of rounding.
                    assert!(paid - back <= m(1), "{line:?}");
                }
            }
        }
    }

    #[test]
    fn buying_in_parts_costs_at_least_as_much_as_at_once() {
        for line in lines() {
            let whole = line.cost(t(10), t(300)).unwrap();
            let parts = line.cost(t(10), t(100)).unwrap()
                + line.cost(t(110), t(150)).unwrap()
                + line.cost(t(260), t(50)).unwrap();
            assert!(parts >= whole, "{line:?}");
        }
    }

    #[test]
    fn the_largest_realistic_numbers_fit() {
        // 18 decimals, a price of a million CSPR rising by a million per token, a billion tokens
        // in supply and a purchase of a billion CSPR.
        let line = Line::new(m(1_000_000 * CSPR), m(1_000_000 * CSPR), 18).unwrap();
        let supply = U256::from(10u64).pow(U256::from(27));
        assert!(line.tokens_for(supply, m(CSPR) * m(CSPR)).is_some());
        assert!(line.cost(supply, supply).is_some());
        assert!(line.proceeds(supply, supply).is_some());
        assert!(line.price(supply).is_some());
    }

    #[test]
    fn overflow_is_none() {
        let line = Line::new(U512::MAX >> 2, m(1), 18);
        assert!(line.is_none() || line.unwrap().cost(t(0), t(1)).is_none());
        let line = demo();
        assert_eq!(line.tokens_for(t(0), U512::MAX), None);
        assert_eq!(line.cost(t(0), U256::MAX), None);
    }
}
