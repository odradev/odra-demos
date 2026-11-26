// The arithmetic of the linear bonding curve, the same as the contract's (src/math.rs), in BigInt.
//
// The price of one whole token, in motes, when `supply` smallest units exist:
//   price(supply) = basePrice + slope * supply / unit,        unit = 10^decimals
// A purchase costs the area under the line from the supply before it to the supply after it,
// rounded up; a sale pays the area it removes, rounded down.

export interface Line {
  /** The price of a whole token when none exists, in motes. */
  basePrice: bigint;
  /** How many motes the price of a whole token rises with each whole token of supply. */
  slope: bigint;
  /** `10^decimals`: the smallest units in a whole token. */
  unit: bigint;
}

export const makeLine = (basePrice: bigint, slope: bigint, decimals: number): Line => ({
  basePrice,
  slope,
  unit: 10n ** BigInt(decimals),
});

/** The area from `from` to `from + amount`, times `2 * unit^2`. */
const scaledArea = (line: Line, from: bigint, amount: bigint) =>
  2n * line.basePrice * line.unit * amount + line.slope * (2n * from + amount) * amount;

const scale = (line: Line) => 2n * line.unit * line.unit;

/** The price of a whole token at `supply`, in motes, rounded down. */
export const price = (line: Line, supply: bigint) => line.basePrice + (line.slope * supply) / line.unit;

/** What buying `amount` costs at `supply`, in motes, rounded up. */
export function cost(line: Line, supply: bigint, amount: bigint): bigint {
  const s = scale(line);
  return (scaledArea(line, supply, amount) + s - 1n) / s;
}

/** What selling `amount` pays at `supply`, in motes, rounded down. */
export function proceeds(line: Line, supply: bigint, amount: bigint): bigint {
  if (amount > supply) throw new Error("More than the supply.");
  return scaledArea(line, supply - amount, amount) / scale(line);
}

/** The square root, rounded down. */
function isqrt(value: bigint): bigint {
  if (value < 2n) return value;
  // Newton's method from a power of two above the root: it falls to the floor and stops.
  let x = 1n << BigInt(Math.ceil(value.toString(2).length / 2));
  for (;;) {
    const next = (x + value / x) / 2n;
    if (next >= x) return x;
    x = next;
  }
}

/** The most tokens `cspr` motes buy at `supply`: the largest amount whose `cost` is at most `cspr`. */
export function tokensFor(line: Line, supply: bigint, cspr: bigint): bigint {
  const budget = cspr * scale(line);
  const fits = (amount: bigint) => scaledArea(line, supply, amount) <= budget;
  let amount: bigint;
  if (line.slope === 0n) {
    if (line.basePrice === 0n) return 0n;
    amount = budget / (2n * line.basePrice * line.unit);
  } else {
    const b = 2n * line.basePrice * line.unit + 2n * line.slope * supply;
    amount = (isqrt(b * b + 4n * line.slope * budget) - b) / (2n * line.slope);
  }
  while (fits(amount + 1n)) amount += 1n;
  while (amount > 0n && !fits(amount)) amount -= 1n;
  return amount;
}
