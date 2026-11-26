import "../../../style/odra.css";
import "./style.css";
import init, {
  AccountInfo,
  Address,
  Contracts,
  CsprClickCallbacks,
  OdraWasmClient,
  setGas,
  TestTokenErrors,
  TestTokenWasmClient,
  TokenSaleErrors,
  TokenSaleWasmClient,
  TransactionResult,
  TransactionStatus,
  U256,
  U512,
} from "sale-wasm-client";
import saleSchema from "../../resources/casper_contract_schemas/token_sale_schema.json";
import testTokenSchema from "../../resources/casper_contract_schemas/test_token_schema.json";
import deployedContracts from "./contracts.json";
import { toHex, Tree } from "./merkle";
import { ContractStorage, csprBalance, formattedKey, initStorage, refreshState } from "./storage";

// ---------- Configuration ----------

// A proxy of the Odra team: public nodes do not accept requests from a browser.
const RPC_URL = "https://testnet-rpc.odra.dev";
// The client wants a node for simulated calls too. The app makes none: it reads storage instead.
const SPECULATIVE_RPC_URL = "https://testnet-speculative-rpc.odra.dev";
const CHAIN_NAME = "casper-test";
const EXPLORER = "https://testnet.cspr.live";
const CSPR_CLICK_SCRIPT = "https://cdn.cspr.click/ui/v1.10.1/csprclick-client-1.10.1.js";

const CSPR = 1_000_000_000n;
const CSPR_DECIMALS = 9;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/**
 * How far the clock of this computer may be from the chain's. The contract checks the window
 * against the block time; a transaction sent too close to an edge could fail, and a failed one is
 * charged its whole fee.
 */
const CLOCK_MARGIN = 60 * 1000;
/** Lists longer than this are shared as a file: a link would be too long to paste anywhere. */
const MAX_LINK_ENTRIES = 300;
/** The preview shows this many rows; the count covers all of them. */
const PREVIEW_ROWS = 200;
/** Sales shown at a time in the list. */
const PAGE = 10;

/**
 * Payment limits in motes. Measured in November 2026, on the testnet for the calls the demo sent
 * and on CasperVM for the rest: faucet 0.30 CSPR, approve 0.36, create_sale 2.26, buy 4.73 with a
 * proof of 2 nodes (a payable call runs through a session that carries the CSPR; CasperVM charges
 * that 7.40, the testnet less), withdraw_proceeds 3.03, withdraw_unsold 1.29. 2.5 CSPR is the
 * smallest limit worth setting for a contract call; the network refunds three quarters of what a
 * transaction leaves unused.
 */
const GAS = {
  faucet: 2_500_000_000n,
  approve: 2_500_000_000n,
  create: 3n * CSPR,
  buy: 6n * CSPR,
  withdrawProceeds: 3_500_000_000n,
  withdrawUnsold: 2_500_000_000n,
};

const ERRORS: Record<number, string> = {
  [TokenSaleErrors.ZeroPrice]: "The price is zero.",
  [TokenSaleErrors.ZeroCap]: "There are no tokens on sale.",
  [TokenSaleErrors.InvalidWalletLimit]: "The limit per wallet is zero or more than is on sale.",
  [TokenSaleErrors.InvalidWindow]: "The sale must close after it opens.",
  [TokenSaleErrors.EndInPast]: "The closing time has already passed.",
  [TokenSaleErrors.InvalidRoot]: "The fingerprint of the list is not 32 bytes long.",
  [TokenSaleErrors.UnsupportedDecimals]: "The token has more decimals than the contract supports.",
  [TokenSaleErrors.SaleNotFound]: "There is no sale with this number.",
  [TokenSaleErrors.NotStarted]: "The sale has not opened yet.",
  [TokenSaleErrors.Ended]: "The sale has closed.",
  [TokenSaleErrors.NothingAttached]: "No CSPR was sent with the purchase.",
  [TokenSaleErrors.InexactPayment]: "The CSPR sent does not buy a whole number of the token's smallest unit.",
  [TokenSaleErrors.ExceedsCap]: "Less is left on sale than this purchase.",
  [TokenSaleErrors.ExceedsWalletLimit]: "This purchase would take you past the limit per wallet.",
  [TokenSaleErrors.NotOnAllowlist]: "The list does not show that you may buy, so the proof was rejected.",
  [TokenSaleErrors.NotCreator]: "Only the creator of the sale can do this.",
  [TokenSaleErrors.NothingToWithdraw]: "There is no CSPR to take out.",
  [TokenSaleErrors.NotEnded]: "The sale has not closed yet.",
  [TokenSaleErrors.NothingUnsold]: "Nothing unsold is left to take back.",
  [TestTokenErrors.InsufficientBalance]: "The token balance is too low.",
  [TestTokenErrors.InsufficientAllowance]: "The token allowance is too low.",
};

// ---------- Types ----------

interface Unit {
  symbol: string;
  decimals: number;
}

/** One line of a list of buyers: what was typed and, when it is valid, the address. */
interface Row {
  line: number;
  text: string;
  address?: string;
  problem?: string;
}

/** A sale as stored, with the unit of its token. */
interface Sale {
  id: number;
  creator: string;
  token: string;
  /** Motes for one whole token: 10^decimals of its smallest unit. */
  price: bigint;
  cap: bigint;
  perWallet: bigint;
  /** Block times in milliseconds. */
  start: number;
  end: number;
  /** Empty for a sale open to everyone. */
  root: Uint8Array;
  sold: bigint;
  raised: bigint;
  buyers: number;
  withdrawn: bigint;
  reclaimed: bigint;
  unit: Unit;
}

/** What the buy button would buy; `null` when nothing can be bought. */
interface Purchase {
  sale: Sale;
  amount: bigint;
  cost: bigint;
  proof: Uint8Array;
}

type Tab = "all" | "mine";

// ---------- State ----------

let client: OdraWasmClient;
let saleClient: TokenSaleWasmClient;
let saleAddress: string;
let saleStorage: ContractStorage;
let testTokenHash: string;
let account: { publicKey: string; address: string } | null = null;
/** The token the create form sells, as a formatted key. */
let token = "";
let tokenUnit: Unit = { symbol: "TEST", decimals: 9 };
let who: "everyone" | "list" = "everyone";
let rows: Row[] = [];
/** The creator's balance of the token; `null` until it is read. */
let available: bigint | null = null;
let busy = false;
let purchase: Purchase | null = null;
/** The sale shown in the buy form, to repaint it when the buttons change. */
let shownSale: Sale | null = null;
/** Increases with every read of the buy form, so that a slow read does not paint over a newer one. */
let buyRead = 0;
let tab: Tab = "all";
/** The ids of the current tab, newest first, and how many of them are shown. */
let listIds: number[] = [];
let listShown = 0;
let listRead = 0;
const tokenUnits = new Map<string, Promise<Unit>>();
const tokenStorages = new Map<string, Promise<ContractStorage>>();

// ---------- DOM ----------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const connectBtn = $<HTMLButtonElement>("connect");
const accountBox = $("account");
const accountKey = $("account-key");
const fatalBox = $("fatal");
const balanceEl = $("balance");
const faucetBtn = $<HTMLButtonElement>("faucet");
const buyForm = $<HTMLFormElement>("buy");
const bSale = $<HTMLInputElement>("b-sale");
const bListField = $("b-list-field");
const bList = $<HTMLTextAreaElement>("b-list");
const bAmount = $<HTMLInputElement>("b-amount");
const bAmountHint = $("b-amount-hint");
const bMax = $<HTMLButtonElement>("b-max");
const buySummary = $("buy-summary");
const buyError = $("buy-error");
const buySubmit = $<HTMLButtonElement>("buy-submit");
const buyHint = $("buy-hint");
const saleEl = $("sale");
const createForm = $<HTMLFormElement>("create");
const createError = $("create-error");
const createSubmit = $<HTMLButtonElement>("create-submit");
const createHint = $("create-hint");
const fToken = $<HTMLInputElement>("f-token");
const fTokenInfo = $("f-token-info");
const fCap = $<HTMLInputElement>("f-cap");
const fPrice = $<HTMLInputElement>("f-price");
const fPerWallet = $<HTMLInputElement>("f-per-wallet");
const fStart = $<HTMLInputElement>("f-start");
const fEnd = $<HTMLInputElement>("f-end");
const fListField = $("f-list-field");
const fList = $<HTMLTextAreaElement>("f-list");
const summaryEl = $("summary");
const previewEl = $("preview");
const shareBox = $("share");
const shareLink = $<HTMLInputElement>("share-link");
const shareFile = $<HTMLAnchorElement>("share-file");
const salesEl = $("sales");
const listNote = $("list-note");
const moreBtn = $<HTMLButtonElement>("more");
const txBox = $("tx");
const txText = $("tx-text");
const txLink = $<HTMLAnchorElement>("tx-link");

// ---------- Formatting ----------

const short = (value: string) => {
  const body = value.replace(/^(account-hash-|hash-)/, "");
  return body.length > 14 ? `${body.slice(0, 6)}…${body.slice(-6)}` : body;
};

/** Formats an amount of the smallest unit as a decimal number with up to 4 fraction digits. */
function formatAmount(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = (value / base).toLocaleString("en-US");
  const fraction = (value % base).toString().padStart(decimals, "0").slice(0, 4).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/** An amount of the smallest unit as a decimal number with every digit. */
function exactAmount(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = (value / base).toLocaleString("en-US");
  const fraction = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

const show = (value: bigint, unit: Unit) => `${formatAmount(value, unit.decimals)} ${unit.symbol}`;
const showExact = (value: bigint, unit: Unit) => `${exactAmount(value, unit.decimals)} ${unit.symbol}`;
const cspr = (motes: bigint) => `${exactAmount(motes, CSPR_DECIMALS)} CSPR`;
const fee = (motes: bigint) => `${formatAmount(motes, CSPR_DECIMALS)} CSPR`;

/** Parses a decimal number into the smallest unit; `null` if it is not a valid amount. */
function parseAmount(text: string, decimals: number): bigint | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text.trim().replace(/[_,]/g, ""));
  if (!match) return null;
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) return null;
  return BigInt(match[1]) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

/**
 * Reads an address from a public key (`01…`, `02…`) or a formatted key (`account-hash-…`,
 * `hash-…`) and returns it as a formatted key. Throws if the text is neither.
 *
 * Addresses are kept as strings: a call of the client consumes the `Address`, `U256` and `U512`
 * objects passed to it, so each call gets fresh ones (`address(text)`).
 */
function parseAddress(text: string): string {
  const value = text.trim();
  return key(/^0[12][0-9a-fA-F]{64,66}$/.test(value) ? Address.fromPublicKey(value) : new Address(value));
}

/**
 * The formatted key of an address: `account-hash-…` or `hash-…`. `Address.value` prints another
 * form (`entity-account-…`, `contract-package-…`), which `new Address` does not read back.
 */
function key(parsed: Address): string {
  const value = parsed.value;
  const hex = value.slice(-64);
  return value.startsWith("contract-package-") || value.startsWith("hash-")
    ? `hash-${hex}`
    : `account-hash-${hex}`;
}

const address = (formatted: string) => new Address(formatted);

const formatDate = (ms: number) =>
  new Date(ms).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });

/** A `datetime-local` value for a moment, in the local time zone. */
function localInput(ms: number): string {
  const date = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 19);
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : JSON.stringify(error);
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

const plural = (count: number, word: string) =>
  `${count.toLocaleString("en-US")} ${word}${count === 1 ? "" : "s"}`;

/** Text as URL-safe base64 of its UTF-8 bytes, and back: how a list travels in a sale link. */
function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(encoded: string): string {
  const binary = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

// ---------- Prices ----------

// The contract gives `paid × 10^decimals / price` of the smallest unit for `paid` motes and
// refuses CSPR that does not buy a whole number of them. The page therefore starts from the
// amount of tokens and pays exactly what it costs.

const scale = (decimals: number) => 10n ** BigInt(decimals);

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

/** The motes `amount` costs, or `null` when that is not a whole number of motes. */
function costOf(sale: { price: bigint; unit: Unit }, amount: bigint): bigint | null {
  const motes = amount * sale.price;
  const base = scale(sale.unit.decimals);
  return motes % base === 0n ? motes / base : null;
}

/** The smallest amount with a whole price: every purchase is a multiple of it. */
const stepOf = (price: bigint, decimals: number) => scale(decimals) / gcd(price, scale(decimals));

/** The price of one whole token, as the reader thinks of it. */
const priceText = (sale: { price: bigint; unit: Unit }) => `${cspr(sale.price)} per ${sale.unit.symbol}`;

// ---------- Reading the chain ----------

// State is read from the node's storage (see storage.ts). The generated client is used only to
// send transactions.

const tokenClient = (hash: string) => new TestTokenWasmClient(client, address(hash));

/**
 * The storage of a token. Every token is read with the schema of `TestToken`, which keeps the
 * state of Odra's `Cep18` module in a field called `token`; a token laid out differently fails
 * to read.
 */
function tokenStorage(hash: string): Promise<ContractStorage> {
  let storage = tokenStorages.get(hash);
  if (!storage) {
    storage = ContractStorage.open(testTokenSchema, hash);
    storage.catch(() => tokenStorages.delete(hash));
    tokenStorages.set(hash, storage);
  }
  return storage;
}

/** The symbol and decimals of a token. A token that cannot be read is shown in raw units. */
function readTokenUnit(hash: string): Promise<Unit> {
  let found = tokenUnits.get(hash);
  if (!found) {
    found = (async () => {
      try {
        const storage = await tokenStorage(hash);
        const symbol = await storage.read("token.symbol");
        const decimals = await storage.read("token.decimals");
        if (symbol === null || decimals === null) throw new Error("Not a CEP-18 token.");
        return { symbol, decimals: Number(decimals) };
      } catch {
        return { symbol: short(hash), decimals: 0 };
      }
    })();
    tokenUnits.set(hash, found);
  }
  return found;
}

/** A token amount stored under `keys`; an amount that was never written is zero. */
async function tokenAmount(hash: string, path: string, keys: string[]): Promise<bigint> {
  return BigInt((await (await tokenStorage(hash)).read(path, keys)) ?? "0");
}

const balanceOf = (hash: string, owner: string) => tokenAmount(hash, "token.balances", [owner]);

const allowanceOf = (hash: string, owner: string, spender: string) =>
  tokenAmount(hash, "token.allowances", [`${owner}:${spender}`]);

/** The number of sales created: also the number the next one gets. */
async function salesCount(): Promise<number> {
  return Number((await saleStorage.read("count")) ?? "0");
}

/** The sale with number `id`, or `null` if there is none. */
async function readSale(id: number): Promise<Sale | null> {
  const stored = await saleStorage.read("sales", [String(id)]);
  if (stored === null) return null;
  // A struct is printed as a JSON object whose values are all strings.
  const sale = JSON.parse(stored) as Record<string, string>;
  const tokenKey = formattedKey(sale.token);
  const unit = await readTokenUnit(tokenKey);
  return {
    id,
    creator: formattedKey(sale.creator),
    token: tokenKey,
    price: BigInt(sale.price),
    cap: BigInt(sale.cap),
    perWallet: BigInt(sale.per_wallet),
    start: Number(sale.start),
    end: Number(sale.end),
    // Bytes inside a struct are printed as a list of numbers: "[61,115,…]".
    root: Uint8Array.from(JSON.parse(sale.allowlist_root) as number[]),
    sold: BigInt(sale.sold),
    raised: BigInt(sale.raised),
    buyers: Number(sale.buyers),
    withdrawn: BigInt(sale.withdrawn),
    reclaimed: BigInt(sale.reclaimed),
    // The decimals the price is counted in are the ones the sale read from the token.
    unit: { symbol: unit.symbol, decimals: Number(sale.decimals) },
  };
}

/** What `buyer` has bought from sale `id`. */
async function boughtBy(id: number, buyer: string): Promise<bigint> {
  return BigInt((await saleStorage.read("bought", [`${id}:${buyer}`])) ?? "0");
}

/** The ids of the sales `creator` created, oldest first. */
async function salesOf(creator: string): Promise<number[]> {
  const list = await saleStorage.read("sales_of_creator", [creator]);
  return (list?.match(/\d+/g) ?? []).map(Number);
}

/** Where a sale is, on the local clock, by the same rules as the contract. */
function stateOf(sale: Sale, now = Date.now()): "upcoming" | "open" | "sold out" | "closed" {
  if (now >= sale.end) return "closed";
  if (sale.sold === sale.cap) return "sold out";
  return now < sale.start ? "upcoming" : "open";
}

function chipOf(sale: Sale): { text: string; tone: "" | "good" | "warn" } {
  switch (stateOf(sale)) {
    case "upcoming":
      return { text: `Opens ${formatDate(sale.start)}`, tone: "" };
    case "open":
      return { text: `Open until ${formatDate(sale.end)}`, tone: "good" };
    case "sold out":
      return { text: "Sold out", tone: "" };
    case "closed":
      return { text: `Closed ${formatDate(sale.end)}`, tone: "warn" };
  }
}

// ---------- Lists of buyers ----------

/** Reads a list into rows: an address per line. An address may appear once. */
function parseList(text: string): Row[] {
  const parsed: Row[] = [];
  const seen = new Map<string, number>();
  text.split("\n").forEach((raw, index) => {
    // A list pasted from the airdrop app or a spreadsheet may carry a second column: drop it.
    const line = raw.trim().split(/[\s,;]+/)[0] ?? "";
    if (!line) return;
    const row: Row = { line: index + 1, text: raw.trim() };
    try {
      row.address = parseAddress(line);
      if (seen.has(row.address)) row.problem = `Already on line ${seen.get(row.address)}`;
      else seen.set(row.address, row.line);
    } catch {
      row.problem = "Not an address";
    }
    parsed.push(row);
  });
  return parsed;
}

const addresses = (list: Row[]) => list.map((row) => row.address!);

/** The list as the sale link and the file carry it: one address per line. */
const listText = (list: Row[]) => addresses(list).join("\n") + "\n";

/** The lines of a list that are not valid, in words; an empty string when there are none. */
function brokenLines(list: Row[]): string {
  const broken = list.filter((row) => row.problem);
  if (broken.length === 0) return "";
  const lines = broken
    .slice(0, 5)
    .map((row) => row.line)
    .join(", ");
  return `Line${broken.length === 1 ? "" : "s"} ${lines}${broken.length > 5 ? " and more" : ""}`;
}

// ---------- Buying ----------

function showBuyError(text: string) {
  buyError.textContent = text;
  buyError.hidden = !text;
}

/** The number typed in the buy form, or `null`. */
function saleNumber(): number | null {
  const typed = bSale.value.trim();
  return /^\d+$/.test(typed) ? Number(typed) : null;
}

function paintBuyButton(text: string) {
  buySubmit.textContent = text;
  buySubmit.disabled = busy || purchase === null;
}

/** The most the connected account may still buy from `sale`, by the cap and its limit. */
function mostFor(sale: Sale, bought: bigint): bigint {
  const left = sale.cap - sale.sold;
  const room = sale.perWallet - bought;
  const most = left < room ? left : room;
  const step = stepOf(sale.price, sale.unit.decimals);
  return most - (most % step);
}

/**
 * Reads the sale and the form and says what the connected account would pay and get. Sets
 * `purchase` when the button can buy.
 */
async function refreshBuy() {
  const read = ++buyRead;
  const current = () => read === buyRead;
  purchase = null;
  paintBuyButton("Buy");
  bMax.disabled = true;
  bAmountHint.textContent = "";
  buyHint.textContent = `The network takes up to ${fee(GAS.buy)} as a fee for the purchase and refunds most of what is not used.`;

  const id = saleNumber();
  if (id === null) {
    buySummary.textContent = bSale.value.trim() ? "A sale number is a whole number." : "Enter the sale number.";
    saleEl.replaceChildren(element("p", "empty", "Enter a sale number to see it."));
    bListField.hidden = true;
    shownSale = null;
    return;
  }

  let sale: Sale | null;
  try {
    sale = await readSale(id);
  } catch (error) {
    if (current()) buySummary.textContent = errorText(error);
    return;
  }
  if (!current()) return;
  shownSale = sale;
  if (!sale) {
    buySummary.textContent = `There is no sale #${id} yet.`;
    saleEl.replaceChildren(element("p", "empty", `There is no sale #${id} yet.`));
    bListField.hidden = true;
    return;
  }
  $("b-unit").textContent = sale.unit.symbol;
  const listed = sale.root.length > 0;
  bListField.hidden = !listed;
  let bought = 0n;
  if (account) {
    try {
      bought = await boughtBy(id, account.address);
    } catch (error) {
      if (current()) buySummary.textContent = errorText(error);
      return;
    }
    if (!current()) return;
  }
  saleEl.replaceChildren(await saleItem(sale, { bought, inForm: true }));
  if (!current()) return;

  const state = stateOf(sale);
  const now = Date.now();
  const price = `The price is ${priceText(sale)}.`;
  if (state === "closed" || now >= sale.end - CLOCK_MARGIN) {
    buySummary.textContent = `Sale #${id} closed on ${formatDate(sale.end)}. ${price}`;
    return;
  }
  if (state === "sold out") {
    buySummary.textContent = `Sale #${id} is sold out: all ${show(sale.cap, sale.unit)} are bought.`;
    return;
  }
  if (state === "upcoming" || now < sale.start + CLOCK_MARGIN) {
    buySummary.textContent = `Sale #${id} opens on ${formatDate(sale.start)}. ${price}`;
    return;
  }
  // A list sale: the proof comes from the list pasted in the form.
  let proof: Uint8Array = new Uint8Array();
  if (listed) {
    const list = parseList(bList.value);
    if (list.length === 0) {
      buySummary.textContent = `Sale #${id} sells only to the accounts on its list. Paste the list you were sent, or open the sale link.`;
      return;
    }
    const broken = brokenLines(list);
    if (broken) {
      buySummary.textContent = `${broken} of the list cannot be read: ${list.find((row) => row.problem)!.problem}.`;
      return;
    }
    const tree = new Tree(addresses(list));
    if (toHex(tree.root) !== toHex(sale.root)) {
      buySummary.textContent = `This list is not the list of sale #${id}: its fingerprint is different. You need the whole list, exactly as it was when the sale was created.`;
      return;
    }
    if (!account) {
      buySummary.textContent = `The list matches sale #${id}. ${price} Connect a wallet to see whether you are on it.`;
      return;
    }
    const index = list.findIndex((row) => row.address === account!.address);
    if (index < 0) {
      buySummary.textContent = `The list matches sale #${id}, and your account is not on it.`;
      return;
    }
    proof = tree.proofBytes(index);
  }
  if (!account) {
    buySummary.textContent = `${price} Connect a wallet to buy.`;
    return;
  }

  const most = mostFor(sale, bought);
  if (most === 0n) {
    buySummary.textContent =
      bought >= sale.perWallet
        ? `You have bought ${show(bought, sale.unit)}, the most one wallet may buy from this sale.`
        : `Too little is left of sale #${id} to buy.`;
    return;
  }
  bMax.disabled = busy;
  bMax.textContent = `The most I can buy: ${show(most, sale.unit)}`;

  const typed = bAmount.value.trim();
  const before = bought > 0n ? ` You have bought ${show(bought, sale.unit)} from it already.` : "";
  if (!typed) {
    buySummary.textContent = `${price} You can buy up to ${show(most, sale.unit)}.${before}`;
    return;
  }
  const wanted = parseAmount(typed, sale.unit.decimals);
  if (wanted === null || wanted === 0n) {
    buySummary.textContent = `Enter an amount of ${sale.unit.symbol}, up to ${sale.unit.decimals} decimals, with a dot.`;
    return;
  }
  const step = stepOf(sale.price, sale.unit.decimals);
  const amount = wanted - (wanted % step);
  if (amount !== wanted) {
    bAmountHint.textContent = `Rounded down to ${showExact(amount, sale.unit)}: at this price, a smaller part would not cost a whole number of motes.`;
  }
  if (amount === 0n) {
    buySummary.textContent = `The smallest purchase at this price is ${showExact(step, sale.unit)}.`;
    return;
  }
  if (amount > most) {
    buySummary.textContent = `You can buy up to ${show(most, sale.unit)}.${before}`;
    return;
  }
  const cost = costOf(sale, amount)!;
  const balance = await csprBalance(account.address).catch(() => null);
  if (!current()) return;
  if (balance !== null && balance < cost + GAS.buy) {
    buySummary.textContent = `This costs ${cspr(cost)}, and the fee up to ${fee(GAS.buy)}; you have ${fee(balance)}.`;
    return;
  }

  purchase = { sale, amount, cost, proof };
  const after = bought + amount;
  buySummary.textContent =
    `You pay ${cspr(cost)} and receive ${showExact(amount, sale.unit)} in the same transaction, at ${priceText(sale)}. ` +
    `That makes ${show(after, sale.unit)} of the ${show(sale.perWallet, sale.unit)} one wallet may buy.`;
  paintBuyButton(`Buy ${showExact(amount, sale.unit)} for ${cspr(cost)}`);
}

async function buy() {
  showBuyError("");
  const chosen = purchase;
  if (!account || !chosen) return;
  const what = `${showExact(chosen.amount, chosen.sale.unit)} for ${cspr(chosen.cost)}`;
  await withBusy(async () => {
    const bought = await send(`Buying ${what}`, GAS.buy, () =>
      saleClient.buy(BigInt(chosen.sale.id), chosen.proof, U512.fromBigInt(chosen.cost)),
    );
    if (bought) {
      bAmount.value = "";
      $("step-sale").classList.add("done");
    }
  });
}

/** Fills in the most the connected account can buy, every digit of it. */
async function buyMost() {
  const sale = shownSale;
  if (!sale || !account) return;
  const most = mostFor(sale, await boughtBy(sale.id, account.address));
  bAmount.value = exactAmount(most, sale.unit.decimals).replace(/,/g, "");
  await refreshBuy();
}

// ---------- A sale ----------

/** `you` for the connected account, a shortened address for anyone else. */
const whoIs = (formatted: string) => (account?.address === formatted ? "you" : short(formatted));

/**
 * The card of one sale: what is on sale, how much is sold, and for its creator the withdrawals.
 * `inForm` is the card next to the buy form, which has no button to open it there.
 */
async function saleItem(sale: Sale, options: { bought?: bigint; inForm?: boolean } = {}): Promise<HTMLElement> {
  const amount = (value: bigint) => show(value, sale.unit);
  const card = element("article", "item");

  const head = element("div", "head");
  const heading = element("div");
  const audience = sale.root.length > 0 ? "to a list" : "to everyone";
  heading.append(
    element("div", "title", `${amount(sale.cap)} at ${priceText(sale)}`),
    element("div", "from", `Sale #${sale.id} · by ${whoIs(sale.creator)} · ${audience}`),
  );
  const chip = chipOf(sale);
  head.append(heading, element("span", `chip ${chip.tone}`.trim(), chip.text));

  const bar = element("div", "progress");
  const fill = element("div", "fill");
  fill.style.width = `${Number((sale.sold * 10_000n) / sale.cap) / 100}%`;
  bar.append(fill);
  bar.title = `${amount(sale.sold)} of ${amount(sale.cap)} sold`;

  const tiles = element("div", "tiles");
  /** A stat tile; `dot` is the class of its legend dot ("" for the brand colour), `null` for none. */
  const tile = (dot: string | null, name: string, value: string, sub: string) => {
    const node = element("div", "tile");
    const label = element("div", "label", name);
    if (dot !== null) label.prepend(element("span", `dot ${dot}`.trim()));
    node.append(label, element("div", "value", value), element("div", "sub", sub));
    tiles.append(node);
  };
  const left = sale.cap - sale.sold;
  const percent = Number((sale.sold * 1000n) / sale.cap) / 10;
  tile("", "Sold", formatAmount(sale.sold, sale.unit.decimals), `${sale.unit.symbol}, ${percent}% of the cap`);
  tile(
    "rest",
    sale.reclaimed > 0n ? "Unsold, taken back" : "Left",
    formatAmount(sale.reclaimed > 0n ? sale.reclaimed : left, sale.unit.decimals),
    sale.unit.symbol,
  );
  tile(null, "Raised", formatAmount(sale.raised, CSPR_DECIMALS), `CSPR from ${plural(sale.buyers, "buyer")}`);

  const parts: HTMLElement[] = [head, bar, tiles];
  if (options.bought !== undefined && options.bought > 0n) {
    parts.push(element("p", "hint", `You have bought ${amount(options.bought)} of this sale.`));
  }

  const actions = element("div", "actions");
  const state = stateOf(sale);
  if (!options.inForm && state !== "closed") {
    const open = element("button", "", sale.root.length > 0 ? "Open it to buy, with its list" : "Open it to buy");
    open.type = "button";
    open.addEventListener("click", () => openSale(sale.id));
    actions.append(open);
  }
  if (account?.address === sale.creator) {
    const proceeds = sale.raised - sale.withdrawn;
    if (proceeds > 0n) {
      const take = element("button", "", `Take out ${cspr(proceeds)}`);
      take.disabled = busy;
      take.addEventListener("click", () => void withdrawProceeds(sale, proceeds));
      actions.append(take);
    }
    const unsold = sale.cap - sale.sold - sale.reclaimed;
    if (unsold > 0n && Date.now() >= sale.end + CLOCK_MARGIN) {
      const back = element("button", "", `Take back ${amount(unsold)} unsold`);
      back.disabled = busy;
      back.addEventListener("click", () => void withdrawUnsold(sale, unsold));
      actions.append(back);
    } else if (unsold > 0n) {
      actions.append(
        element("span", "hint", `What is unsold you can take back after ${formatDate(sale.end)}.`),
      );
    }
  }
  if (actions.childElementCount > 0) parts.push(actions);

  const details = element("details");
  const facts = element("dl", "facts");
  const fact = (name: string, value: string) =>
    facts.append(element("dt", "", name), element("dd", "mono", value));
  fact("Price", `${priceText(sale)} (${sale.price} motes per ${scale(sale.unit.decimals)} units)`);
  fact("Most per wallet", amount(sale.perWallet));
  fact("Opens", formatDate(sale.start));
  fact("Closes", formatDate(sale.end));
  fact("Who can buy", sale.root.length > 0 ? `The accounts of a list with the fingerprint ${toHex(sale.root)}` : "Everyone");
  fact("CSPR taken out", cspr(sale.withdrawn));
  fact("Creator", sale.creator);
  fact("Token", sale.token);
  details.append(element("summary", "", "Details"), facts);
  parts.push(details);

  card.append(...parts);
  return card;
}

/** Loads a sale into the buy form. */
function openSale(id: number) {
  bSale.value = String(id);
  showBuyError("");
  void refreshBuy();
  buyForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function withdrawProceeds(sale: Sale, amount: bigint) {
  await withBusy(async () => {
    await send(`Taking out ${cspr(amount)}`, GAS.withdrawProceeds, () =>
      saleClient.withdrawProceeds(BigInt(sale.id)),
    );
  });
}

async function withdrawUnsold(sale: Sale, amount: bigint) {
  await withBusy(async () => {
    await send(`Taking back ${show(amount, sale.unit)}`, GAS.withdrawUnsold, () =>
      saleClient.withdrawUnsold(BigInt(sale.id)),
    );
  });
}

// ---------- The list of sales ----------

function selectTab(next: Tab) {
  tab = next;
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
    const active = button.dataset.tab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  }
  void refreshList();
}

/** Reloads the ids of the current tab and shows the first page of them. */
async function refreshList() {
  const read = ++listRead;
  listNote.textContent =
    tab === "all"
      ? "Newest first. Anyone can read them, no wallet needed."
      : "The sales you created, newest first, with what you can take out of them.";
  if (tab === "mine" && !account) {
    listIds = [];
    salesEl.replaceChildren(element("p", "empty", "Connect a wallet to see the sales you created."));
    moreBtn.hidden = true;
    return;
  }
  try {
    const ids =
      tab === "all"
        ? Array.from({ length: await salesCount() }, (_, index) => index)
        : await salesOf(account!.address);
    if (read !== listRead) return;
    listIds = ids.sort((a, b) => b - a);
    listShown = 0;
    salesEl.replaceChildren();
    if (listIds.length === 0) {
      salesEl.append(
        element("p", "empty", tab === "all" ? "No sales yet." : "You have not created a sale yet."),
      );
    }
    await showMore(read);
  } catch (error) {
    if (read === listRead) salesEl.replaceChildren(element("p", "notice", errorText(error)));
  }
}

/** Shows the next page of the current tab. Reads one sale after another: the node proxy is shared. */
async function showMore(read = listRead) {
  const page = listIds.slice(listShown, listShown + PAGE);
  for (const id of page) {
    const sale = await readSale(id);
    if (read !== listRead) return;
    if (sale) salesEl.append(await saleItem(sale));
  }
  listShown += page.length;
  moreBtn.hidden = listShown >= listIds.length;
}

// ---------- Creating a sale ----------

/** A moment chosen in the form, in milliseconds; NaN if it cannot be read. */
const moment = (input: HTMLInputElement) => (input.value ? new Date(input.value).getTime() : NaN);

/** Whether the sale opens when it is created: "Opens now" chosen, or a time already past. */
const opensNow = () => !fStart.value || moment(fStart) <= Date.now();

function setStart(choice: string) {
  const after: Record<string, number> = { "1h": HOUR, "1d": DAY };
  fStart.value = choice in after ? localInput(Date.now() + after[choice]) : "";
  mark("start", choice);
  // The length chosen stays: the end moves with the start.
  const length = document.querySelector<HTMLButtonElement>("[data-end].active")?.dataset.end;
  if (length) setEnd(length);
  else renderSummary();
}

function setEnd(choice: string) {
  const after: Record<string, number> = { "1h": HOUR, "1d": DAY, "1w": 7 * DAY, "30d": 30 * DAY };
  const from = opensNow() ? Date.now() : moment(fStart);
  fEnd.value = localInput(from + after[choice]);
  mark("end", choice);
  renderSummary();
}

function setWho(choice: "everyone" | "list") {
  who = choice;
  mark("who", choice);
  fListField.hidden = who !== "list";
  refreshRows();
}

function mark(group: string, choice: string) {
  for (const button of document.querySelectorAll<HTMLButtonElement>(`[data-${group}]`)) {
    button.classList.toggle("active", button.dataset[group] === choice);
  }
}

/** The terms typed in the form; a field that cannot be read is `null`. */
function terms() {
  const cap = parseAmount(fCap.value, tokenUnit.decimals);
  const price = parseAmount(fPrice.value, CSPR_DECIMALS);
  const perWallet = fPerWallet.value.trim() ? parseAmount(fPerWallet.value, tokenUnit.decimals) : cap;
  return { cap, price, perWallet, start: opensNow() ? null : moment(fStart), end: moment(fEnd) };
}

/** What stops the sale from being created, or an empty string when it can be. */
function blocker(): string {
  const t = terms();
  if (!fCap.value.trim()) return `Enter how many ${tokenUnit.symbol} to sell.`;
  if (t.cap === null || t.cap === 0n) return `Enter how many ${tokenUnit.symbol} to sell, up to ${tokenUnit.decimals} decimals.`;
  if (!fPrice.value.trim()) return "Enter the price of one token in CSPR.";
  if (t.price === null || t.price === 0n) return "Enter the price of one token in CSPR, more than zero, up to 9 decimals.";
  if (t.perWallet === null || t.perWallet === 0n) return `Enter the most one wallet may buy, in ${tokenUnit.symbol}, or leave it empty.`;
  if (t.perWallet > t.cap) return "One wallet cannot be allowed more than is on sale.";
  const step = stepOf(t.price, tokenUnit.decimals);
  if (step > t.perWallet) {
    return `At this price the smallest purchase is ${showExact(step, tokenUnit)}, more than one wallet may buy.`;
  }
  if (Number.isNaN(t.end)) return "Choose when the sale closes.";
  if (t.start !== null && Number.isNaN(t.start)) return "The opening time is not a date.";
  if (t.end <= (t.start ?? Date.now()) + CLOCK_MARGIN) return "The sale must close after it opens.";
  if (who === "list") {
    if (rows.length === 0) return "Paste the list of accounts that may buy.";
    const broken = brokenLines(rows);
    if (broken) return `Fix ${broken.toLowerCase()} of the list first; see on the right.`;
  }
  if (account && available !== null && available < t.cap) {
    return `You are selling ${show(t.cap, tokenUnit)}, and you have ${show(available, tokenUnit)}.`;
  }
  return "";
}

/** The tree of the list in the form, when the sale sells to a list and every line is valid. */
function formTree(): Tree | null {
  return who === "list" && rows.length > 0 && !rows.some((row) => row.problem) ? new Tree(addresses(rows)) : null;
}

function renderPreview(tree: Tree | null) {
  if (who === "everyone") {
    previewEl.replaceChildren(
      element(
        "p",
        "empty",
        "Everyone: any account can buy, up to the limit per wallet. One person can use several accounts; choose a list to sell only to accounts you know.",
      ),
    );
    return;
  }
  if (rows.length === 0) {
    previewEl.replaceChildren(element("p", "empty", "Nothing yet. Paste the list on the left."));
    return;
  }
  const facts = element("dl", "facts");
  const valid = rows.filter((row) => !row.problem).length;
  facts.append(
    element("dt", "", "Accounts"),
    element("dd", "", valid.toLocaleString("en-US")),
    element("dt", "", "Fingerprint"),
    element("dd", "mono", tree ? toHex(tree.root) : "Worked out once every line is valid."),
  );
  const table = element("table");
  const head = element("tr");
  head.append(element("th", "", "Line"), element("th", "", "Account"));
  const thead = element("thead");
  thead.append(head);
  const tbody = element("tbody");
  for (const row of rows.slice(0, PREVIEW_ROWS)) {
    const tr = element("tr");
    const cell = element("td");
    if (row.problem) {
      cell.append(element("span", "mono", row.text.slice(0, 40)), " ", element("span", "chip warn", row.problem));
    } else {
      const name = element("span", "mono", account?.address === row.address ? "you" : short(row.address!));
      name.title = row.address!;
      cell.append(name);
    }
    tr.append(element("td", "", String(row.line)), cell);
    tbody.append(tr);
  }
  if (rows.length > PREVIEW_ROWS) {
    const more = element("tr");
    const cell = element("td", "", `… and ${plural(rows.length - PREVIEW_ROWS, "more line")}`);
    cell.colSpan = 2;
    more.append(cell);
    tbody.append(more);
  }
  table.append(thead, tbody);
  const scroll = element("div", "scroll");
  scroll.append(table);
  previewEl.replaceChildren(facts, scroll);
}

/** Says in a sentence what creating the sale will do, and sets the button to match. */
function renderSummary() {
  const stop = blocker();
  const label = account ? "Put the tokens on sale" : "Connect a wallet to put tokens on sale";
  if (stop) {
    summaryEl.textContent = stop;
    createSubmit.textContent = label;
  } else {
    const t = terms();
    const cap = show(t.cap!, tokenUnit);
    const most = costOf({ price: t.price!, unit: tokenUnit }, t.cap!) ?? (t.cap! * t.price!) / scale(tokenUnit.decimals);
    const limit =
      t.perWallet === t.cap ? "There is no limit per wallet but the cap." : `Each wallet may buy up to ${show(t.perWallet!, tokenUnit)}.`;
    const audience = who === "list" ? `only the ${plural(rows.length, "account")} of the list` : "anyone";
    const opens = t.start === null ? "Buying opens as soon as the sale is created" : `Buying opens on ${formatDate(t.start)}`;
    summaryEl.textContent =
      `You put ${cap} into the contract, on sale to ${audience} at ${cspr(t.price!)} each: ${cspr(most)} if all of it sells. ` +
      `${limit} ${opens} and closes on ${formatDate(t.end)}. You can take out the CSPR at any time, and what is unsold after the close.`;
    createSubmit.textContent = account ? `Put ${cap} on sale` : label;
  }
  createSubmit.disabled = busy || !account || stop !== "";
  createHint.textContent = `Your wallet will ask twice: first to let the contract take the tokens, then to create the sale. The network takes up to ${fee(GAS.approve + GAS.create)} as a fee and refunds most of what is not used.`;
}

function refreshRows() {
  rows = who === "list" ? parseList(fList.value) : [];
  renderPreview(formTree());
  renderSummary();
}

function showCreateError(text: string) {
  createError.textContent = text;
  createError.hidden = !text;
}

/** Finds the number of the sale just created: the newest one of this creator. */
async function findSale(before: number[]): Promise<number | null> {
  const ids = await salesOf(account!.address);
  const fresh = ids.filter((id) => !before.includes(id));
  return fresh.length > 0 ? fresh[fresh.length - 1] : null;
}

async function createSale() {
  showCreateError("");
  refreshRows();
  if (!account || blocker()) return;

  // The terms as they are now: what the reader checked is what gets created.
  const t = terms();
  const cap = t.cap!;
  const tree = formTree();
  const list = rows.slice();
  const selling = token;
  const unit = tokenUnit;
  const what = show(cap, unit);
  // "Opens now" is the moment of signing: the block that runs the transaction comes later.
  const start = t.start ?? Date.now();

  await withBusy(async () => {
    const me = account!.address;
    if ((await balanceOf(selling, me)) < cap) return showCreateError(`You have less than ${what}.`);
    if ((await allowanceOf(selling, me, saleAddress)) < cap) {
      const approved = await send("Step 1 of 2, allowing the contract to take the tokens", GAS.approve, () =>
        tokenClient(selling).approve(address(saleAddress), U256.fromBigInt(cap)),
      );
      if (!approved) return;
    }
    const before = await salesOf(me);
    const created = await send(`Step 2 of 2, putting ${what} on sale`, GAS.create, () =>
      saleClient.createSale(
        address(selling),
        U512.fromBigInt(t.price!),
        U256.fromBigInt(cap),
        U256.fromBigInt(t.perWallet!),
        BigInt(start),
        BigInt(t.end),
        tree ? tree.root : new Uint8Array(),
      ),
    );
    if (!created) return;

    refreshState();
    const id = await findSale(before);
    showShare(id, tree ? list : null, what);
  });
}

/** Shows how to hand the sale to buyers, and opens it in the buy form. */
function showShare(id: number | null, list: Row[] | null, what: string) {
  const number = id === null ? "Your sale" : `Sale #${id}`;
  const text = list ? listText(list) : "";
  $("share-text").textContent = list
    ? `${number} of ${what} is created, for ${plural(list.length, "account")}. Send them the link or the list: the page works out each one's proof from it.`
    : `${number} of ${what} is created. Anyone with the link, or the number, can buy.`;

  const base = location.href.replace(/#.*$/, "");
  const fitsLink = !list || list.length <= MAX_LINK_ENTRIES;
  shareLink.value =
    id === null ? "" : `${base}#sale=${id}${list && fitsLink ? `&list=${toBase64Url(text)}` : ""}`;
  if (shareFile.href) URL.revokeObjectURL(shareFile.href);
  shareFile.hidden = !list;
  if (list) {
    shareFile.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    shareFile.download = id === null ? "sale-list.txt" : `sale-${id}-list.txt`;
  }
  shareBox.hidden = false;

  if (id !== null) {
    bSale.value = String(id);
    bList.value = text;
  }
}

// ---------- Balances ----------

async function refreshBalances() {
  $("step-connect").classList.toggle("done", account !== null);
  if (!account) {
    balanceEl.textContent = "—";
    $("step-faucet").classList.remove("done");
    available = null;
    return;
  }
  const me = account.address;
  try {
    const test = await balanceOf(testTokenHash, me);
    balanceEl.textContent = `${formatAmount(test, 9)} TEST`;
    $("step-faucet").classList.toggle("done", test > 0n);
    available = token === testTokenHash ? test : await balanceOf(token, me);
  } catch (error) {
    balanceEl.textContent = "?";
    available = null;
    console.error(error);
  }
}

function repaint() {
  connectBtn.disabled = busy;
  faucetBtn.disabled = busy || !account;
  renderSummary();
  paintBuyButton(buySubmit.textContent ?? "Buy");
}

async function refreshAll() {
  refreshState();
  repaint();
  await refreshBalances();
  refreshRows();
  await refreshBuy();
  await refreshList();
}

// ---------- Transactions ----------

function showTx(text: string, options: { hash?: string; error?: boolean } = {}) {
  txText.textContent = text;
  txBox.classList.toggle("error", options.error === true);
  if (options.hash) txLink.href = `${EXPLORER}/transaction/${options.hash}`;
  txLink.hidden = !options.hash;
  txBox.hidden = false;
}

function failureText(result: TransactionResult): string {
  if (result.errorCode !== undefined) {
    return ERRORS[result.errorCode] ?? `The contract reported error ${result.errorCode}.`;
  }
  return result.error ?? "The transaction failed.";
}

/** Sends one transaction and waits until it is processed. Returns whether it succeeded. */
async function send(label: string, gas: bigint, call: () => Promise<TransactionResult>): Promise<boolean> {
  showTx(`${label}: confirm it in your wallet…`);
  try {
    setGas(gas);
    const result = await call();
    if (result.isCancelled) {
      showTx(`${label}: you declined to sign.`, { error: true });
      return false;
    }
    if (result.error || result.errorCode !== undefined) {
      showTx(`${label} failed. ${failureText(result)}`, { hash: result.txHash, error: true });
      return false;
    }
    showTx(`${label}: done.`, { hash: result.txHash });
    return true;
  } catch (error) {
    showTx(`${label} failed. ${errorText(error)}`, { error: true });
    return false;
  }
}

/** Runs an action made of transactions with the buttons disabled, then reloads the state. */
async function withBusy(action: () => Promise<void>) {
  if (busy) return;
  busy = true;
  repaint();
  try {
    await action();
  } finally {
    busy = false;
    await refreshAll();
  }
}

const faucet = () =>
  withBusy(async () => {
    await send("Test tokens", GAS.faucet, () => tokenClient(testTokenHash).faucet());
  });

// ---------- Form helpers ----------

/** Takes the token typed in the form, or goes back to the test token when the field is empty. */
async function setToken() {
  const typed = fToken.value.trim();
  let next = testTokenHash;
  fTokenInfo.textContent = "";
  if (typed) {
    try {
      next = parseAddress(typed);
    } catch {
      fTokenInfo.textContent = "Not a contract address (hash-…).";
      return;
    }
  }
  const found = await readTokenUnit(next);
  if (fToken.value.trim() !== typed) return;
  token = next;
  tokenUnit = found;
  if (typed) fTokenInfo.textContent = `${found.symbol}, ${found.decimals} decimals`;
  for (const unit of document.querySelectorAll(".token-unit")) unit.textContent = found.symbol;
  available = null;
  await refreshBalances();
  refreshRows();
}

/** 100 TEST at 0.5 CSPR, 20 per wallet, for a week, to you and two made-up accounts. */
function fillExample() {
  const randomAccount = () =>
    "account-hash-" +
    [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  fToken.value = "";
  void setToken();
  fCap.value = "100";
  fPrice.value = "0.5";
  fPerWallet.value = "20";
  setStart("now");
  setEnd("1w");
  fList.value = [account?.address ?? randomAccount(), randomAccount(), randomAccount()].join("\n");
  setWho("list");
  showCreateError(account ? "" : "Connect a wallet first to put yourself on the list.");
  createForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** Fills in the buy form from a sale link: `#sale=<number>&list=<base64url of the list>`. */
function readLink() {
  const params = new URLSearchParams(location.hash.slice(1));
  const sale = params.get("sale");
  const list = params.get("list");
  if (sale === null) return;
  bSale.value = sale;
  if (list) {
    try {
      bList.value = fromBase64Url(list);
    } catch {
      showBuyError("The list in this link is damaged. Ask for the link again, or for the file.");
    }
  }
  buyForm.scrollIntoView({ block: "start" });
}

// ---------- Wallet ----------

async function onAccount(info: AccountInfo) {
  account = { publicKey: info.publicKey, address: key(info.address) };
  accountKey.textContent = short(info.publicKey);
  accountKey.title = info.publicKey;
  connectBtn.hidden = true;
  accountBox.hidden = false;
  await refreshAll();
}

async function onSignedOut() {
  account = null;
  connectBtn.hidden = false;
  accountBox.hidden = true;
  await refreshAll();
}

function loadCsprClick(): Promise<void> {
  return new Promise((resolve, reject) => {
    window.addEventListener("csprclick:loaded", () => resolve(), { once: true });
    const script = document.createElement("script");
    script.src = CSPR_CLICK_SCRIPT;
    script.onerror = () => reject(new Error("Could not load CSPR.click."));
    document.head.append(script);
  });
}

// ---------- Start ----------

async function run() {
  await Promise.all([init(), initStorage(RPC_URL)]);

  const contracts = new Contracts(deployedContracts);
  client = new OdraWasmClient(RPC_URL, SPECULATIVE_RPC_URL, CHAIN_NAME);
  saleAddress = key(contracts.get("TokenSale").address);
  saleClient = new TokenSaleWasmClient(client, address(saleAddress));
  testTokenHash = key(contracts.get("TestToken").address);
  token = testTokenHash;
  saleStorage = await ContractStorage.open(saleSchema, saleAddress);

  $("contract").textContent = `Token sale contract: ${saleAddress}.`;
  setStart("now");
  setEnd("1w");
  setWho("everyone");
  readLink();
  await refreshAll();

  CsprClickCallbacks.onSignedIn((info: AccountInfo) => void onAccount(info));
  CsprClickCallbacks.onSwitchedAccount((info: AccountInfo) => void onAccount(info));
  CsprClickCallbacks.onSignedOut(() => void onSignedOut());
  CsprClickCallbacks.onDisconnected(() => void onSignedOut());
  CsprClickCallbacks.onTransactionStatusUpdate((status: TransactionStatus, data: TransactionResult) => {
    if (status === TransactionStatus.SENT && data.txHash) {
      showTx("Sent. Waiting for the network to process it…", { hash: data.txHash });
    }
  });

  connectBtn.addEventListener("click", () => client.signIn().catch(console.error));
  $("switch").addEventListener("click", () => client.switchAccount().catch(console.error));
  $("disconnect").addEventListener("click", () => client.signOut().catch(console.error));
  faucetBtn.addEventListener("click", faucet);
  $("example").addEventListener("click", fillExample);

  buyForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void buy();
  });
  for (const input of [bSale, bList, bAmount]) {
    input.addEventListener("input", () => {
      showBuyError("");
      void refreshBuy();
    });
  }
  bMax.addEventListener("click", () => void buyMost());

  createForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void createSale();
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-start]")) {
    button.addEventListener("click", () => setStart(button.dataset.start!));
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-end]")) {
    button.addEventListener("click", () => setEnd(button.dataset.end!));
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-who]")) {
    button.addEventListener("click", () => setWho(button.dataset.who as "everyone" | "list"));
  }
  fStart.addEventListener("input", () => {
    mark("start", "");
    renderSummary();
  });
  fEnd.addEventListener("input", () => {
    mark("end", "");
    renderSummary();
  });
  for (const input of [fCap, fPrice, fPerWallet]) input.addEventListener("input", () => renderSummary());
  fToken.addEventListener("change", () => void setToken());
  fList.addEventListener("input", () => {
    showCreateError("");
    refreshRows();
  });
  $("share-copy").addEventListener("click", () => {
    navigator.clipboard
      .writeText(shareLink.value)
      .then(() => showTx("The sale link is copied."))
      .catch(() => shareLink.select());
  });

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
    button.addEventListener("click", () => selectTab(button.dataset.tab as Tab));
  }
  moreBtn.addEventListener("click", () => void showMore());

  window.addEventListener("hashchange", () => {
    readLink();
    void refreshBuy();
  });
  $("tx-close").addEventListener("click", () => (txBox.hidden = true));

  // Loaded last: the client listens for the events the script sends once it is ready.
  await loadCsprClick();
  connectBtn.disabled = false;
}

run().catch((error) => {
  console.error(error);
  fatalBox.textContent = `The app could not start: ${errorText(error)}`;
  fatalBox.hidden = false;
});
