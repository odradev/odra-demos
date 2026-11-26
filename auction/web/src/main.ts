import "../../../style/odra.css";
import "./style.css";
import init, {
  AccountInfo,
  Address,
  AuctionErrors,
  AuctionWasmClient,
  Contracts,
  CsprClickCallbacks,
  OdraWasmClient,
  setGas,
  TestNftErrors,
  TestNftWasmClient,
  TransactionResult,
  TransactionStatus,
  U256,
  U512,
} from "auction-wasm-client";
import auctionSchema from "../../resources/casper_contract_schemas/auction_schema.json";
import testNftSchema from "../../resources/casper_contract_schemas/test_nft_schema.json";
import deployedContracts from "./contracts.json";
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
/**
 * Payment limits of the transactions the app sends, in motes. Measured on CasperVM: mint 0.8 CSPR,
 * approve 0.3, create 2.1, a bid 1.2 (4.2 for an account's first bid), take back 2.8, settle 4.0.
 */
const GAS = {
  mint: 2_500_000_000n,
  approve: 2_500_000_000n,
  create: 3n * CSPR,
  bid: 6n * CSPR,
  withdraw: 4n * CSPR,
  settle: 5n * CSPR,
};

/** The rules of the contract (src/auction.rs), which the app follows to show what is allowed. */
const MIN_STEP_PERCENT = 5n;
const EXTENSION_MS = 5 * 60_000;
const MAX_DURATION_MS = 30 * 86_400_000;
/**
 * How long after the end the app offers to settle. The contract compares with the time of the block,
 * which trails the clock by a few seconds; a settle sent too early fails and costs its gas.
 */
const SETTLE_MARGIN_MS = 30_000;
/** How many auctions the "All" tab shows at first, and how many more each "Show older" adds. */
const PAGE = 10;
/** How often the open auctions are read again, so other people's bids show up. */
const POLL_MS = 30_000;

const ERRORS: Record<number, string> = {
  [AuctionErrors.ZeroMinBid]: "The lowest first bid must be above zero.",
  [AuctionErrors.EndNotInFuture]: "The end must be in the future.",
  [AuctionErrors.DurationTooLong]: "An auction can run for at most 30 days.",
  [AuctionErrors.NftNotReceived]: "The NFT contract did not hand the NFT over.",
  [AuctionErrors.AuctionNotFound]: "There is no auction with this number.",
  [AuctionErrors.AuctionEnded]: "The auction has ended; it takes no more bids.",
  [AuctionErrors.BidTooLow]: "Someone bid more in the meantime: the bid is no longer high enough.",
  [AuctionErrors.AuctionNotEnded]: "The auction has not ended yet. Try again in a minute.",
  [AuctionErrors.AlreadySettled]: "The auction has been settled already.",
  [AuctionErrors.NothingToWithdraw]: "There is nothing to take back.",
  [TestNftErrors.InvalidName]: "The name must have 1 to 40 characters.",
  [TestNftErrors.NotAnOwnerOrApproved]: "The NFT is not yours, or the contract may not take it.",
  [TestNftErrors.InvalidTokenId]: "There is no NFT with this id.",
};

// ---------- Types ----------

/** An auction as plain values, read from the contract. */
interface Lot {
  id: bigint;
  seller: string;
  nft: string;
  tokenId: bigint;
  minBid: bigint;
  start: number;
  end: number;
  highestBid: bigint;
  highestBidder: string | null;
  bids: number;
  settled: boolean;
  /** The name in the NFT's metadata. */
  name: string;
  /** What the connected account can take back. */
  pending: bigint;
}

/** A rendered auction: the element and the function that refreshes what changes with time. */
interface Card {
  element: HTMLElement;
  paint: () => void;
}

/** An NFT the connected account owns and can auction. */
interface Owned {
  nft: string;
  tokenId: bigint;
  name: string;
}

// ---------- State ----------

let client: OdraWasmClient;
let auction: AuctionWasmClient;
let auctionStorage: ContractStorage;
let auctionAddress: string;
let testNftHash: string;
let account: { publicKey: string; address: string } | null = null;
let tab: "all" | "bids" | "selling" = "all";
let shown = PAGE;
let busy = false;
let cards: Card[] = [];
let owned: Owned[] = [];
/** The NFT chosen in the form, as `nft:tokenId`. */
let chosen: string | null = null;
/** What the reader typed into the bid field of each auction, kept across reloads of the list. */
const bidDrafts = new Map<bigint, string>();
const nftStorages = new Map<string, Promise<ContractStorage>>();
const names = new Map<string, Promise<string>>();

// ---------- DOM ----------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const connectBtn = $<HTMLButtonElement>("connect");
const accountBox = $("account");
const accountKey = $("account-key");
const fatalBox = $("fatal");
const ownedEl = $("owned");
const mintForm = $<HTMLFormElement>("mint");
const mintName = $<HTMLInputElement>("mint-name");
const mintSubmit = $<HTMLButtonElement>("mint-submit");
const mintError = $("mint-error");
const createForm = $<HTMLFormElement>("create");
const createError = $("create-error");
const createSubmit = $<HTMLButtonElement>("create-submit");
const fNfts = $("f-nfts");
const fOther = $<HTMLDetailsElement>("f-other");
const fNft = $<HTMLInputElement>("f-nft");
const fTokenId = $<HTMLInputElement>("f-token-id");
const fMinBid = $<HTMLInputElement>("f-min-bid");
const fEnd = $<HTMLInputElement>("f-end");
const summaryEl = $("summary");
const auctionsEl = $("auctions");
const moreBtn = $<HTMLButtonElement>("more");
const txBox = $("tx");
const txText = $("tx-text");
const txLink = $<HTMLAnchorElement>("tx-link");

// ---------- Formatting ----------

const short = (value: string) => {
  const body = value.replace(/^(account-hash-|hash-)/, "");
  return body.length > 14 ? `${body.slice(0, 6)}…${body.slice(-6)}` : body;
};

const formatDate = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Formats motes as CSPR with up to 4 fraction digits, rounded down. */
function formatCspr(value: bigint): string {
  const whole = (value / CSPR).toLocaleString("en-US");
  const fraction = (value % CSPR).toString().padStart(CSPR_DECIMALS, "0").slice(0, 4).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Formats motes as CSPR with every digit, for a field the reader may send as it is. */
function exactCspr(value: bigint): string {
  const fraction = (value % CSPR).toString().padStart(CSPR_DECIMALS, "0").replace(/0+$/, "");
  return fraction ? `${value / CSPR}.${fraction}` : `${value / CSPR}`;
}

const cspr = (value: bigint) => `${formatCspr(value)} CSPR`;

/** Parses a decimal number of CSPR into motes; `null` if it is not a valid amount. */
function parseCspr(text: string): bigint | null {
  const match = /^(\d+)(?:[.,](\d+))?$/.exec(text.trim().replace(/[\s_]/g, ""));
  if (!match) return null;
  const fraction = match[2] ?? "";
  if (fraction.length > CSPR_DECIMALS) return null;
  return BigInt(match[1]) * CSPR + BigInt(fraction.padEnd(CSPR_DECIMALS, "0") || "0");
}

/** Time left as a countdown: `4:07` under an hour, `3h 12m` under a day, `2d 5h` beyond. */
function countdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function formatDuration(ms: number): string {
  const units: [number, string][] = [
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
  ];
  for (const [size, name] of units) {
    if (ms >= size) {
      const count = Math.round(ms / size);
      return `${count} ${name}${count === 1 ? "" : "s"}`;
    }
  }
  return "less than a minute";
}

/** The value of a `datetime-local` input for a moment, in the local time zone. */
function toInputValue(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * The formatted key of an address: `account-hash-…` or `hash-…`. `Address.value` prints another
 * form (`entity-account-…`, `contract-package-…`), which `new Address` does not read back.
 *
 * Addresses are kept as strings: a call of the client consumes the `Address`, `U256` and `U512`
 * objects passed to it, so each call gets fresh ones (`address(text)`).
 */
function key(parsed: Address): string {
  const value = parsed.value;
  const hex = value.slice(-64);
  return value.startsWith("contract-package-") || value.startsWith("hash-")
    ? `hash-${hex}`
    : `account-hash-${hex}`;
}

const address = (formatted: string) => new Address(formatted);

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : JSON.stringify(error);
}

// ---------- Reading the contracts ----------

// State is read from the node's storage (see storage.ts). The generated client is used only to
// send transactions.

/** The lowest bid the auction takes now. The same rule as the contract's `min_next_bid`. */
function minNextBid(lot: Lot): bigint {
  if (lot.highestBidder === null) return lot.minBid;
  const step = (lot.highestBid * MIN_STEP_PERCENT) / 100n;
  return lot.highestBid + (step > 0n ? step : 1n);
}

/**
 * The storage of an NFT contract. Every collection is read with the schema of `TestNft`: the
 * CEP-95 standard names the dictionaries an NFT contract keeps its owners and metadata in, so this
 * reads any CEP-95 contract that follows it.
 */
function nftStorage(nft: string): Promise<ContractStorage> {
  let storage = nftStorages.get(nft);
  if (!storage) {
    storage = ContractStorage.open(testNftSchema, nft);
    storage.catch(() => nftStorages.delete(nft));
    nftStorages.set(nft, storage);
  }
  return storage;
}

/** The owner of an NFT, as a formatted key; `null` if it has none or cannot be read. */
async function ownerOf(nft: string, tokenId: bigint): Promise<string | null> {
  const owner = await (await nftStorage(nft)).read("token.owners", [tokenId.toString()]);
  return owner === null || owner === "None" ? null : formattedKey(owner);
}

async function approvedFor(nft: string, tokenId: bigint): Promise<string | null> {
  const spender = await (await nftStorage(nft)).read("token.approvals", [tokenId.toString()]);
  return spender === null || spender === "None" ? null : formattedKey(spender);
}

/**
 * The `name` entry of an NFT's metadata, or `NFT #id` if it has none. A map is printed as
 * `key:value, key:value`; the test NFT has `name` only.
 */
function nftName(nft: string, tokenId: bigint): Promise<string> {
  const id = `${nft}:${tokenId}`;
  let name = names.get(id);
  if (!name) {
    name = (async () => {
      const fallback = `NFT #${tokenId}`;
      try {
        const metadata = await (await nftStorage(nft)).read("token.metadata", [tokenId.toString()]);
        if (!metadata) return fallback;
        const single = /^name:([\s\S]+)$/.exec(metadata);
        if (single && !/, \w+:/.test(single[1])) return single[1];
        const entry = metadata.split(", ").find((part) => part.startsWith("name:"));
        return entry ? entry.slice(5) : fallback;
      } catch {
        return fallback;
      }
    })();
    names.set(id, name);
  }
  return name;
}

const auctionsCount = async () => BigInt((await auctionStorage.read("count")) ?? "0");

/** The ids of the auctions listed for `account` in `by_seller` or `by_bidder`. */
async function auctionIds(field: "by_seller" | "by_bidder", owner: string): Promise<bigint[]> {
  const list = await auctionStorage.read(field, [owner]);
  return (list?.match(/\d+/g) ?? []).map(BigInt);
}

async function pendingOf(id: bigint, bidder: string): Promise<bigint> {
  return BigInt((await auctionStorage.read("pending_returns", [`${id}:${bidder}`])) ?? "0");
}

async function loadLot(id: bigint): Promise<Lot> {
  const stored = await auctionStorage.read("auctions", [id.toString()]);
  if (stored === null) throw new Error(`There is no auction ${id}.`);
  // A struct is printed as a JSON object whose values are all strings.
  const lot: Record<string, string> = JSON.parse(stored);
  const nft = formattedKey(lot.nft);
  const tokenId = BigInt(lot.token_id);
  const [name, pending] = await Promise.all([
    nftName(nft, tokenId),
    account ? pendingOf(id, account.address) : Promise.resolve(0n),
  ]);
  return {
    id,
    seller: formattedKey(lot.seller),
    nft,
    tokenId,
    minBid: BigInt(lot.min_bid),
    start: Number(lot.start),
    end: Number(lot.end),
    highestBid: BigInt(lot.highest_bid),
    highestBidder: lot.highest_bidder === "None" ? null : formattedKey(lot.highest_bidder),
    bids: Number(lot.bids),
    settled: lot.settled === "true",
    name,
    pending,
  };
}

// ---------- Rendering ----------

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

function fact(list: HTMLElement, name: string, value: string) {
  list.append(element("dt", "", name), element("dd", "mono", value));
}

/** `you` for the connected account, a shortened address for anyone else. */
const who = (formatted: string) => (account?.address === formatted ? "you" : short(formatted));

function status(lot: Lot, now: number): { text: string; tone: "" | "good" | "warn" } {
  if (lot.settled) {
    if (lot.highestBidder === null) return { text: "Not sold, the NFT went back", tone: "" };
    return {
      text: lot.highestBidder === account?.address ? "Won by you" : `Sold for ${cspr(lot.highestBid)}`,
      tone: "good",
    };
  }
  if (now >= lot.end) return { text: "Ended, waiting to be settled", tone: "warn" };
  if (lot.end - now < EXTENSION_MS) return { text: "Ending soon: a bid adds time", tone: "warn" };
  return { text: "Open", tone: "" };
}

function buildCard(lot: Lot): Card {
  const card = element("article", "item");
  const isTestNft = lot.nft === testNftHash;

  const head = element("div", "head");
  const heading = element("div");
  heading.append(
    element("div", "title", lot.name),
    element(
      "div",
      "from",
      `Auction #${lot.id} · ${isTestNft ? "TNFT" : short(lot.nft)} #${lot.tokenId} · sold by ${who(lot.seller)}`,
    ),
  );
  const chip = element("span", "chip");
  head.append(heading, chip);

  // Stat tiles of the Odra style: the figure first, its unit under it.
  const tiles = element("div", "tiles");
  const tile = (name: string) => {
    const box = element("div", "tile");
    const value = element("div", "value");
    const sub = element("div", "sub");
    box.append(element("div", "label", name), value, sub);
    tiles.append(box);
    return { value, sub };
  };
  const bidTile = tile(lot.highestBidder === null ? "Lowest first bid" : "Highest bid");
  bidTile.value.textContent = formatCspr(lot.highestBidder === null ? lot.minBid : lot.highestBid);
  bidTile.sub.textContent =
    lot.highestBidder === null ? "CSPR, no bids yet" : `CSPR, by ${who(lot.highestBidder)}`;
  const bidsTile = tile("Bids");
  bidsTile.value.textContent = lot.bids.toString();
  bidsTile.sub.textContent = lot.bids === 1 ? "bid" : "bids";
  const timeTile = tile("Time left");

  // The bar runs from the start to the end; a late bid moves the end, and the bar with it.
  const timeline = element("div", "timeline");
  const bar = element("div", "progress");
  const elapsed = element("div", "fill");
  bar.append(elapsed);
  const ticks = element("div", "ticks");
  const tick = (name: string, ms: number) => {
    const node = element("span", "", formatDate(ms));
    node.prepend(element("b", "", name));
    return node;
  };
  ticks.append(tick("Start", lot.start), tick("End", lot.end));
  timeline.append(bar, ticks);

  // Bidding: the field holds the lowest bid the contract takes, unless the reader typed more.
  const minNext = minNextBid(lot);
  const bidForm = element("form", "inline");
  const withUnit = element("span", "with-unit");
  const bidInput = element("input");
  bidInput.inputMode = "decimal";
  bidInput.setAttribute("aria-label", "Your bid in CSPR");
  const draft = bidDrafts.get(lot.id);
  const draftAmount = draft === undefined ? null : parseCspr(draft);
  bidInput.value = draft !== undefined && draftAmount !== null && draftAmount >= minNext ? draft : exactCspr(minNext);
  withUnit.append(bidInput, element("span", "unit", "CSPR"));
  const bidBtn = element("button", "primary");
  bidForm.append(withUnit, bidBtn);
  const bidHint = element(
    "p",
    "hint",
    lot.highestBidder === null
      ? `The first bid must be at least ${cspr(minNext)}.`
      : `At least ${cspr(minNext)}: 5% above the highest bid.`,
  );
  const bidBox = element("div", "bid");
  bidBox.append(bidForm, bidHint);
  bidInput.addEventListener("input", () => {
    bidDrafts.set(lot.id, bidInput.value);
    paint();
  });
  bidForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void bid(lot, bidInput.value);
  });

  const actions = element("div", "actions");
  const withdrawBtn = element("button", "", `Take back ${cspr(lot.pending)}`);
  withdrawBtn.addEventListener("click", () => withdraw(lot));
  const settleBtn = element("button", "primary");
  settleBtn.addEventListener("click", () => settle(lot));
  actions.append(settleBtn, withdrawBtn);

  const details = element("details");
  const facts = element("dl", "facts");
  fact(facts, "Seller", lot.seller);
  fact(facts, "NFT contract", lot.nft);
  fact(facts, "Token id", lot.tokenId.toString());
  fact(facts, "Lowest first bid", cspr(lot.minBid));
  if (lot.highestBidder) fact(facts, "Highest bidder", lot.highestBidder);
  fact(facts, "Started", formatDate(lot.start));
  fact(facts, "Ends", formatDate(lot.end));
  details.append(element("summary", "", "Details"), facts);

  card.append(head, tiles, timeline, bidBox, actions, details);

  const paint = () => {
    const now = Date.now();
    const open = !lot.settled && now < lot.end;
    const state = status(lot, now);
    chip.textContent = state.text;
    chip.className = `chip ${state.tone}`;

    timeTile.value.textContent = open ? countdown(lot.end - now) : "Ended";
    timeTile.sub.textContent = open ? `until ${formatDate(lot.end)}` : formatDate(lot.end);
    const span = lot.end - lot.start;
    elapsed.style.width = `${span <= 0 ? 100 : Math.min(100, ((now - lot.start) / span) * 100)}%`;

    bidBox.hidden = !open;
    const amount = parseCspr(bidInput.value);
    const valid = amount !== null && amount >= minNext;
    bidBtn.textContent = !account
      ? "Connect a wallet to bid"
      : valid
        ? `Bid ${cspr(amount)}`
        : `Bid at least ${cspr(minNext)}`;
    bidBtn.disabled = busy || !account || !valid;

    withdrawBtn.hidden = lot.pending === 0n;
    withdrawBtn.disabled = busy;

    settleBtn.hidden = open || lot.settled;
    const ready = now >= lot.end + SETTLE_MARGIN_MS;
    settleBtn.textContent = !ready
      ? "Settle: ready in a few seconds"
      : lot.highestBidder === null
        ? "Settle: send the NFT back to the seller"
        : `Settle: NFT to ${who(lot.highestBidder)}, ${cspr(lot.highestBid)} to ${who(lot.seller)}`;
    settleBtn.disabled = busy || !account || !ready;
    settleBtn.title = account ? "Anyone may settle; it costs the gas." : "Connect a wallet first";
    actions.hidden = withdrawBtn.hidden && settleBtn.hidden;
  };
  paint();
  return { element: card, paint };
}

let listVersion = 0;

/** The ids the current tab lists, newest first, and whether there are older ones to show. */
async function idsOfTab(): Promise<{ ids: bigint[]; more: boolean; empty: string }> {
  if (tab === "all") {
    const count = await auctionsCount();
    const ids: bigint[] = [];
    for (let id = count - 1n; id >= 0n && ids.length < shown; id--) ids.push(id);
    return { ids, more: count > BigInt(shown), empty: "No auction has been started yet." };
  }
  if (!account) return { ids: [], more: false, empty: "Connect a wallet to see your auctions." };
  if (tab === "bids") {
    const ids = (await auctionIds("by_bidder", account.address)).reverse();
    return { ids, more: false, empty: "You have not bid in any auction yet." };
  }
  const ids = (await auctionIds("by_seller", account.address)).reverse();
  return { ids, more: false, empty: "You have not put anything up for auction yet." };
}

async function refreshAuctions(quiet = false) {
  const version = ++listVersion;
  try {
    const { ids, more, empty } = await idsOfTab();
    if (version !== listVersion) return;
    if (ids.length === 0) {
      cards = [];
      auctionsEl.replaceChildren(element("p", "empty", empty));
      moreBtn.hidden = true;
      return;
    }
    if (!quiet) auctionsEl.replaceChildren(element("p", "empty", "Loading…"));
    // One auction after another: the node proxy is shared.
    const built: Card[] = [];
    for (const id of ids) {
      built.push(buildCard(await loadLot(id)));
      if (version !== listVersion) return;
    }
    // A reload while the reader types into a bid field would take the focus away: skip it.
    if (quiet && auctionsEl.contains(document.activeElement)) return;
    cards = built;
    auctionsEl.replaceChildren(...built.map((card) => card.element));
    moreBtn.hidden = !more;
  } catch (error) {
    if (version !== listVersion) return;
    cards = [];
    auctionsEl.replaceChildren(element("p", "notice", `Could not load: ${errorText(error)}`));
  }
}

/** The test NFTs the connected account owns: the ones it minted and the ones it won. */
async function refreshOwned() {
  $("step-connect").classList.toggle("done", account !== null);
  if (!account) {
    owned = [];
    ownedEl.textContent = "—";
    renderOwned();
    return;
  }
  const me = account.address;
  try {
    const minted = await (await nftStorage(testNftHash)).read("minted_by", [me]);
    const ids = new Set((minted?.match(/\d+/g) ?? []).map(BigInt));
    for (const id of await auctionIds("by_bidder", me)) {
      const lot = await loadLot(id);
      if (lot.settled && lot.highestBidder === me && lot.nft === testNftHash) ids.add(lot.tokenId);
    }
    const found: Owned[] = [];
    for (const tokenId of [...ids].sort((a, b) => (a < b ? -1 : 1))) {
      if ((await ownerOf(testNftHash, tokenId)) === me) {
        found.push({ nft: testNftHash, tokenId, name: await nftName(testNftHash, tokenId) });
      }
    }
    if (account?.address !== me) return;
    owned = found;
    ownedEl.textContent = `${found.length} TNFT`;
    $("step-mint").classList.toggle("done", ids.size > 0);
  } catch (error) {
    ownedEl.textContent = "?";
    console.error(error);
  }
  renderOwned();
}

const ownedKey = (item: { nft: string; tokenId: bigint }) => `${item.nft}:${item.tokenId}`;

function renderOwned() {
  if (!account) {
    fNfts.replaceChildren(element("span", "hint", "Connect a wallet to see your test NFTs."));
    return;
  }
  if (owned.length === 0) {
    fNfts.replaceChildren(element("span", "hint", "You own no test NFT yet. Mint one above."));
    chosen = null;
    return;
  }
  if (!owned.some((item) => ownedKey(item) === chosen)) chosen = ownedKey(owned[owned.length - 1]);
  fNfts.replaceChildren(
    ...owned.map((item) => {
      const button = element("button", "small", `#${item.tokenId} ${item.name}`);
      button.type = "button";
      button.classList.toggle("active", ownedKey(item) === chosen);
      button.addEventListener("click", () => {
        chosen = ownedKey(item);
        renderOwned();
        updateSummary();
      });
      return button;
    }),
  );
}

function repaint() {
  for (const card of cards) card.paint();
  connectBtn.disabled = busy;
  mintSubmit.disabled = busy || !account;
  mintSubmit.title = account ? "" : "Connect a wallet first";
  createSubmit.disabled = busy || !account;
  createSubmit.textContent = account ? "Put up for auction" : "Connect a wallet to start an auction";
}

async function refreshAll() {
  refreshState();
  repaint();
  await Promise.all([refreshOwned(), refreshAuctions()]);
  updateSummary();
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

async function hasCspr(amount: bigint, label: string): Promise<boolean> {
  const balance = await csprBalance(account!.address);
  if (balance >= amount) return true;
  showTx(`${label}: you have ${cspr(balance)}, and it needs ${cspr(amount)} with the gas.`, { error: true });
  return false;
}

async function bid(lot: Lot, text: string) {
  const amount = parseCspr(text);
  if (!account || amount === null || amount < minNextBid(lot)) return;
  await withBusy(async () => {
    const label = `Bid of ${cspr(amount)} in auction #${lot.id}`;
    if (!(await hasCspr(amount + GAS.bid, label))) return;
    const placed = await send(label, GAS.bid, () => auction.bid(lot.id, U512.fromBigInt(amount)));
    if (placed) {
      bidDrafts.delete(lot.id);
      $("step-sell").classList.add("done");
    }
  });
}

const withdraw = (lot: Lot) =>
  withBusy(async () => {
    await send(`Taking back ${cspr(lot.pending)} from auction #${lot.id}`, GAS.withdraw, () =>
      auction.withdraw(lot.id),
    );
  });

const settle = (lot: Lot) =>
  withBusy(async () => {
    await send(`Settling auction #${lot.id}`, GAS.settle, () => auction.settle(lot.id));
  });

function showError(box: HTMLElement, text: string) {
  box.textContent = text;
  box.hidden = !text;
}

async function mint() {
  showError(mintError, "");
  const name = mintName.value.trim();
  if (!account) return;
  if (name.length === 0 || [...name].length > 40) {
    return showError(mintError, "The name must have 1 to 40 characters.");
  }
  await withBusy(async () => {
    const minted = await send(`Minting "${name}"`, GAS.mint, () =>
      new TestNftWasmClient(client, address(testNftHash)).mint(name),
    );
    if (minted) {
      mintName.value = "";
      // The new NFT is the last one the account minted: choose it in the form.
      refreshState();
      const list = await (await nftStorage(testNftHash)).read("minted_by", [account!.address]);
      const last = list?.match(/\d+/g)?.pop();
      if (last !== undefined) chosen = `${testNftHash}:${last}`;
      $("step-mint").classList.add("done");
    }
  });
}

/** The NFT the form auctions: the one typed in under "another collection", or the chosen one. */
function formNft(): { nft: string; tokenId: bigint } | string {
  const typed = fNft.value.trim() || fTokenId.value.trim();
  if (typed) {
    let nft: string;
    try {
      nft = key(new Address(fNft.value.trim()));
    } catch {
      return "The NFT contract is not a contract address (hash-…).";
    }
    if (!nft.startsWith("hash-")) return "The NFT contract is not a contract address (hash-…).";
    if (!/^\d+$/.test(fTokenId.value.trim())) return "The token id must be a whole number.";
    return { nft, tokenId: BigInt(fTokenId.value.trim()) };
  }
  const item = owned.find((candidate) => ownedKey(candidate) === chosen);
  return item ?? "Choose an NFT, or mint one first.";
}

async function create() {
  showError(createError, "");
  if (!account) return;
  const choice = formNft();
  if (typeof choice === "string") return showError(createError, choice);
  const minBid = parseCspr(fMinBid.value);
  if (minBid === null || minBid === 0n) {
    return showError(createError, "The lowest first bid must be a number of CSPR above zero.");
  }
  const end = new Date(fEnd.value).getTime();
  if (Number.isNaN(end)) return showError(createError, "Fill in the end.");
  const now = Date.now();
  if (end <= now + 60_000) return showError(createError, "The end must be at least a minute away.");
  if (end - now > MAX_DURATION_MS) return showError(createError, "An auction can run for at most 30 days.");

  await withBusy(async () => {
    const me = account!.address;
    const { nft, tokenId } = choice;
    let owner: string | null;
    try {
      owner = await ownerOf(nft, tokenId);
    } catch {
      return showError(createError, "Could not read that NFT contract. Is it a CEP-95 collection?");
    }
    if (owner !== me) {
      return showError(createError, owner === null ? "There is no NFT with this id." : "That NFT is not yours.");
    }
    const nftClient = new TestNftWasmClient(client, address(nft));
    if ((await approvedFor(nft, tokenId)) !== auctionAddress) {
      const approved = await send("Step 1 of 2, allowing the contract to take the NFT", GAS.approve, () =>
        nftClient.approve(address(auctionAddress), U256.fromBigInt(tokenId)),
      );
      if (!approved) return;
    }
    const created = await send("Step 2 of 2, starting the auction", GAS.create, () =>
      auction.createAuction(address(nft), U256.fromBigInt(tokenId), U512.fromBigInt(minBid), BigInt(end)),
    );
    if (created) {
      fNft.value = "";
      fTokenId.value = "";
      $("step-sell").classList.add("done");
      setTab("selling");
    }
  });
}

// ---------- Form helpers ----------

function applyPreset(minutes: number) {
  fEnd.value = toInputValue(Date.now() + minutes * 60_000);
  markPreset(minutes.toString());
  updateSummary();
}

/** Highlights the preset the end was filled from; none once it is edited by hand. */
function markPreset(name: string | null) {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-preset]")) {
    button.classList.toggle("active", button.dataset.preset === name);
  }
}

/** Says in a sentence what the auction in the form will do. */
function updateSummary() {
  const choice = formNft();
  const minBid = parseCspr(fMinBid.value);
  const end = new Date(fEnd.value).getTime();
  const item = typeof choice === "string" ? undefined : owned.find((o) => ownedKey(o) === ownedKey(choice));
  const what = typeof choice === "string" ? "your NFT" : item ? `"${item.name}"` : `NFT #${choice.tokenId}`;

  let text: string;
  if (minBid === null || minBid === 0n) {
    text = "Enter the lowest first bid to see what happens.";
  } else if (Number.isNaN(end) || end <= Date.now()) {
    text = "Choose when the auction ends.";
  } else {
    text =
      `${what[0].toUpperCase()}${what.slice(1)} goes up for auction for ${formatDuration(end - Date.now())}, ` +
      `until ${formatDate(end)}. Bids start at ${cspr(minBid)}. At the end the highest bid comes to you ` +
      `and the NFT to its bidder; if nobody bids, the NFT comes back to you.`;
  }
  summaryEl.textContent = text;
}

function setTab(next: typeof tab) {
  tab = next;
  shown = PAGE;
  $("tab-all").classList.toggle("active", tab === "all");
  $("tab-bids").classList.toggle("active", tab === "bids");
  $("tab-selling").classList.toggle("active", tab === "selling");
  void refreshAuctions();
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
  auctionAddress = key(contracts.get("Auction").address);
  auction = new AuctionWasmClient(client, address(auctionAddress));
  auctionStorage = await ContractStorage.open(auctionSchema, auctionAddress);
  testNftHash = key(contracts.get("TestNft").address);

  $("contract").textContent = `Auction contract: ${auctionAddress}. Test NFT: ${testNftHash}.`;
  applyPreset(10);
  void refreshAll();

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
  mintForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void mint();
  });
  createForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void create();
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-preset]")) {
    button.addEventListener("click", () => applyPreset(Number(button.dataset.preset)));
  }
  fEnd.addEventListener("input", () => {
    markPreset(null);
    updateSummary();
  });
  for (const input of [fMinBid, fNft, fTokenId]) input.addEventListener("input", updateSummary);
  fOther.addEventListener("toggle", updateSummary);
  $("tab-all").addEventListener("click", () => setTab("all"));
  $("tab-bids").addEventListener("click", () => setTab("bids"));
  $("tab-selling").addEventListener("click", () => setTab("selling"));
  moreBtn.addEventListener("click", () => {
    shown += PAGE;
    void refreshAuctions();
  });
  $("tx-close").addEventListener("click", () => (txBox.hidden = true));

  // Countdowns tick from the local clock, without asking the node.
  setInterval(repaint, 1_000);
  // Other people's bids: read the list again now and then, while the page is in view.
  setInterval(() => {
    if (!busy && document.visibilityState === "visible") {
      refreshState();
      void refreshAuctions(true);
    }
  }, POLL_MS);

  // Loaded last: the client listens for the events the script sends once it is ready.
  await loadCsprClick();
  connectBtn.disabled = false;
}

run().catch((error) => {
  console.error(error);
  fatalBox.textContent = `The app could not start: ${errorText(error)}`;
  fatalBox.hidden = false;
});
