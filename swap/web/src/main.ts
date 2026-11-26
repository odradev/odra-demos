import "../../../style/odra.css";
import "./style.css";
import init, {
  AccountInfo,
  Address,
  Contracts,
  CsprClickCallbacks,
  OdraWasmClient,
  OtcSwapErrors,
  OtcSwapWasmClient,
  setGas,
  TestDollarWasmClient,
  TestTokenErrors,
  TestTokenWasmClient,
  TransactionResult,
  TransactionStatus,
  U256,
} from "otc-swap-wasm-client";
import swapSchema from "../../resources/casper_contract_schemas/otc_swap_schema.json";
import testTokenSchema from "../../resources/casper_contract_schemas/test_token_schema.json";
import deployedContracts from "./contracts.json";
import { ContractStorage, formattedKey, initStorage, refreshState } from "./storage";

// ---------- Configuration ----------

// A proxy of the Odra team: public nodes do not accept requests from a browser.
const RPC_URL = "https://testnet-rpc.odra.dev";
// The client wants a node for simulated calls too. The app makes none: it reads storage instead.
const SPECULATIVE_RPC_URL = "https://testnet-speculative-rpc.odra.dev";
const CHAIN_NAME = "casper-test";
const EXPLORER = "https://testnet.cspr.live";
const CSPR_CLICK_SCRIPT = "https://cdn.cspr.click/ui/v1.10.1/csprclick-client-1.10.1.js";

const CSPR = 1_000_000_000n;
/**
 * Payment limits of the transactions the app sends, in motes. Measured on CasperVM (see
 * `src/demo.rs`): `make_offer` consumed 2.0 to 2.2 CSPR, `take` 2.6 when another account takes
 * the offer, `cancel` 1.3, `approve` 0.36, `faucet` 0.3. 2.5 CSPR is the practical minimum of a
 * call; three quarters of what a limit leaves unused comes back.
 */
const GAS = {
  faucet: (5n * CSPR) / 2n,
  approve: (5n * CSPR) / 2n,
  make: 3n * CSPR,
  take: (7n * CSPR) / 2n,
  cancel: (5n * CSPR) / 2n,
};
/**
 * How far the app keeps from an expiry. The contract compares it with the time of the block that
 * runs the transaction; a clock that runs ahead of or behind the network would offer a take the
 * contract then refuses, and a failed transaction costs its whole limit.
 */
const CLOCK_MARGIN_MS = 15_000;
/** How many open public offers the list shows, newest first. */
const PUBLIC_SHOWN = 20;

const ERRORS: Record<number, string> = {
  [OtcSwapErrors.ZeroAmount]: "Both amounts must be greater than zero.",
  [OtcSwapErrors.SameToken]: "An offer must give one token and want another.",
  [OtcSwapErrors.ExpiryNotInFuture]: "The offer must stand until a moment in the future.",
  [OtcSwapErrors.OfferNotFound]: "There is no offer with this number.",
  [OtcSwapErrors.NotMaker]: "Only the maker of the offer can cancel it.",
  [OtcSwapErrors.NotTaker]: "This offer is for another account.",
  [OtcSwapErrors.OfferExpired]: "The offer has expired: it can no longer be taken.",
  [OtcSwapErrors.OfferClosed]: "The offer has been taken or cancelled already.",
  [TestTokenErrors.InsufficientBalance]: "The token balance is too low.",
  [TestTokenErrors.InsufficientAllowance]: "The token allowance is too low.",
  [TestTokenErrors.CannotTargetSelfUser]: "The token does not allow a transfer to yourself.",
};

// ---------- Types ----------

interface TokenMeta {
  symbol: string;
  decimals: number;
}

/** Where an offer stands, by the variant names of `OfferState` in the contract. */
type OfferState = "Open" | "Taken" | "Cancelled";

/** An offer as plain values, read once from the contract. */
interface Item {
  id: bigint;
  maker: string;
  giveToken: string;
  giveAmount: bigint;
  wantToken: string;
  wantAmount: bigint;
  /** The only account that may take it; `null` when anyone may. */
  taker: string | null;
  expiry: number;
  state: OfferState;
  takenBy: string | null;
  give: TokenMeta;
  want: TokenMeta;
}

/** A rendered offer: the element and the function that refreshes what changes with time. */
interface Card {
  element: HTMLElement;
  paint: () => void;
}

type Side = "give" | "want";
type Choice = "test" | "tusd" | "other";
type Tab = "maker" | "taker";

// ---------- State ----------

let client: OdraWasmClient;
let swap: OtcSwapWasmClient;
let swapStorage: ContractStorage;
let swapAddress: string;
let testHash: string;
let tusdHash: string;
let account: { publicKey: string; address: string } | null = null;
let tab: Tab = "maker";
let busy = false;
let cards: Card[] = [];
let viewCard: Card | null = null;
/** The offer the page's link points to (`#offer=3`), if any. */
let viewId: bigint | null = null;
const choice: Record<Side, Choice> = { give: "test", want: "tusd" };
/** The token of each side of the form, and its symbol and decimals. */
const formMeta: Record<Side, TokenMeta> = {
  give: { symbol: "TEST", decimals: 9 },
  want: { symbol: "TUSD", decimals: 6 },
};
let anyone = true;
const tokenMetas = new Map<string, Promise<TokenMeta>>();
const tokenStorages = new Map<string, Promise<ContractStorage>>();

// ---------- DOM ----------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const connectBtn = $<HTMLButtonElement>("connect");
const accountBox = $("account");
const accountKey = $("account-key");
const fatalBox = $("fatal");
const faucetTestBtn = $<HTMLButtonElement>("faucet-test");
const faucetTusdBtn = $<HTMLButtonElement>("faucet-tusd");
const makeForm = $<HTMLFormElement>("make");
const makeError = $("make-error");
const makeSubmit = $<HTMLButtonElement>("make-submit");
const fToken: Record<Side, HTMLInputElement> = {
  give: $<HTMLInputElement>("f-give-token"),
  want: $<HTMLInputElement>("f-want-token"),
};
const fAmount: Record<Side, HTMLInputElement> = {
  give: $<HTMLInputElement>("f-give-amount"),
  want: $<HTMLInputElement>("f-want-amount"),
};
const fTaker = $<HTMLInputElement>("f-taker");
const fExpiry = $<HTMLInputElement>("f-expiry");
const summaryEl = $("summary");
const shareCard = $("share");
const shareLink = $<HTMLInputElement>("share-link");
const viewSection = $("view");
const offersEl = $("offers");
const publicEl = $("public");
const lookupForm = $<HTMLFormElement>("lookup");
const lookupId = $<HTMLInputElement>("lookup-id");
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

/**
 * Formats an amount of the smallest unit as a decimal number. An offer shows every digit, so the
 * reader sees exactly what changes hands; a balance shows up to `maxFraction` of them.
 */
function formatAmount(value: bigint, decimals: number, maxFraction = decimals): string {
  const base = 10n ** BigInt(decimals);
  const whole = (value / base).toLocaleString("en-US");
  const fraction = (value % base)
    .toString()
    .padStart(decimals, "0")
    .slice(0, maxFraction)
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Parses a decimal number into the smallest unit; `null` if it is not a valid amount. */
function parseAmount(text: string, decimals: number): bigint | null {
  const match = /^(\d+)(?:[.,](\d+))?$/.exec(text.trim().replace(/[\s_]/g, ""));
  if (!match) return null;
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) return null;
  return BigInt(match[1]) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

const UNITS: [number, string][] = [
  [365 * 86_400_000, "year"],
  [30 * 86_400_000, "month"],
  [86_400_000, "day"],
  [3_600_000, "hour"],
  [60_000, "minute"],
];

function formatDuration(ms: number): string {
  for (const [size, name] of UNITS) {
    if (ms >= size) {
      const count = Math.floor(ms / size);
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
 * Reads an address from a public key (`01…`, `02…`) or a formatted key (`account-hash-…`,
 * `hash-…`) and returns it as a formatted key. Throws if the text is neither.
 *
 * Addresses are kept as strings: a call of the client consumes the `Address` and `U256` objects
 * passed to it, so each call gets fresh ones (`address(text)`).
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

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : JSON.stringify(error);
}

/** The link that opens an offer on this page. */
const offerLink = (id: bigint) => `${location.origin}${location.pathname}#offer=${id}`;

// ---------- Reading the contracts ----------

// State is read from the node's storage (see storage.ts). The generated client is used only to
// send transactions.

/**
 * The storage of a token. Every token is read with the schema of `TestToken`, which keeps the
 * state of Odra's `Cep18` module in a field called `token`, as `TestDollar` does; a token laid
 * out differently fails to read.
 */
function tokenStorage(token: string): Promise<ContractStorage> {
  let storage = tokenStorages.get(token);
  if (!storage) {
    storage = ContractStorage.open(testTokenSchema, token);
    storage.catch(() => tokenStorages.delete(token));
    tokenStorages.set(token, storage);
  }
  return storage;
}

/** The symbol and decimals of a token. A token that cannot be read is shown in raw units. */
function tokenMeta(token: string): Promise<TokenMeta> {
  let meta = tokenMetas.get(token);
  if (!meta) {
    meta = (async () => {
      try {
        const storage = await tokenStorage(token);
        const symbol = await storage.read("token.symbol");
        const decimals = await storage.read("token.decimals");
        if (symbol === null || decimals === null) throw new Error("Not a CEP-18 token.");
        return { symbol, decimals: Number(decimals) };
      } catch {
        return { symbol: short(token), decimals: 0 };
      }
    })();
    tokenMetas.set(token, meta);
  }
  return meta;
}

/** A token amount stored under `keys`; an amount that was never written is zero. */
async function tokenAmount(token: string, path: string, keys: string[]): Promise<bigint> {
  return BigInt((await (await tokenStorage(token)).read(path, keys)) ?? "0");
}

const balanceOf = (token: string, owner: string) => tokenAmount(token, "token.balances", [owner]);

const allowanceOf = (token: string, owner: string, spender: string) =>
  tokenAmount(token, "token.allowances", [`${owner}:${spender}`]);

const offersCount = async () => BigInt((await swapStorage.read("count")) ?? "0");

/** A list of ids as odra-cli prints it, `[0,3,5]`; a list that was never written is empty. */
const ids = (list: string | null) => (list?.match(/\d+/g) ?? []).map(BigInt);

/** The ids of the offers `account` made, or that were made for it and that it took. */
async function offerIds(which: Tab, owner: string): Promise<bigint[]> {
  return ids(await swapStorage.read(`by_${which}`, [owner]));
}

const openPublicIds = async () => ids(await swapStorage.read("open_public"));

/** An `Option<Address>` as odra-cli prints it: `None`, or the key. */
const optionalKey = (printed: string) => (printed === "None" ? null : formattedKey(printed));

async function loadItem(id: bigint): Promise<Item> {
  const stored = await swapStorage.read("offers", [id.toString()]);
  if (stored === null) throw new Error(`There is no offer ${id}.`);
  // A struct is printed as a JSON object whose values are all strings; an enum by its variant name.
  const offer: Record<string, string> = JSON.parse(stored);
  const giveToken = formattedKey(offer.give_token);
  const wantToken = formattedKey(offer.want_token);
  const [give, want] = await Promise.all([tokenMeta(giveToken), tokenMeta(wantToken)]);
  return {
    id,
    maker: formattedKey(offer.maker),
    giveToken,
    giveAmount: BigInt(offer.give_amount),
    wantToken,
    wantAmount: BigInt(offer.want_amount),
    taker: optionalKey(offer.taker),
    expiry: Number(offer.expiry),
    state: offer.state as OfferState,
    takenBy: optionalKey(offer.taken_by),
    give,
    want,
  };
}

const giveText = (item: Item) => `${formatAmount(item.giveAmount, item.give.decimals)} ${item.give.symbol}`;
const wantText = (item: Item) => `${formatAmount(item.wantAmount, item.want.decimals)} ${item.want.symbol}`;

/** Whether the offer can still be taken, by the local clock and with the margin. */
const takeable = (item: Item, now = Date.now()) =>
  item.state === "Open" && now < item.expiry - CLOCK_MARGIN_MS;

/** Whether the connected account may take the offer: it is public or made for this account. */
const mayTake = (item: Item) => account !== null && (item.taker === null || item.taker === account.address);

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

function fact(list: HTMLElement, name: string, value: string, mono = true) {
  const dd = element("dd", mono ? "mono" : "", value);
  list.append(element("dt", "", name), dd);
  return dd;
}

/** `you` for the connected account, a shortened address for anyone else. */
const who = (formatted: string) => (account?.address === formatted ? "you" : short(formatted));

function status(item: Item, now = Date.now()): { text: string; tone: "" | "good" | "warn" } {
  switch (item.state) {
    case "Open":
      return now < item.expiry
        ? { text: `Open, ${formatDuration(item.expiry - now)} left`, tone: "" }
        : { text: "Expired, not taken", tone: "warn" };
    case "Taken":
      return { text: `Taken by ${who(item.takenBy ?? "")}`, tone: "good" };
    case "Cancelled":
      return { text: "Cancelled by the maker", tone: "" };
  }
}

function expiryText(item: Item, now = Date.now()): string {
  return now < item.expiry
    ? `${formatDate(item.expiry)}, in ${formatDuration(item.expiry - now)}`
    : `${formatDate(item.expiry)}, passed`;
}

function detailsOf(item: Item): HTMLDetailsElement {
  const facts = element("dl", "facts");
  fact(facts, "Maker", item.maker);
  fact(facts, "May be taken by", item.taker ?? "Anyone", item.taker !== null);
  fact(facts, `${item.give.symbol} token`, item.giveToken);
  fact(facts, `${item.want.symbol} token`, item.wantToken);
  fact(facts, "Expires", formatDate(item.expiry), false);
  if (item.takenBy) fact(facts, "Taken by", item.takenBy);
  const details = element("details");
  details.append(element("summary", "", "Details"), facts);
  return details;
}

function copyLink(id: bigint) {
  navigator.clipboard
    .writeText(offerLink(id))
    .then(() => showTx(`The link to offer #${id} is copied.`))
    .catch(() => showTx(offerLink(id)));
}

/** An offer in a list: the trade first, its state in a chip, the buttons the account may use. */
function buildCard(item: Item): Card {
  const me = account?.address;
  const card = element("article", "item");

  const head = element("div", "head");
  const heading = element("div");
  const audience = item.taker === null ? "open to anyone" : `only for ${who(item.taker)}`;
  heading.append(
    element("div", "title", `${giveText(item)} for ${wantText(item)}`),
    element("div", "from", `Offer #${item.id} · by ${who(item.maker)}, ${audience}`),
  );
  const chip = element("span", "chip");
  head.append(heading, chip);

  // Every action pays out at once, so none of them is the primary button of the page.
  const actions = element("div", "actions");
  const buttons: HTMLButtonElement[] = [];
  let open: HTMLAnchorElement | null = null;
  if (item.state === "Open" && me === item.maker) {
    const cancelBtn = element("button", "", `Cancel and take back ${giveText(item)}`);
    cancelBtn.addEventListener("click", () => cancel(item));
    const copyBtn = element("button", "", "Copy the link");
    copyBtn.addEventListener("click", () => copyLink(item.id));
    buttons.push(cancelBtn);
    actions.append(cancelBtn, copyBtn);
  }
  if (item.state === "Open" && me !== item.maker && (item.taker === null || item.taker === me)) {
    open = element("a", "button", `See the offer: get ${giveText(item)} for ${wantText(item)}`);
    open.href = `#offer=${item.id}`;
    actions.append(open);
  }

  card.append(head);
  if (actions.children.length > 0) card.append(actions);
  card.append(detailsOf(item));

  function paint() {
    const state = status(item);
    chip.textContent = state.text;
    chip.className = `chip ${state.tone}`;
    for (const node of buttons) node.disabled = busy;
    if (open) open.hidden = !takeable(item);
    actions.hidden = [...actions.children].every((node) => (node as HTMLElement).hidden);
  }
  paint();
  return { element: card, paint };
}

/**
 * The offer a link opens, from the side of whoever opened it: what they give and what they get,
 * as two figures, and the one button that takes it.
 */
function buildView(item: Item): Card {
  const me = account?.address ?? null;
  const isMaker = me === item.maker;
  const body = element("div", "body");

  // The taker gives what the maker wants and gets what the maker gives; the maker the other way.
  const [youGive, youGet]: [bigint, TokenMeta][] = isMaker
    ? [
        [item.giveAmount, item.give],
        [item.wantAmount, item.want],
      ]
    : [
        [item.wantAmount, item.want],
        [item.giveAmount, item.give],
      ];
  const tile = (label: string, [amount, meta]: [bigint, TokenMeta]) => {
    const node = element("div", "tile");
    node.append(
      element("div", "label", label),
      element("div", "value", formatAmount(amount, meta.decimals)),
      element("div", "sub", meta.symbol),
    );
    return node;
  };
  const tiles = element("div", "tiles");
  tiles.append(tile("You give", youGive), tile("You get", youGet));
  body.append(tiles);

  const callout = element("div", "callout");
  const calloutText = element("p");
  callout.append(element("div", "label", "What will happen"), calloutText);
  const notice = element("p", "notice");
  const error = element("p", "notice");
  error.hidden = true;
  const actions = element("div", "actions");
  const hint = element("p", "hint");

  const takeBtn = element("button", "primary big");
  takeBtn.addEventListener("click", () => take(item, error));
  let cancelBtn: HTMLButtonElement | null = null;
  if (isMaker) {
    cancelBtn = element("button", "", `Cancel and take back ${giveText(item)}`);
    cancelBtn.addEventListener("click", () => cancel(item));
  }
  const copyBtn = element("button", "", "Copy the link");
  copyBtn.addEventListener("click", () => copyLink(item.id));
  actions.append(takeBtn);
  if (cancelBtn) actions.append(cancelBtn);
  actions.append(copyBtn);
  body.append(callout, notice, error, actions, hint, detailsOf(item));

  const title = $("view-title");
  const chip = $("view-chip");
  const asof = $("view-asof");
  title.textContent = isMaker ? `Your offer #${item.id}` : `Offer #${item.id}`;

  function paint() {
    const now = Date.now();
    const state = status(item, now);
    chip.textContent = state.text;
    chip.className = `chip ${state.tone}`;
    const audience = item.taker === null ? "anyone with this link may take it" : `only ${who(item.taker)} may take it`;
    asof.textContent =
      item.state === "Open"
        ? `Made by ${who(item.maker)}; ${audience}. Stands until ${expiryText(item, now)}.`
        : `Made by ${who(item.maker)}.`;

    const canTake = takeable(item, now);
    let blocked = "";
    if (item.state === "Taken") {
      blocked = `Taken by ${who(item.takenBy ?? "")}: ${giveText(item)} went to the taker and ${wantText(item)} to the maker.`;
    } else if (item.state === "Cancelled") {
      blocked = `The maker cancelled this offer and took back ${giveText(item)}.`;
    } else if (!canTake) {
      blocked = isMaker
        ? `It expired ${formatDate(item.expiry)}. Nobody can take it now; cancel it to get your ${item.give.symbol} back.`
        : `It expired ${formatDate(item.expiry)}. Nobody can take it now.`;
    } else if (account && !mayTake(item)) {
      blocked = `This offer is only for ${item.taker}. Switch to that account in your wallet to take it.`;
    }
    notice.textContent = blocked;
    notice.hidden = !blocked;
    callout.hidden = Boolean(blocked);

    if (isMaker) {
      calloutText.textContent =
        `You made this offer, so taking it yourself pays you no ${item.want.symbol}: you only get your ` +
        `${giveText(item)} back, as a cancel does. Send the link to someone else, or switch accounts in ` +
        `your wallet, to see the whole swap.`;
      takeBtn.textContent = `Take it yourself: get your ${giveText(item)} back`;
      hint.textContent = "Your wallet will ask once.";
    } else {
      calloutText.textContent =
        `In one transaction ${wantText(item)} go from your wallet to the maker and ${giveText(item)} go ` +
        `from the contract to you. If either part fails, nothing moves.`;
      takeBtn.textContent = account
        ? `Give ${wantText(item)}, get ${giveText(item)}`
        : "Connect a wallet to take this offer";
      hint.textContent = account
        ? `Your wallet may ask twice: first to let the contract take your ${item.want.symbol}, then to swap.`
        : "";
    }
    takeBtn.hidden = Boolean(blocked);
    takeBtn.disabled = busy || !account;
    if (cancelBtn) {
      cancelBtn.hidden = item.state !== "Open";
      cancelBtn.disabled = busy;
    }
    copyBtn.hidden = item.state !== "Open" || !canTake;
    hint.hidden = takeBtn.hidden || !hint.textContent;
    actions.hidden = [...actions.children].every((node) => (node as HTMLElement).hidden);
  }
  paint();
  return { element: body, paint };
}

let viewVersion = 0;

/** Shows the offer the link points to, or hides the card when the link names none. */
async function refreshView() {
  const version = ++viewVersion;
  const body = $("view-body");
  if (viewId === null) {
    viewCard = null;
    viewSection.hidden = true;
    return;
  }
  viewSection.hidden = false;
  try {
    const count = await offersCount();
    if (version !== viewVersion) return;
    if (viewId >= count) {
      viewCard = null;
      $("view-title").textContent = `Offer #${viewId}`;
      $("view-chip").textContent = "";
      $("view-chip").className = "";
      $("view-asof").textContent = "";
      body.replaceChildren(
        element(
          "p",
          "empty",
          count === 0n ? "No offer has been made yet." : `There is no such offer. Numbers run from 0 to ${count - 1n}.`,
        ),
      );
      return;
    }
    const item = await loadItem(viewId);
    if (version !== viewVersion) return;
    viewCard = buildView(item);
    body.replaceChildren(viewCard.element);
  } catch (error) {
    if (version !== viewVersion) return;
    viewCard = null;
    body.replaceChildren(element("p", "notice", `Could not load: ${errorText(error)}`));
  }
}

async function renderList(target: HTMLElement, list: bigint[], emptyText: string): Promise<Card[]> {
  if (list.length === 0) {
    target.replaceChildren(element("p", "empty", emptyText));
    return [];
  }
  target.replaceChildren(element("p", "empty", "Loading…"));
  // Newest first. One read per offer, one after another: the node proxy is shared.
  const built: Card[] = [];
  for (const id of [...list].reverse()) {
    built.push(buildCard(await loadItem(id)));
  }
  target.replaceChildren(...built.map((card) => card.element));
  return built;
}

const EMPTY: Record<Tab, string> = {
  maker: "You have not made an offer yet.",
  taker: "Nobody has made an offer for you yet, and you have not taken a public one.",
};

let listVersion = 0;
let publicCards: Card[] = [];

async function refreshOffers() {
  const version = ++listVersion;
  if (!account) {
    cards = [];
    offersEl.replaceChildren(element("p", "empty", "Connect a wallet to see your offers."));
    return;
  }
  try {
    const list = await offerIds(tab, account.address);
    if (version !== listVersion) return;
    const built = await renderList(offersEl, list, EMPTY[tab]);
    if (version === listVersion) cards = built;
  } catch (error) {
    if (version !== listVersion) return;
    cards = [];
    offersEl.replaceChildren(element("p", "notice", `Could not load: ${errorText(error)}`));
  }
}

let publicVersion = 0;

/** The public offers still open, without the expired ones the list keeps until they are cancelled. */
async function refreshPublic() {
  const version = ++publicVersion;
  try {
    const list = await openPublicIds();
    const items: Item[] = [];
    for (const id of [...list].reverse()) {
      if (items.length >= PUBLIC_SHOWN) break;
      const item = await loadItem(id);
      if (takeable(item)) items.push(item);
    }
    if (version !== publicVersion) return;
    publicCards = items.map(buildCard);
    publicEl.replaceChildren(
      ...(publicCards.length
        ? publicCards.map((card) => card.element)
        : [element("p", "empty", "No public offer is open right now. Make one, or open one by its number.")]),
    );
  } catch (error) {
    if (version !== publicVersion) return;
    publicCards = [];
    publicEl.replaceChildren(element("p", "notice", `Could not load: ${errorText(error)}`));
  }
}

async function refreshBalances() {
  $("step-connect").classList.toggle("done", account !== null);
  if (!account) {
    $("balance-test").textContent = "—";
    $("balance-tusd").textContent = "—";
    $("step-faucet").classList.remove("done");
    return;
  }
  try {
    const [test, tusd] = await Promise.all([
      balanceOf(testHash, account.address),
      balanceOf(tusdHash, account.address),
    ]);
    $("balance-test").textContent = `${formatAmount(test, 9, 4)} TEST`;
    $("balance-tusd").textContent = `${formatAmount(tusd, 6, 2)} TUSD`;
    $("step-faucet").classList.toggle("done", test > 0n && tusd > 0n);
  } catch (error) {
    $("balance-test").textContent = "?";
    $("balance-tusd").textContent = "?";
    console.error(error);
  }
}

function repaint() {
  for (const card of cards) card.paint();
  for (const card of publicCards) card.paint();
  viewCard?.paint();
  connectBtn.disabled = busy;
  faucetTestBtn.disabled = busy || !account;
  faucetTusdBtn.disabled = busy || !account;
  updateSubmit();
}

async function refreshAll() {
  refreshState();
  repaint();
  await Promise.all([refreshBalances(), refreshView(), refreshOffers(), refreshPublic()]);
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

/** Approves the swap contract for `amount` of `token` unless the allowance covers it already. */
async function ensureAllowance(token: string, amount: bigint, label: string): Promise<boolean> {
  const allowance = await allowanceOf(token, account!.address, swapAddress);
  if (allowance >= amount) return true;
  // Both test tokens and any token built on Odra's Cep18 take the same `approve`.
  const cep18 = new TestTokenWasmClient(client, address(token));
  return send(label, GAS.approve, () => cep18.approve(address(swapAddress), U256.fromBigInt(amount)));
}

const faucetTest = () =>
  withBusy(async () => {
    await send("Test tokens", GAS.faucet, () => new TestTokenWasmClient(client, address(testHash)).faucet());
  });

const faucetTusd = () =>
  withBusy(async () => {
    await send("Test dollars", GAS.faucet, () => new TestDollarWasmClient(client, address(tusdHash)).faucet());
  });

const cancel = (item: Item) =>
  withBusy(async () => {
    await send(`Cancelling offer #${item.id}`, GAS.cancel, () => swap.cancel(item.id));
  });

function take(item: Item, errorBox: HTMLElement) {
  const fail = (text: string) => {
    errorBox.textContent = text;
    errorBox.hidden = false;
  };
  errorBox.hidden = true;
  if (!account) return;
  return withBusy(async () => {
    const me = account!.address;
    // A maker taking its own offer pays nothing: the contract moves no wanted tokens.
    if (me !== item.maker) {
      const balance = await balanceOf(item.wantToken, me);
      if (balance < item.wantAmount) {
        return fail(
          `You have ${formatAmount(balance, item.want.decimals)} ${item.want.symbol}; the offer wants ${wantText(item)}.`,
        );
      }
      const approved = await ensureAllowance(
        item.wantToken,
        item.wantAmount,
        `Step 1 of 2, allowing the contract to take ${wantText(item)}`,
      );
      if (!approved) return;
    }
    const label = me === item.maker ? `Taking offer #${item.id}` : "Step 2 of 2, swapping";
    await send(label, GAS.take, () => swap.take(item.id));
  });
}

function showMakeError(text: string) {
  makeError.textContent = text;
  makeError.hidden = !text;
}

/** The token address chosen for a side of the form; throws if "another token" holds no address. */
function formToken(side: Side): string {
  switch (choice[side]) {
    case "test":
      return testHash;
    case "tusd":
      return tusdHash;
    case "other":
      return parseAddress(fToken[side].value);
  }
}

async function make() {
  showMakeError("");
  if (!account) return;

  const tokens: Partial<Record<Side, string>> = {};
  for (const side of ["give", "want"] as Side[]) {
    try {
      tokens[side] = formToken(side);
    } catch {
      return showMakeError(`The token you ${side} is not a contract address (hash-…).`);
    }
  }
  const giveToken = tokens.give!;
  const wantToken = tokens.want!;
  if (giveToken === wantToken) return showMakeError("Give one token and want another.");
  const [give, want] = await Promise.all([tokenMeta(giveToken), tokenMeta(wantToken)]);
  const giveAmount = parseAmount(fAmount.give.value, give.decimals);
  const wantAmount = parseAmount(fAmount.want.value, want.decimals);
  if (giveAmount === null || giveAmount === 0n) {
    return showMakeError(`What you give must be a number above zero with up to ${give.decimals} decimals.`);
  }
  if (wantAmount === null || wantAmount === 0n) {
    return showMakeError(`What you want must be a number above zero with up to ${want.decimals} decimals.`);
  }
  let taker: string | null = null;
  if (!anyone) {
    try {
      taker = parseAddress(fTaker.value);
    } catch {
      return showMakeError("The account that may take it is not a public key or an account hash.");
    }
  }
  const expiry = formExpiry();
  if (Number.isNaN(expiry)) return showMakeError("Fill in until when the offer stands.");
  if (expiry <= Date.now() + CLOCK_MARGIN_MS) return showMakeError("The offer must stand until a moment in the future.");

  await withBusy(async () => {
    const me = account!.address;
    const balance = await balanceOf(giveToken, me);
    if (balance < giveAmount) {
      return showMakeError(
        `You have ${formatAmount(balance, give.decimals)} ${give.symbol}, less than you offer to give.`,
      );
    }
    const show = (value: bigint, meta: TokenMeta) => `${formatAmount(value, meta.decimals)} ${meta.symbol}`;
    const approved = await ensureAllowance(
      giveToken,
      giveAmount,
      `Step 1 of 2, allowing the contract to take ${show(giveAmount, give)}`,
    );
    if (!approved) return;
    const made = await send("Step 2 of 2, making the offer", GAS.make, () =>
      swap.makeOffer(
        address(giveToken),
        U256.fromBigInt(giveAmount),
        address(wantToken),
        U256.fromBigInt(wantAmount),
        taker === null ? undefined : address(taker),
        BigInt(expiry),
      ),
    );
    if (!made) return;
    // The id of the new offer: the last one this account made. Its own transactions run one
    // after another, so no other offer of this account can come after it.
    refreshState();
    const mine = await offerIds("maker", me);
    const id = mine.at(-1);
    if (id !== undefined) {
      showShare(id, `${show(giveAmount, give)} for ${show(wantAmount, want)}`, taker);
    }
    fAmount.give.value = "";
    fAmount.want.value = "";
    updateSummary();
    $("step-make").classList.add("done");
    setTab("maker");
  });
}

function showShare(id: bigint, trade: string, taker: string | null) {
  const link = offerLink(id);
  shareLink.value = link;
  $<HTMLAnchorElement>("share-open").href = `#offer=${id}`;
  $("share-text").textContent =
    taker === null
      ? `Offer #${id}, ${trade}, is open. Anyone who opens this link can take it.`
      : `Offer #${id}, ${trade}, is open for ${short(taker)} only. Send them this link.`;
  shareCard.hidden = false;
}

// ---------- Form helpers ----------

const PRESETS: Record<string, number> = {
  "10m": 10 * 60_000,
  "1h": 3_600_000,
  "1d": 86_400_000,
  "7d": 7 * 86_400_000,
};

const formExpiry = () => new Date(fExpiry.value).getTime();

function applyPreset(name: string) {
  fExpiry.value = toInputValue(Date.now() + PRESETS[name]);
  markPreset(name);
  updateSummary();
}

/** Highlights the preset the expiry was filled from; none once it is edited by hand. */
function markPreset(name: string | null) {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-preset]")) {
    button.classList.toggle("active", button.dataset.preset === name);
  }
}

const other = (side: Side): Side => (side === "give" ? "want" : "give");

/** Picks the token of one side. Picking the token of the other side swaps the two. */
function pick(side: Side, next: Choice) {
  if (next !== "other" && choice[other(side)] === next) {
    choice[other(side)] = choice[side] === "other" ? (next === "test" ? "tusd" : "test") : choice[side];
  }
  choice[side] = next;
  for (const s of ["give", "want"] as Side[]) {
    for (const button of document.querySelectorAll<HTMLButtonElement>(`[data-side="${s}"] [data-token]`)) {
      button.classList.toggle("active", button.dataset.token === choice[s]);
    }
    fToken[s].hidden = choice[s] !== "other";
    void describeToken(s);
  }
}

/** Reads the symbol and decimals of a side's token, for its unit and the summary. */
async function describeToken(side: Side) {
  const hint = $(`f-${side}-hint`);
  let token: string;
  try {
    token = formToken(side);
  } catch {
    hint.textContent = choice[side] === "other" ? "Paste the contract address of a CEP-18 token." : "";
    return;
  }
  const meta = await tokenMeta(token);
  let current: string | null = null;
  try {
    current = formToken(side);
  } catch {
    // The field changed meanwhile; the newer call fills it in.
  }
  if (current !== token) return;
  formMeta[side] = meta;
  hint.textContent = choice[side] === "other" ? `${meta.symbol}, ${meta.decimals} decimals` : "";
  $(`f-${side}-unit`).textContent = meta.symbol;
  updateSummary();
}

function setAudience(toAnyone: boolean) {
  anyone = toAnyone;
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-who]")) {
    button.classList.toggle("active", (button.dataset.who === "anyone") === anyone);
  }
  $("f-taker-field").hidden = anyone;
  updateSummary();
}

/** The button of the form says what it does, with the amounts. */
function updateSubmit() {
  const give = parseAmount(fAmount.give.value, formMeta.give.decimals);
  const want = parseAmount(fAmount.want.value, formMeta.want.decimals);
  makeSubmit.disabled = busy || !account;
  makeSubmit.textContent = !account
    ? "Connect a wallet to make an offer"
    : give && want
      ? `Offer ${formatAmount(give, formMeta.give.decimals)} ${formMeta.give.symbol} for ` +
        `${formatAmount(want, formMeta.want.decimals)} ${formMeta.want.symbol}`
      : "Make the offer";
}

/** Says in a sentence what the offer in the form will do. */
function updateSummary() {
  const give = parseAmount(fAmount.give.value, formMeta.give.decimals);
  const want = parseAmount(fAmount.want.value, formMeta.want.decimals);
  const expiry = formExpiry();
  const show = (value: bigint, side: Side) =>
    `${formatAmount(value, formMeta[side].decimals)} ${formMeta[side].symbol}`;

  let text: string;
  if (!give || !want) {
    text = "Enter both amounts to see what happens to them.";
  } else if (Number.isNaN(expiry) || expiry <= Date.now()) {
    text = "Pick until when the offer stands: a moment in the future.";
  } else {
    const whoTakes = anyone ? "Anyone with the link" : "The account you name, and nobody else,";
    // Both rates, so the price reads the way the reader thinks of it.
    const rate = Number(want) / 10 ** formMeta.want.decimals / (Number(give) / 10 ** formMeta.give.decimals);
    const price = `${rate.toLocaleString("en-US", { maximumSignificantDigits: 6 })} ${formMeta.want.symbol} per ${formMeta.give.symbol}`;
    text =
      `${show(give, "give")} leave your wallet and wait in the contract. ${whoTakes} can take them until ` +
      `${formatDate(expiry)} by paying you ${show(want, "want")} (${price}) in the same transaction. ` +
      `Until then you can cancel and get them back.`;
  }
  summaryEl.textContent = text;
  updateSubmit();
}

function setTab(next: Tab) {
  tab = next;
  $("tab-maker").classList.toggle("active", tab === "maker");
  $("tab-taker").classList.toggle("active", tab === "taker");
  void refreshOffers();
}

/** Reads the offer number from the link: `#offer=3`. */
function readHash() {
  const value = new URLSearchParams(location.hash.slice(1)).get("offer");
  viewId = value !== null && /^\d+$/.test(value) ? BigInt(value) : null;
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
  swapAddress = key(contracts.get("OtcSwap").address);
  swap = new OtcSwapWasmClient(client, address(swapAddress));
  swapStorage = await ContractStorage.open(swapSchema, swapAddress);
  testHash = key(contracts.get("TestToken").address);
  tusdHash = key(contracts.get("TestDollar").address);

  $("contract").textContent = `Swap contract: ${swapAddress}.`;
  pick("give", "test");
  setAudience(true);
  applyPreset("1d");

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
  faucetTestBtn.addEventListener("click", faucetTest);
  faucetTusdBtn.addEventListener("click", faucetTusd);
  makeForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void make();
  });
  for (const side of ["give", "want"] as Side[]) {
    for (const button of document.querySelectorAll<HTMLButtonElement>(`[data-side="${side}"] [data-token]`)) {
      button.addEventListener("click", () => pick(side, button.dataset.token as Choice));
    }
    fToken[side].addEventListener("change", () => void describeToken(side));
    fAmount[side].addEventListener("input", updateSummary);
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-who]")) {
    button.addEventListener("click", () => setAudience(button.dataset.who === "anyone"));
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-preset]")) {
    button.addEventListener("click", () => applyPreset(button.dataset.preset!));
  }
  fExpiry.addEventListener("input", () => {
    markPreset(null);
    updateSummary();
  });
  $("tab-maker").addEventListener("click", () => setTab("maker"));
  $("tab-taker").addEventListener("click", () => setTab("taker"));
  $("share-copy").addEventListener("click", () => {
    navigator.clipboard
      .writeText(shareLink.value)
      .then(() => showTx("The link is copied."))
      .catch(() => shareLink.select());
  });
  lookupForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = lookupId.value.trim();
    if (/^\d+$/.test(value)) location.hash = `offer=${value}`;
  });
  window.addEventListener("hashchange", () => {
    readHash();
    void refreshView().then(() => {
      if (viewId !== null) viewSection.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
  $("tx-close").addEventListener("click", () => (txBox.hidden = true));

  readHash();
  await refreshAll();

  // The expiries count down: repaint every second from the local clock, without asking the node.
  setInterval(repaint, 1_000);

  // Loaded last: the client listens for the events the script sends once it is ready.
  await loadCsprClick();
  connectBtn.disabled = false;
}

run().catch((error) => {
  console.error(error);
  fatalBox.textContent = `The app could not start: ${errorText(error)}`;
  fatalBox.hidden = false;
});
