import "../../../style/odra.css";
import "./style.css";
import init, {
  AccountInfo,
  Address,
  Contracts,
  CsprClickCallbacks,
  LockerErrors,
  LockerWasmClient,
  OdraWasmClient,
  setGas,
  TestTokenErrors,
  TestTokenWasmClient,
  TransactionResult,
  TransactionStatus,
  U256,
} from "locker-wasm-client";
import lockerSchema from "../../resources/casper_contract_schemas/locker_schema.json";
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
/** Payment limits of the transactions the app sends, in motes. Estimates, with a margin. */
const GAS = {
  faucet: 5n * CSPR,
  approve: 5n * CSPR,
  lock: 10n * CSPR,
  extend: 5n * CSPR,
  transfer: 5n * CSPR,
  withdraw: 8n * CSPR,
};

const ERRORS: Record<number, string> = {
  [LockerErrors.ZeroAmount]: "The amount must be greater than zero.",
  [LockerErrors.UnlockTimeNotInFuture]: "The unlock date must be in the future.",
  [LockerErrors.LockNotFound]: "There is no lock with this number.",
  [LockerErrors.NotOwner]: "Only the owner of the lock can do this.",
  [LockerErrors.StillLocked]: "The lock has not reached its unlock date yet.",
  [LockerErrors.AlreadyWithdrawn]: "The tokens of this lock have been withdrawn already.",
  [LockerErrors.NotLater]: "The new unlock date must be later than the current one.",
  [LockerErrors.AlreadyOwner]: "That account owns the lock already.",
  [TestTokenErrors.InsufficientBalance]: "The token balance is too low.",
  [TestTokenErrors.InsufficientAllowance]: "The token allowance is too low.",
  [TestTokenErrors.CannotTargetSelfUser]: "The token does not allow a transfer to yourself.",
};

// ---------- Types ----------

interface TokenMeta {
  symbol: string;
  decimals: number;
}

/** A lock as plain values, read once from the contract. */
interface Item {
  id: bigint;
  owner: string;
  token: string;
  amount: bigint;
  lockedAt: number;
  unlockTime: number;
  withdrawn: boolean;
  meta: TokenMeta;
}

/** A rendered view: the element and the function that refreshes what changes with time. */
interface Card {
  element: HTMLElement;
  paint: () => void;
}

// ---------- State ----------

let client: OdraWasmClient;
let locker: LockerWasmClient;
let lockerStorage: ContractStorage;
let lockerAddress: string;
let testTokenHash: string;
let account: { publicKey: string; address: string } | null = null;
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
const lockForm = $<HTMLFormElement>("lock");
const lockError = $("lock-error");
const lockSubmit = $<HTMLButtonElement>("lock-submit");
const fToken = $<HTMLInputElement>("f-token");
const fTokenInfo = $("f-token-info");
const fAmount = $<HTMLInputElement>("f-amount");
const fAmountHint = $("f-amount-hint");
const fUnlock = $<HTMLInputElement>("f-unlock");
const summaryEl = $("summary");
const locksEl = $("locks");
const lookupForm = $<HTMLFormElement>("lookup");
const lookupToken = $<HTMLInputElement>("lookup-token");
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

function formatDuration(ms: number): string {
  const units: [number, string][] = [
    [365 * 86_400_000, "year"],
    [30 * 86_400_000, "month"],
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
  ];
  for (const [size, name] of units) {
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
async function tokenAmount(token: string, path: string, keys: string[] = []): Promise<bigint> {
  return BigInt((await (await tokenStorage(token)).read(path, keys)) ?? "0");
}

const balanceOf = (token: string, owner: string) => tokenAmount(token, "token.balances", [owner]);

const allowanceOf = (token: string, owner: string, spender: string) =>
  tokenAmount(token, "token.allowances", [`${owner}:${spender}`]);

/** The total supply of a token; `null` if the token cannot be read. */
const totalSupply = (token: string) => tokenAmount(token, "token.total_supply").catch(() => null);

/** The amount of `token` the locker holds: locked, or unlocked and not withdrawn yet. */
const heldAmount = async (token: string) => BigInt((await lockerStorage.read("locked", [token])) ?? "0");

/** The ids of the locks listed under `account` in `by_owner`, or under a token in `by_token`. */
async function lockIds(field: "by_owner" | "by_token", account: string): Promise<bigint[]> {
  const list = await lockerStorage.read(field, [account]);
  return (list?.match(/\d+/g) ?? []).map(BigInt);
}

async function loadItem(id: bigint): Promise<Item> {
  const stored = await lockerStorage.read("locks", [id.toString()]);
  if (stored === null) throw new Error(`There is no lock ${id}.`);
  // A struct is printed as a JSON object whose values are all strings.
  const lock: Record<string, string> = JSON.parse(stored);
  const token = formattedKey(lock.token);
  return {
    id,
    owner: formattedKey(lock.owner),
    token,
    amount: BigInt(lock.amount),
    lockedAt: Number(lock.locked_at),
    unlockTime: Number(lock.unlock_time),
    withdrawn: lock.withdrawn === "true",
    meta: await tokenMeta(token),
  };
}

/** Loads locks one after another, newest first: the node proxy is shared. */
async function loadItems(ids: bigint[]): Promise<Item[]> {
  const items: Item[] = [];
  for (const id of [...ids].reverse()) items.push(await loadItem(id));
  return items;
}

/** Whether the lock still holds its tokens and its unlock date has not come, on the local clock. */
const isLocked = (item: Item) => !item.withdrawn && Date.now() < item.unlockTime;

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

function status(item: Item): { text: string; tone: "" | "good" | "warn" } {
  const now = Date.now();
  if (item.withdrawn) return { text: "Withdrawn", tone: "warn" };
  if (now < item.unlockTime)
    return { text: `Locked, ${formatDuration(item.unlockTime - now)} left`, tone: "" };
  return { text: "Unlocked, not withdrawn", tone: "good" };
}

/** `you` for the connected account, a shortened address for anyone else. */
const who = (formatted: string) => (account?.address === formatted ? "you" : short(formatted));

const amountText = (item: Item, value = item.amount) =>
  `${formatAmount(value, item.meta.decimals)} ${item.meta.symbol}`;

/** A collapsible inline form of a lock card: one field and one button. */
function inlineForm(title: string, input: HTMLInputElement, button: HTMLButtonElement, onSubmit: () => void) {
  const details = element("details");
  const form = element("form", "inline");
  form.append(input, button);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    onSubmit();
  });
  details.append(element("summary", "", title), form);
  return details;
}

/** A lock the connected account owns, with what it can do with it. */
function buildCard(item: Item): Card {
  const card = element("article", "item");

  const head = element("div", "head");
  const heading = element("div");
  heading.append(
    element("div", "title", amountText(item)),
    element("div", "from", `Lock #${item.id} · owned by ${who(item.owner)}`),
  );
  const chip = element("span", "chip");
  head.append(heading, chip);

  // The bar runs from the moment of locking to the unlock date.
  const timeline = element("div", "timeline");
  const bar = element("div", "progress");
  const elapsedBar = element("div", "fill");
  bar.append(elapsedBar);
  const ticks = element("div", "ticks");
  const tick = (name: string, ms: number) => {
    const node = element("span", "", formatDate(ms));
    node.prepend(element("b", "", name));
    return node;
  };
  ticks.append(tick("Locked", item.lockedAt), tick("Unlocks on", item.unlockTime));
  timeline.append(bar, ticks);

  const actions = element("div", "actions");
  const withdrawBtn = element("button", "primary");
  withdrawBtn.addEventListener("click", () => withdraw(item));
  actions.append(withdrawBtn);

  const manage = element("div", "manage");
  const extendInput = element("input");
  extendInput.type = "datetime-local";
  extendInput.step = "1";
  extendInput.required = true;
  extendInput.value = toInputValue(Math.max(item.unlockTime, Date.now()) + 86_400_000);
  const extendBtn = element("button");
  const extendText = () => {
    const ms = new Date(extendInput.value).getTime();
    extendBtn.textContent = Number.isNaN(ms) ? "Keep locked longer" : `Keep locked until ${formatDate(ms)}`;
  };
  extendInput.addEventListener("input", extendText);
  extendText();

  const ownerInput = element("input", "mono");
  ownerInput.placeholder = "Public key or account-hash-…";
  ownerInput.required = true;
  const ownerBtn = element("button", "", `Hand over lock #${item.id}`);

  if (!item.withdrawn) {
    manage.append(
      inlineForm("Lock for longer", extendInput, extendBtn, () => extend(item, extendInput.value)),
      inlineForm("Hand the lock over to someone else", ownerInput, ownerBtn, () =>
        transferOwnership(item, ownerInput.value),
      ),
    );
  }

  const details = element("details");
  const facts = element("dl", "facts");
  fact(facts, "Owner", item.owner);
  fact(facts, "Token", item.token);
  fact(facts, "Locked on", formatDate(item.lockedAt));
  fact(facts, "Unlocks on", formatDate(item.unlockTime));
  details.append(element("summary", "", "Details"), facts);

  card.append(head, timeline, actions, manage, details);

  const paint = () => {
    const now = Date.now();
    const state = status(item);
    chip.textContent = state.text;
    chip.className = `chip ${state.tone}`;
    const span = item.unlockTime - item.lockedAt;
    const elapsed = span <= 0 ? 1 : Math.min(1, Math.max(0, (now - item.lockedAt) / span));
    elapsedBar.style.width = `${elapsed * 100}%`;

    withdrawBtn.hidden = item.withdrawn;
    withdrawBtn.textContent =
      now < item.unlockTime
        ? `Withdraw in ${formatDuration(item.unlockTime - now)}`
        : `Withdraw ${amountText(item)}`;
    withdrawBtn.disabled = busy || now < item.unlockTime;
    extendBtn.disabled = busy;
    ownerBtn.disabled = busy;
  };
  paint();
  return { element: card, paint };
}

/** Everything locked for one token: the totals, then a row per lock. */
function buildTokenView(
  token: string,
  meta: TokenMeta,
  items: Item[],
  held: bigint,
  supply: bigint | null,
): Card {
  const view = element("div", "token-view");
  const figure = (value: bigint) => formatAmount(value, meta.decimals);

  const tiles = element("div", "tiles");
  const tile = (name: string) => {
    const node = element("div", "tile");
    const value = element("div", "value");
    const sub = element("div", "sub");
    node.append(element("div", "label", name), value, sub);
    tiles.append(node);
    return { value, sub };
  };
  const lockedTile = tile("Locked now");
  const shareTile = tile("Of the supply");
  const nextTile = tile("Next unlock");

  const scroll = element("div", "scroll");
  const table = element("table");
  const headRow = element("tr");
  for (const name of ["Lock", "Owner", `Amount, ${meta.symbol}`, "Unlocks on", "Status"]) {
    headRow.append(element("th", "", name));
  }
  const thead = element("thead");
  thead.append(headRow);
  const tbody = element("tbody");
  const statusCells: [Item, HTMLElement][] = [];
  for (const item of items) {
    const row = element("tr");
    const owner = element("td", "mono", who(item.owner));
    owner.title = item.owner;
    const state = element("td");
    statusCells.push([item, state]);
    row.append(
      element("td", "", `#${item.id}`),
      owner,
      element("td", "", figure(item.amount)),
      element("td", "", formatDate(item.unlockTime)),
      state,
    );
    tbody.append(row);
  }
  table.append(thead, tbody);
  scroll.append(table);

  const heading = element("p", "hint", `${meta.symbol} · ${token}`);
  heading.classList.add("mono");
  view.append(heading, tiles);
  if (items.length > 0) view.append(scroll);
  else view.append(element("p", "empty", "Nothing has been locked for this token yet."));

  const paint = () => {
    const now = Date.now();
    const locked = items.filter(isLocked);
    const lockedNow = locked.reduce((sum, item) => sum + item.amount, 0n);
    lockedTile.value.textContent = figure(lockedNow);
    // The contract's total also counts locks that have expired and still hold their tokens.
    lockedTile.sub.textContent =
      held > lockedNow ? `${meta.symbol}, and ${figure(held - lockedNow)} unlocked` : meta.symbol;

    if (supply === null || supply === 0n) {
      shareTile.value.textContent = "—";
      shareTile.sub.textContent = "The supply cannot be read";
    } else {
      shareTile.value.textContent = `${(Number((lockedNow * 10_000n) / supply) / 100).toLocaleString("en-US")}%`;
      shareTile.sub.textContent = `of ${figure(supply)} ${meta.symbol}`;
    }

    const next = locked.reduce<Item | null>(
      (first, item) => (first === null || item.unlockTime < first.unlockTime ? item : first),
      null,
    );
    nextTile.value.textContent = next ? formatDuration(next.unlockTime - now) : "—";
    nextTile.sub.textContent = next
      ? `${amountText(next)} on ${formatDate(next.unlockTime)}`
      : "Nothing is locked";

    for (const [item, cell] of statusCells) cell.textContent = status(item).text;
  };
  paint();
  return { element: view, paint };
}

let listVersion = 0;

async function refreshLocks() {
  const version = ++listVersion;
  if (!account) {
    cards = [];
    locksEl.replaceChildren(element("p", "empty", "Connect a wallet to see your locks."));
    return;
  }
  try {
    const ids = await lockIds("by_owner", account.address);
    if (version !== listVersion) return;
    if (ids.length === 0) {
      cards = [];
      locksEl.replaceChildren(element("p", "empty", "You have not locked any tokens yet."));
      return;
    }
    locksEl.replaceChildren(element("p", "empty", "Loading…"));
    const built = (await loadItems(ids)).map(buildCard);
    if (version !== listVersion) return;
    cards = built;
    locksEl.replaceChildren(...built.map((card) => card.element));
  } catch (error) {
    if (version !== listVersion) return;
    cards = [];
    locksEl.replaceChildren(element("p", "notice", `Could not load: ${errorText(error)}`));
  }
}

let tokenView: Card | null = null;
/** The token the look-up shows, as a formatted key. */
let lookedUp: string | null = null;
let lookupVersion = 0;

async function lookup(token: string) {
  const version = ++lookupVersion;
  lookedUp = token;
  tokenView = null;
  lookupResult.replaceChildren(element("p", "empty", "Loading…"));
  try {
    const [meta, ids, held, supply] = await Promise.all([
      tokenMeta(token),
      lockIds("by_token", token),
      heldAmount(token),
      totalSupply(token),
    ]);
    const items = await loadItems(ids);
    if (version !== lookupVersion) return;
    tokenView = buildTokenView(token, meta, items, held, supply);
    lookupResult.replaceChildren(tokenView.element);
  } catch (error) {
    if (version !== lookupVersion) return;
    lookupResult.replaceChildren(element("p", "notice", `Could not load: ${errorText(error)}`));
  }
}

/** Shows the token in the look-up and puts it in the address, so the view can be shared. */
function showToken(token: string) {
  lookupToken.value = token;
  history.replaceState(null, "", `#token=${token}`);
  void lookup(token);
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
  tokenView?.paint();
  connectBtn.disabled = busy;
  faucetBtn.disabled = busy || !account;
  lockSubmit.disabled = busy || !account;
  updateSummary();
}

async function refreshAll() {
  refreshState();
  repaint();
  await Promise.all([refreshBalance(), refreshLocks(), lookedUp ? lookup(lookedUp) : Promise.resolve()]);
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

const withdraw = (item: Item) =>
  withBusy(async () => {
    await send(`Withdrawing ${amountText(item)} from lock #${item.id}`, GAS.withdraw, () =>
      locker.withdraw(item.id),
    );
  });

function extend(item: Item, value: string) {
  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) return showTx("Pick the new unlock date first.", { error: true });
  if (ms <= item.unlockTime) {
    return showTx(`The new date must be later than ${formatDate(item.unlockTime)}.`, { error: true });
  }
  return withBusy(async () => {
    await send(`Keeping lock #${item.id} until ${formatDate(ms)}`, GAS.extend, () =>
      locker.extend(item.id, BigInt(ms)),
    );
  });
}

function transferOwnership(item: Item, text: string) {
  let owner: string;
  try {
    owner = parseAddress(text);
  } catch {
    return showTx("The new owner is not a public key or an account hash.", { error: true });
  }
  if (owner === item.owner) return showTx("That account owns the lock already.", { error: true });
  return withBusy(async () => {
    await send(`Handing lock #${item.id} over to ${short(owner)}`, GAS.transfer, () =>
      locker.transferOwnership(item.id, address(owner)),
    );
  });
}

function showLockError(text: string) {
  lockError.textContent = text;
  lockError.hidden = !text;
}

/** The token, amount and unlock time in the form, or why they cannot be locked. */
function readForm(): { token: string; amount: bigint; unlock: number } | string {
  let token: string;
  try {
    token = parseAddress(fToken.value);
  } catch {
    return "The token is not a contract address (hash-…).";
  }
  const amount = parseAmount(fAmount.value, formMeta.decimals);
  if (amount === null || amount === 0n) {
    return `The amount must be a number above zero with up to ${formMeta.decimals} decimals.`;
  }
  const unlock = new Date(fUnlock.value).getTime();
  if (Number.isNaN(unlock)) return "Pick the unlock date.";
  if (unlock <= Date.now()) return "The unlock date must be in the future.";
  return { token, amount, unlock };
}

async function lock() {
  showLockError("");
  if (!account) return;
  await describeToken();
  const form = readForm();
  if (typeof form === "string") return showLockError(form);
  const { token, amount, unlock } = form;
  const meta = formMeta;

  await withBusy(async () => {
    const me = account!.address;
    const balance = await balanceOf(token, me);
    if (balance < amount) {
      return showLockError(
        `You have ${formatAmount(balance, meta.decimals)} ${meta.symbol}, less than the amount.`,
      );
    }
    const allowance = await allowanceOf(token, me, lockerAddress);
    if (allowance < amount) {
      const approved = await send("Step 1 of 2, allowing the contract to take the tokens", GAS.approve, () =>
        tokenClient(token).approve(address(lockerAddress), U256.fromBigInt(amount)),
      );
      if (!approved) return;
    }
    const locked = await send("Step 2 of 2, locking the tokens", GAS.lock, () =>
      locker.lock(address(token), U256.fromBigInt(amount), BigInt(unlock)),
    );
    if (locked) {
      fAmount.value = "";
      $("step-lock").classList.add("done");
      lookupToken.value = token;
      history.replaceState(null, "", `#token=${token}`);
      lookedUp = token;
    }
  });
}

// ---------- Form helpers ----------

const PRESETS: Record<string, number> = {
  "10m": 10 * 60_000,
  "1d": 86_400_000,
  "6mo": 182 * 86_400_000,
  "1y": 365 * 86_400_000,
};

function applyPreset(name: string) {
  fUnlock.value = toInputValue(Date.now() + PRESETS[name]);
  markPreset(name);
  updateSummary();
}

/** Highlights the preset the date was filled from; none once the date is edited by hand. */
function markPreset(name: string | null) {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-preset]")) {
    button.classList.toggle("active", button.dataset.preset === name);
  }
}

/** Says in a sentence what the lock in the form will do, and names the button after it. */
function updateSummary() {
  const form = readForm();
  if (typeof form === "string") {
    summaryEl.textContent = fAmount.value.trim() ? form : "Enter an amount to see what will happen.";
    lockSubmit.textContent = account ? "Lock tokens" : "Connect a wallet to lock tokens";
    return;
  }
  const amount = `${formatAmount(form.amount, formMeta.decimals)} ${formMeta.symbol}`;
  const until = formatDate(form.unlock);
  summaryEl.textContent =
    `${amount} stay in the contract until ${until}, ${formatDuration(form.unlock - Date.now())} from now. ` +
    "Until then nobody can take them out, you included. After it, only the owner of the lock can withdraw them.";
  lockSubmit.textContent = account ? `Lock ${amount} until ${until}` : "Connect a wallet to lock tokens";
}

async function describeToken() {
  fTokenInfo.textContent = "";
  const value = fToken.value.trim();
  if (!value) return;
  let token: string;
  try {
    token = parseAddress(value);
  } catch {
    fTokenInfo.textContent = "Not a contract address.";
    return;
  }
  const meta = await tokenMeta(token);
  if (fToken.value.trim() !== value) return;
  formMeta = meta;
  fTokenInfo.textContent = `${meta.symbol}, ${meta.decimals} decimals`;
  $("f-amount-symbol").textContent = meta.symbol;
  if (account) {
    const balance = await balanceOf(token, account.address).catch(() => null);
    fAmountHint.textContent =
      balance === null ? "" : `You have ${formatAmount(balance, meta.decimals)} ${meta.symbol}.`;
  } else {
    fAmountHint.textContent = "";
  }
  updateSummary();
}

// ---------- Wallet ----------

async function onAccount(info: AccountInfo) {
  account = { publicKey: info.publicKey, address: key(info.address) };
  accountKey.textContent = short(info.publicKey);
  accountKey.title = info.publicKey;
  connectBtn.hidden = true;
  accountBox.hidden = false;
  void describeToken();
  await refreshAll();
}

async function onSignedOut() {
  account = null;
  connectBtn.hidden = false;
  accountBox.hidden = true;
  fAmountHint.textContent = "";
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

/** The token named in the page address (`#token=hash-…`), if there is a valid one. */
function tokenFromLocation(): string | null {
  const value = new URLSearchParams(location.hash.slice(1)).get("token");
  if (!value) return null;
  try {
    return parseAddress(value);
  } catch {
    return null;
  }
}

// ---------- Start ----------

async function run() {
  await Promise.all([init(), initStorage(RPC_URL)]);

  const contracts = new Contracts(deployedContracts);
  client = new OdraWasmClient(RPC_URL, SPECULATIVE_RPC_URL, CHAIN_NAME);
  lockerAddress = key(contracts.get("Locker").address);
  locker = new LockerWasmClient(client, address(lockerAddress));
  lockerStorage = await ContractStorage.open(lockerSchema, lockerAddress);
  testTokenHash = key(contracts.get("TestToken").address);

  $("contract").textContent = `Locker contract: ${lockerAddress}.`;
  fToken.value = testTokenHash;
  applyPreset("10m");
  void describeToken();
  // A visitor sees what is locked straight away: the token in the address, or the test token.
  showToken(tokenFromLocation() ?? testTokenHash);

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
  lockForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void lock();
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-preset]")) {
    button.addEventListener("click", () => applyPreset(button.dataset.preset!));
  }
  fToken.addEventListener("change", () => void describeToken());
  fAmount.addEventListener("input", updateSummary);
  fUnlock.addEventListener("input", () => {
    markPreset(null);
    updateSummary();
  });
  lookupForm.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      showToken(parseAddress(lookupToken.value));
    } catch {
      lookupResult.replaceChildren(element("p", "notice", "That is not a contract address (hash-…)."));
    }
  });
  window.addEventListener("hashchange", () => {
    const token = tokenFromLocation();
    if (token && token !== lookedUp) showToken(token);
  });
  $("tx-close").addEventListener("click", () => (txBox.hidden = true));

  // Time left changes with the clock: repaint from it, without asking the node.
  setInterval(repaint, 5_000);

  // Loaded last: the client listens for the events the script sends once it is ready.
  await loadCsprClick();
  connectBtn.disabled = false;
}

run().catch((error) => {
  console.error(error);
  fatalBox.textContent = `The app could not start: ${errorText(error)}`;
  fatalBox.hidden = false;
});
