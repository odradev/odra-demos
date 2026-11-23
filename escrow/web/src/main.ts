import "../../../style/odra.css";
import "./style.css";
import init, {
  AccountInfo,
  Address,
  Contracts,
  CsprClickCallbacks,
  EscrowErrors,
  EscrowWasmClient,
  OdraWasmClient,
  setGas,
  TestTokenErrors,
  TestTokenWasmClient,
  TransactionResult,
  TransactionStatus,
  U256,
} from "escrow-wasm-client";
import escrowSchema from "../../resources/casper_contract_schemas/escrow_schema.json";
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
 * Payment limits of the transactions the app sends, in motes. Measured on CasperVM and on the
 * testnet: `create_deal` consumed 2.3 CSPR, `resolve` with a split 2.0, `release`, `refund` and
 * `reclaim` 1.24, `open_dispute` 0.5, `approve` 0.36, `faucet` 0.3. 2.5 CSPR is the practical
 * minimum of a call; three quarters of what a limit leaves unused comes back.
 */
const GAS = {
  faucet: (5n * CSPR) / 2n,
  approve: (5n * CSPR) / 2n,
  create: 5n * CSPR,
  release: (5n * CSPR) / 2n,
  refund: (5n * CSPR) / 2n,
  dispute: (5n * CSPR) / 2n,
  resolve: (7n * CSPR) / 2n,
  reclaim: (5n * CSPR) / 2n,
};
/**
 * How far the app keeps from a deadline. The contract compares it with the time of the block
 * that runs the transaction; a clock that runs ahead of or behind the network would offer an
 * action the contract then refuses, and a failed transaction costs its whole limit.
 */
const CLOCK_MARGIN_MS = 15_000;

const ERRORS: Record<number, string> = {
  [EscrowErrors.ZeroAmount]: "The amount must be greater than zero.",
  [EscrowErrors.DeadlineNotInFuture]: "The deadline must be in the future.",
  [EscrowErrors.DealNotFound]: "There is no deal with this number.",
  [EscrowErrors.NotBuyer]: "Only the buyer of the deal can do this.",
  [EscrowErrors.NotSeller]: "Only the seller of the deal can do this.",
  [EscrowErrors.NotParty]: "Only the buyer or the seller can open a dispute.",
  [EscrowErrors.NotArbiter]: "Only the arbiter of the deal can decide it.",
  [EscrowErrors.DealClosed]: "This deal is closed already.",
  [EscrowErrors.AlreadyDisputed]: "A dispute is open already.",
  [EscrowErrors.NotDisputed]: "The arbiter can decide only a deal with a dispute open.",
  [EscrowErrors.DeadlinePassed]: "The deadline has passed: a dispute can no longer be opened.",
  [EscrowErrors.DeadlineNotReached]: "The tokens can be taken back only after the deadline.",
  [EscrowErrors.DisputeOpen]: "A dispute is open: the arbiter decides where the tokens go.",
  [EscrowErrors.ShareTooLarge]: "The seller's part is more than the deal holds.",
  [TestTokenErrors.InsufficientBalance]: "The token balance is too low.",
  [TestTokenErrors.InsufficientAllowance]: "The token allowance is too low.",
  [TestTokenErrors.CannotTargetSelfUser]: "The token does not allow a transfer to yourself.",
};

// ---------- Types ----------

interface TokenMeta {
  symbol: string;
  decimals: number;
}

/** Where a deal stands, by the variant names of `DealState` in the contract. */
type DealState = "Funded" | "Disputed" | "Released" | "Refunded" | "Resolved" | "Reclaimed";

type Role = "buyer" | "seller" | "arbiter";

/** A deal as plain values, read once from the contract. */
interface Item {
  id: bigint;
  buyer: string;
  seller: string;
  arbiter: string;
  token: string;
  amount: bigint;
  deadline: number;
  state: DealState;
  sellerShare: bigint;
  meta: TokenMeta;
}

/** A rendered deal: the element and the function that refreshes what changes with time. */
interface Card {
  element: HTMLElement;
  paint: () => void;
}

// ---------- State ----------

let client: OdraWasmClient;
let escrow: EscrowWasmClient;
let escrowStorage: ContractStorage;
let escrowAddress: string;
let testTokenHash: string;
let account: { publicKey: string; address: string } | null = null;
let tab: Role = "buyer";
let busy = false;
let cards: Card[] = [];
/** The token the form is filled in for: the unit of the amount field and of the summary. */
let formMeta: TokenMeta = { symbol: "TEST", decimals: 9 };
const tokenMetas = new Map<string, Promise<TokenMeta>>();
const tokenStorages = new Map<string, Promise<ContractStorage>>();

// ---------- DOM ----------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const connectBtn = $<HTMLButtonElement>("connect");
const accountBox = $("account");
const accountKey = $("account-key");
const fatalBox = $("fatal");
const balanceEl = $("balance");
const faucetBtn = $<HTMLButtonElement>("faucet");
const createForm = $<HTMLFormElement>("create");
const createError = $("create-error");
const createSubmit = $<HTMLButtonElement>("create-submit");
const fSeller = $<HTMLInputElement>("f-seller");
const fArbiter = $<HTMLInputElement>("f-arbiter");
const fToken = $<HTMLInputElement>("f-token");
const fTokenInfo = $("f-token-info");
const fAmount = $<HTMLInputElement>("f-amount");
const fDeadline = $<HTMLInputElement>("f-deadline");
const summaryEl = $("summary");
const dealsEl = $("deals");
const lookupForm = $<HTMLFormElement>("lookup");
const lookupId = $<HTMLInputElement>("lookup-id");
const lookupResult = $("lookup-result");
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

/** Formats an amount of the smallest unit as a decimal number with up to 4 fraction digits. */
function formatAmount(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = (value / base).toLocaleString("en-US");
  const fraction = (value % base).toString().padStart(decimals, "0").slice(0, 4).replace(/0+$/, "");
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

// ---------- Reading the contracts ----------

// State is read from the node's storage (see storage.ts). The generated client is used only to
// send transactions.

const tokenClient = (token: string) => new TestTokenWasmClient(client, address(token));

/**
 * The storage of a token. Every token is read with the schema of `TestToken`, which keeps the
 * state of Odra's `Cep18` module in a field called `token`; a token laid out differently fails
 * to read.
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

const dealsCount = async () => BigInt((await escrowStorage.read("count")) ?? "0");

/** The ids of the deals `account` has in `role`: the lists `by_buyer`, `by_seller`, `by_arbiter`. */
async function dealIds(role: Role, account: string): Promise<bigint[]> {
  const list = await escrowStorage.read(`by_${role}`, [account]);
  return (list?.match(/\d+/g) ?? []).map(BigInt);
}

async function loadItem(id: bigint): Promise<Item> {
  const stored = await escrowStorage.read("deals", [id.toString()]);
  if (stored === null) throw new Error(`There is no deal ${id}.`);
  // A struct is printed as a JSON object whose values are all strings; an enum by its variant name.
  const deal: Record<string, string> = JSON.parse(stored);
  const token = formattedKey(deal.token);
  return {
    id,
    buyer: formattedKey(deal.buyer),
    seller: formattedKey(deal.seller),
    arbiter: formattedKey(deal.arbiter),
    token,
    amount: BigInt(deal.amount),
    deadline: Number(deal.deadline),
    state: deal.state as DealState,
    sellerShare: BigInt(deal.seller_share),
    meta: await tokenMeta(token),
  };
}

const isOpen = (item: Item) => item.state === "Funded" || item.state === "Disputed";

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

function status(item: Item): { text: string; tone: "" | "good" | "warn" } {
  switch (item.state) {
    case "Funded":
      return Date.now() < item.deadline
        ? { text: "Paid in, waiting for the buyer", tone: "" }
        : { text: "Deadline passed", tone: "warn" };
    case "Disputed":
      return { text: "Dispute open", tone: "warn" };
    case "Released":
      return { text: "Paid to the seller", tone: "good" };
    case "Refunded":
      return { text: "Sent back by the seller", tone: "" };
    case "Resolved":
      return { text: "Decided by the arbiter", tone: "good" };
    case "Reclaimed":
      return { text: "Taken back after the deadline", tone: "" };
  }
}

/** `you` for the connected account, a shortened address for anyone else. */
const who = (formatted: string) => (account?.address === formatted ? "you" : short(formatted));

/** The roles of the connected account in a deal, in words: "You are the buyer and the arbiter." */
function rolesText(item: Item): string {
  const roles = (["buyer", "seller", "arbiter"] as Role[]).filter((role) => account?.address === item[role]);
  if (roles.length === 0) return "";
  const names = roles.map((role) => `the ${role}`);
  const joined = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `You are ${joined}.`;
}

function buildCard(item: Item): Card {
  const amount = (value: bigint) => `${formatAmount(value, item.meta.decimals)} ${item.meta.symbol}`;
  const me = account?.address;
  const card = element("article", "item");

  const head = element("div", "head");
  const heading = element("div");
  heading.append(
    element("div", "title", amount(item.amount)),
    element("div", "from", `Deal #${item.id} · from ${who(item.buyer)} to ${who(item.seller)}`),
  );
  const chip = element("span", "chip");
  head.append(heading, chip);

  const facts = element("dl", "facts");
  fact(facts, "Buyer", item.buyer);
  fact(facts, "Seller", item.seller);
  fact(facts, "Arbiter", item.arbiter);
  fact(facts, "Token", item.token);
  const deadlineValue = fact(facts, "Deadline", "", false);
  if (!isOpen(item)) {
    fact(
      facts,
      "Outcome",
      `${amount(item.sellerShare)} to the seller, ${amount(item.amount - item.sellerShare)} back to the buyer`,
      false,
    );
  }

  const roles = rolesText(item);
  const rolesLine = element("p", "roles", roles);

  // Only the buttons the connected account may use. Every action pays out at once, so none of
  // them is the primary button of the page.
  const actions = element("div", "actions");
  const button = (text: string, onClick: () => void) => {
    const node = element("button", "", text);
    node.addEventListener("click", onClick);
    actions.append(node);
    return node;
  };
  const isBuyer = me === item.buyer;
  const isSeller = me === item.seller;
  const isArbiter = me === item.arbiter;
  const buttons: HTMLButtonElement[] = [];
  if (isOpen(item) && isBuyer) {
    buttons.push(button(`Release ${amount(item.amount)} to the seller`, () => release(item)));
  }
  if (isOpen(item) && isSeller) {
    buttons.push(button(`Send ${amount(item.amount)} back to the buyer`, () => refund(item)));
  }
  let disputeBtn: HTMLButtonElement | null = null;
  if (item.state === "Funded" && (isBuyer || isSeller)) {
    disputeBtn = button("Open a dispute", () => openDispute(item));
    buttons.push(disputeBtn);
  }
  let reclaimBtn: HTMLButtonElement | null = null;
  if (item.state === "Funded" && isBuyer) {
    reclaimBtn = button(`Take back ${amount(item.amount)}`, () => reclaim(item));
    buttons.push(reclaimBtn);
  }

  // The arbiter's decision: all to one side, or a split typed in.
  let decide: HTMLElement | null = null;
  let splitInput: HTMLInputElement | null = null;
  let splitBtn: HTMLButtonElement | null = null;
  if (item.state === "Disputed" && isArbiter) {
    decide = element("div", "decide");
    decide.append(element("div", "label", "Your decision as the arbiter"));
    const choices = element("div", "actions");
    const forBuyer = element("button", "", `Decide for the buyer: ${amount(item.amount)} back to them`);
    forBuyer.addEventListener("click", () => resolve(item, 0n));
    const forSeller = element("button", "", `Decide for the seller: ${amount(item.amount)} to them`);
    forSeller.addEventListener("click", () => resolve(item, item.amount));
    choices.append(forBuyer, forSeller);
    buttons.push(forBuyer, forSeller);

    const split = element("form", "inline");
    splitInput = element("input");
    splitInput.inputMode = "decimal";
    splitInput.placeholder = `To the seller, e.g. ${formatAmount(item.amount / 2n, item.meta.decimals)}`;
    splitInput.setAttribute("aria-label", "How much goes to the seller");
    splitBtn = element("button");
    split.append(splitInput, splitBtn);
    split.addEventListener("submit", (event) => {
      event.preventDefault();
      const share = splitShare();
      if (share !== null && share <= item.amount) resolve(item, share);
    });
    splitInput.addEventListener("input", () => paint());
    decide.append(choices, split);
  }

  const details = element("details");
  details.append(element("summary", "", "Details"), facts);

  card.append(head);
  if (roles) card.append(rolesLine);
  if (actions.children.length > 0) card.append(actions);
  if (decide) card.append(decide);
  card.append(details);

  function splitShare(): bigint | null {
    const text = splitInput?.value.trim() ?? "";
    return text ? parseAmount(text, item.meta.decimals) : null;
  }

  function paint() {
    const now = Date.now();
    const state = status(item);
    chip.textContent = state.text;
    chip.className = `chip ${state.tone}`;
    deadlineValue.textContent =
      now < item.deadline
        ? `${formatDate(item.deadline)}, in ${formatDuration(item.deadline - now)}`
        : `${formatDate(item.deadline)}, passed`;

    for (const node of buttons) node.disabled = busy;
    // Kept a little away from the deadline, so the block that runs the call agrees.
    if (disputeBtn) disputeBtn.hidden = now >= item.deadline - CLOCK_MARGIN_MS;
    if (reclaimBtn) reclaimBtn.hidden = now < item.deadline + CLOCK_MARGIN_MS;
    actions.hidden = [...actions.children].every((node) => (node as HTMLElement).hidden);

    if (splitBtn) {
      const share = splitShare();
      if (share === null) {
        splitBtn.textContent = splitInput?.value.trim() ? "Not an amount" : "Split it";
        splitBtn.disabled = true;
      } else if (share > item.amount) {
        splitBtn.textContent = `The deal holds only ${amount(item.amount)}`;
        splitBtn.disabled = true;
      } else {
        splitBtn.textContent = `Give ${amount(share)} to the seller, ${amount(item.amount - share)} back`;
        splitBtn.disabled = busy;
      }
    }
  }
  paint();
  return { element: card, paint };
}

async function renderList(target: HTMLElement, ids: bigint[], emptyText: string): Promise<Card[]> {
  if (ids.length === 0) {
    target.replaceChildren(element("p", "empty", emptyText));
    return [];
  }
  target.replaceChildren(element("p", "empty", "Loading…"));
  // Newest first. One read per deal, one after another: the node proxy is shared.
  const built: Card[] = [];
  for (const id of [...ids].reverse()) {
    built.push(buildCard(await loadItem(id)));
  }
  target.replaceChildren(...built.map((card) => card.element));
  return built;
}

const EMPTY: Record<Role, string> = {
  buyer: "You have not paid into a deal yet.",
  seller: "Nobody has paid you through a deal yet.",
  arbiter: "Nobody has named you the arbiter of a deal yet.",
};

let listVersion = 0;

async function refreshDeals() {
  const version = ++listVersion;
  if (!account) {
    cards = [];
    dealsEl.replaceChildren(element("p", "empty", "Connect a wallet to see your deals."));
    return;
  }
  try {
    const ids = await dealIds(tab, account.address);
    if (version !== listVersion) return;
    const built = await renderList(dealsEl, ids, EMPTY[tab]);
    if (version === listVersion) cards = built;
  } catch (error) {
    if (version !== listVersion) return;
    cards = [];
    dealsEl.replaceChildren(element("p", "notice", `Could not load: ${errorText(error)}`));
  }
}

let lookupCard: Card | null = null;

async function lookup(id: bigint) {
  lookupCard = null;
  lookupResult.replaceChildren(element("p", "empty", "Loading…"));
  try {
    const count = await dealsCount();
    if (id >= count) {
      const text = count === 0n ? "No deal has been made yet." : `Numbers run from 0 to ${count - 1n}.`;
      lookupResult.replaceChildren(element("p", "empty", text));
      return;
    }
    lookupCard = buildCard(await loadItem(id));
    lookupResult.replaceChildren(lookupCard.element);
  } catch (error) {
    lookupResult.replaceChildren(element("p", "notice", `Could not load: ${errorText(error)}`));
  }
}

async function refreshBalance() {
  $("step-connect").classList.toggle("done", account !== null);
  if (!account) {
    balanceEl.textContent = "—";
    $("step-faucet").classList.remove("done");
    return;
  }
  try {
    const balance = await balanceOf(testTokenHash, account.address);
    balanceEl.textContent = `${formatAmount(balance, 9)} TEST`;
    $("step-faucet").classList.toggle("done", balance > 0n);
  } catch (error) {
    balanceEl.textContent = "?";
    console.error(error);
  }
}

function repaint() {
  for (const card of cards) card.paint();
  lookupCard?.paint();
  connectBtn.disabled = busy;
  faucetBtn.disabled = busy || !account;
  updateSubmit();
}

async function refreshAll() {
  refreshState();
  repaint();
  await Promise.all([refreshBalance(), refreshDeals()]);
  const shown = lookupId.value.trim();
  if (lookupCard && /^\d+$/.test(shown)) await lookup(BigInt(shown));
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

const release = (item: Item) =>
  withBusy(async () => {
    await send(`Releasing deal #${item.id} to the seller`, GAS.release, () => escrow.release(item.id));
  });

const refund = (item: Item) =>
  withBusy(async () => {
    await send(`Sending deal #${item.id} back to the buyer`, GAS.refund, () => escrow.refund(item.id));
  });

const openDispute = (item: Item) =>
  withBusy(async () => {
    await send(`Opening a dispute on deal #${item.id}`, GAS.dispute, () => escrow.openDispute(item.id));
  });

const resolve = (item: Item, sellerShare: bigint) =>
  withBusy(async () => {
    await send(`Deciding deal #${item.id}`, GAS.resolve, () =>
      escrow.resolve(item.id, U256.fromBigInt(sellerShare)),
    );
  });

const reclaim = (item: Item) =>
  withBusy(async () => {
    await send(`Taking back deal #${item.id}`, GAS.reclaim, () => escrow.reclaim(item.id));
  });

function showCreateError(text: string) {
  createError.textContent = text;
  createError.hidden = !text;
}

async function create() {
  showCreateError("");
  if (!account) return;

  let seller: string;
  let arbiter: string;
  let token: string;
  try {
    seller = parseAddress(fSeller.value);
  } catch {
    return showCreateError("The seller is not a public key or an account hash.");
  }
  try {
    arbiter = parseAddress(fArbiter.value);
  } catch {
    return showCreateError("The arbiter is not a public key or an account hash.");
  }
  try {
    token = parseAddress(fToken.value);
  } catch {
    return showCreateError("The token is not a contract address (hash-…).");
  }
  const meta = await tokenMeta(token);
  const amount = parseAmount(fAmount.value, meta.decimals);
  if (amount === null || amount === 0n) {
    return showCreateError(`The amount must be a number above zero with up to ${meta.decimals} decimals.`);
  }
  const deadline = formDeadline();
  if (Number.isNaN(deadline)) return showCreateError("Fill in the deadline.");
  if (deadline <= Date.now() + CLOCK_MARGIN_MS) return showCreateError("The deadline must be in the future.");

  await withBusy(async () => {
    const me = account!.address;
    const cep18 = tokenClient(token);
    const balance = await balanceOf(token, me);
    if (balance < amount) {
      return showCreateError(
        `You have ${formatAmount(balance, meta.decimals)} ${meta.symbol}, less than the amount.`,
      );
    }
    const allowance = await allowanceOf(token, me, escrowAddress);
    if (allowance < amount) {
      const approved = await send("Step 1 of 2, allowing the contract to take the tokens", GAS.approve, () =>
        cep18.approve(address(escrowAddress), U256.fromBigInt(amount)),
      );
      if (!approved) return;
    }
    const created = await send("Step 2 of 2, paying into escrow", GAS.create, () =>
      escrow.createDeal(
        address(seller),
        address(arbiter),
        address(token),
        U256.fromBigInt(amount),
        BigInt(deadline),
      ),
    );
    if (created) {
      fAmount.value = "";
      updateSummary();
      $("step-create").classList.add("done");
      setTab("buyer");
    }
  });
}

// ---------- Form helpers ----------

const PRESETS: Record<string, number> = {
  "10m": 10 * 60_000,
  "1d": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

const formDeadline = () => new Date(fDeadline.value).getTime();

function applyPreset(name: string) {
  fDeadline.value = toInputValue(Date.now() + PRESETS[name]);
  markPreset(name);
  updateSummary();
}

/** Highlights the preset the deadline was filled from; none once it is edited by hand. */
function markPreset(name: string | null) {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-preset]")) {
    button.classList.toggle("active", button.dataset.preset === name);
  }
}

/** The button of the form says what it does, with the amount. */
function updateSubmit() {
  const amount = parseAmount(fAmount.value, formMeta.decimals);
  createSubmit.disabled = busy || !account;
  createSubmit.textContent = !account
    ? "Connect a wallet to pay into escrow"
    : amount
      ? `Pay ${formatAmount(amount, formMeta.decimals)} ${formMeta.symbol} into escrow`
      : "Pay into escrow";
}

/** Says in a sentence what the deal in the form will do. */
function updateSummary() {
  const amount = parseAmount(fAmount.value, formMeta.decimals);
  const deadline = formDeadline();
  const show = (value: bigint) => `${formatAmount(value, formMeta.decimals)} ${formMeta.symbol}`;

  let text: string;
  if (amount === null || amount === 0n) {
    text = "Enter an amount to see what happens to it.";
  } else if (Number.isNaN(deadline)) {
    text = "Fill in the deadline to see what happens to the tokens.";
  } else if (deadline <= Date.now()) {
    text = "The deadline must be in the future.";
  } else {
    text =
      `${show(amount)} leave your wallet and wait in the contract. You release them to the seller, or ` +
      `the seller sends them back. Until ${formatDate(deadline)} either of you can open a dispute, and ` +
      `then the arbiter decides. With no dispute by then, you can take them back.`;
  }
  summaryEl.textContent = text;
  updateSubmit();
}

async function describeToken() {
  fTokenInfo.textContent = "";
  const value = fToken.value.trim();
  if (!value) return;
  let token: string;
  try {
    token = parseAddress(value);
  } catch {
    return;
  }
  const meta = await tokenMeta(token);
  if (fToken.value.trim() === value) {
    formMeta = meta;
    fTokenInfo.textContent = `${meta.symbol}, ${meta.decimals} decimals`;
    $("f-amount-symbol").textContent = meta.symbol;
    updateSummary();
  }
}

const ROLES: Role[] = ["buyer", "seller", "arbiter"];

function setTab(next: Role) {
  tab = next;
  for (const role of ROLES) $(`tab-${role}`).classList.toggle("active", tab === role);
  void refreshDeals();
}

// ---------- Wallet ----------

async function onAccount(info: AccountInfo) {
  account = { publicKey: info.publicKey, address: key(info.address) };
  accountKey.textContent = short(info.publicKey);
  accountKey.title = info.publicKey;
  connectBtn.hidden = true;
  accountBox.hidden = false;
  if (!fSeller.value) fSeller.value = info.publicKey;
  if (!fArbiter.value) fArbiter.value = info.publicKey;
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
  escrowAddress = key(contracts.get("Escrow").address);
  escrow = new EscrowWasmClient(client, address(escrowAddress));
  escrowStorage = await ContractStorage.open(escrowSchema, escrowAddress);
  testTokenHash = key(contracts.get("TestToken").address);

  $("contract").textContent = `Escrow contract: ${escrowAddress}.`;
  fToken.value = testTokenHash;
  applyPreset("1d");
  void describeToken();

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
  createForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void create();
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-preset]")) {
    button.addEventListener("click", () => applyPreset(button.dataset.preset!));
  }
  fToken.addEventListener("change", () => void describeToken());
  fAmount.addEventListener("input", updateSummary);
  fDeadline.addEventListener("input", () => {
    markPreset(null);
    updateSummary();
  });
  for (const role of ROLES) $(`tab-${role}`).addEventListener("click", () => setTab(role));
  lookupForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = lookupId.value.trim();
    if (/^\d+$/.test(value)) void lookup(BigInt(value));
  });
  $("tx-close").addEventListener("click", () => (txBox.hidden = true));

  // The deadlines count down: repaint every second from the local clock, without asking the node.
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
