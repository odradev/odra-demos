import "../../../style/odra.css";
import "./style.css";
import init, {
  AccountInfo,
  Address,
  Contracts,
  CsprClickCallbacks,
  OdraWasmClient,
  setGas,
  StreamingErrors,
  StreamingWasmClient,
  TestTokenErrors,
  TestTokenWasmClient,
  TransactionResult,
  TransactionStatus,
  U256,
} from "streaming-wasm-client";
import streamingSchema from "../../resources/casper_contract_schemas/streaming_schema.json";
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
 * Payment limits of the transactions the app sends, in motes. Estimates: a CEP-18 call costs
 * about 0.4 CSPR and a call with one token transfer about 1.3 CSPR; cancelling makes two.
 */
const GAS = {
  faucet: 5n * CSPR,
  approve: 5n * CSPR,
  create: 10n * CSPR,
  withdraw: 6n * CSPR,
  cancel: 8n * CSPR,
};
/**
 * How far behind the local clock "withdraw all" counts. The contract counts on the time of the
 * block that runs the transaction; a clock that runs ahead of the network would ask for more
 * than has accrued there.
 */
const CLOCK_MARGIN_MS = 15_000;

const ERRORS: Record<number, string> = {
  [StreamingErrors.ZeroAmount]: "The amount must be greater than zero.",
  [StreamingErrors.InvalidTimes]: "The end must come after the start.",
  [StreamingErrors.AmountTooLarge]: "The amount is too large.",
  [StreamingErrors.StreamNotFound]: "There is no stream with this number.",
  [StreamingErrors.NotRecipient]: "Only the recipient of the stream can withdraw.",
  [StreamingErrors.NotSender]: "Only the sender of the stream can stop it.",
  [StreamingErrors.AmountExceedsBalance]: "That is more than has reached the recipient so far.",
  [StreamingErrors.AlreadyCancelled]: "This stream has been stopped already.",
  [TestTokenErrors.InsufficientBalance]: "The token balance is too low.",
  [TestTokenErrors.InsufficientAllowance]: "The token allowance is too low.",
  [TestTokenErrors.CannotTargetSelfUser]: "The token does not allow a transfer to yourself.",
};

// ---------- Types ----------

interface TokenMeta {
  symbol: string;
  decimals: number;
}

/** A stream as plain values, read once from the contract. */
interface Item {
  id: bigint;
  sender: string;
  recipient: string;
  token: string;
  deposit: bigint;
  withdrawn: bigint;
  start: number;
  stop: number;
  cancelled: boolean;
  refunded: bigint;
  meta: TokenMeta;
}

/** A rendered stream: the element and the function that refreshes what changes with time. */
interface Card {
  element: HTMLElement;
  paint: () => void;
}

// ---------- State ----------

let client: OdraWasmClient;
let streaming: StreamingWasmClient;
let streamingStorage: ContractStorage;
let streamingAddress: string;
let testTokenHash: string;
let account: { publicKey: string; address: string } | null = null;
let tab: "receiving" | "sent" = "receiving";
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
const fRecipient = $<HTMLInputElement>("f-recipient");
const fToken = $<HTMLInputElement>("f-token");
const fTokenInfo = $("f-token-info");
const fAmount = $<HTMLInputElement>("f-amount");
const fStart = $<HTMLInputElement>("f-start");
const fStop = $<HTMLInputElement>("f-stop");
const summaryEl = $("summary");
const streamsEl = $("streams");
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

/** The pace of a stream in the largest unit of time that fits in it twice: "per day", "per minute". */
function formatRate(amount: bigint, duration: number, meta: TokenMeta): string {
  const [size, name] = UNITS.slice(2).find(([unit]) => duration >= 2 * unit) ?? [1_000, "second"];
  return `${formatAmount((amount * BigInt(size)) / BigInt(duration), meta.decimals)} ${meta.symbol} per ${name}`;
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

const streamsCount = async () => BigInt((await streamingStorage.read("count")) ?? "0");

/** The ids of the streams listed for `account` in `by_recipient` or `by_sender`. */
async function streamIds(field: "by_recipient" | "by_sender", account: string): Promise<bigint[]> {
  const list = await streamingStorage.read(field, [account]);
  return (list?.match(/\d+/g) ?? []).map(BigInt);
}

async function loadItem(id: bigint): Promise<Item> {
  const stored = await streamingStorage.read("streams", [id.toString()]);
  if (stored === null) throw new Error(`There is no stream ${id}.`);
  // A struct is printed as a JSON object whose values are all strings.
  const stream: Record<string, string> = JSON.parse(stored);
  const token = formattedKey(stream.token);
  return {
    id,
    sender: formattedKey(stream.sender),
    recipient: formattedKey(stream.recipient),
    token,
    deposit: BigInt(stream.deposit),
    withdrawn: BigInt(stream.withdrawn),
    start: Number(stream.start),
    stop: Number(stream.stop),
    cancelled: stream.cancelled === "true",
    refunded: BigInt(stream.refunded),
    meta: await tokenMeta(token),
  };
}

/** The amount accrued to the recipient at `now`. The same rule as the contract's. */
function accruedAt(item: Item, now: number): bigint {
  if (item.cancelled) return item.withdrawn;
  if (now <= item.start) return 0n;
  if (now >= item.stop) return item.deposit;
  return (item.deposit * BigInt(now - item.start)) / BigInt(item.stop - item.start);
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

function status(item: Item, accrued: bigint): { text: string; tone: "" | "good" | "warn" } {
  const now = Date.now();
  if (item.cancelled) return { text: "Stopped by the sender", tone: "warn" };
  if (item.withdrawn === item.deposit) return { text: "All withdrawn", tone: "good" };
  if (now < item.start) return { text: `Starts in ${formatDuration(item.start - now)}`, tone: "" };
  if (accrued === item.deposit) return { text: "Ended, ready to withdraw", tone: "good" };
  return { text: `Streaming, ${formatDuration(item.stop - now)} left`, tone: "" };
}

/** `you` for the connected account, a shortened address for anyone else. */
const who = (formatted: string) => (account?.address === formatted ? "you" : short(formatted));

function buildCard(item: Item): Card {
  const amount = (value: bigint) => `${formatAmount(value, item.meta.decimals)} ${item.meta.symbol}`;
  const card = element("article", "item");

  const head = element("div", "head");
  const heading = element("div");
  heading.append(
    element("div", "title", amount(item.deposit)),
    element("div", "from", `Stream #${item.id} · from ${who(item.sender)} to ${who(item.recipient)}`),
  );
  const chip = element("span", "chip");
  head.append(heading, chip);

  // The bar runs from start to end: the dark part is withdrawn, the light part has arrived too.
  const timeline = element("div", "timeline");
  const bar = element("div", "progress");
  const accruedBar = element("div", "fill soft");
  const withdrawnBar = element("div", "fill");
  bar.append(accruedBar, withdrawnBar);
  const ticks = element("div", "ticks");
  const tick = (name: string, ms: number) => {
    const node = element("span", "", formatDate(ms));
    node.prepend(element("b", "", name));
    return node;
  };
  ticks.append(tick("Start", item.start), tick("End", item.stop));
  timeline.append(bar, ticks);

  // Stat tiles of the Odra style: the figure first, its unit under it.
  const amounts = element("div", "tiles");
  const amountEntry = (dot: string, name: string) => {
    const tile = element("div", "tile");
    const label = element("div", "label", name);
    label.prepend(element("span", `dot ${dot}`));
    const value = element("div", "value");
    tile.append(label, value, element("div", "sub", item.meta.symbol));
    amounts.append(tile);
    return value;
  };
  const figure = (value: bigint) => formatAmount(value, item.meta.decimals);
  const withdrawnTile = amountEntry("", "Withdrawn");
  const readyTile = amountEntry("soft", "Ready to withdraw");
  const restTile = amountEntry("rest", item.cancelled ? "Back to the sender" : "Still to come");

  const actions = element("div", "actions");
  // The recipient withdraws all of what has arrived, or the part they type in.
  let withdrawForm: HTMLFormElement | null = null;
  let withdrawInput: HTMLInputElement | null = null;
  let withdrawBtn: HTMLButtonElement | null = null;
  if (account?.address === item.recipient && !item.cancelled) {
    withdrawForm = element("form", "inline withdraw");
    withdrawInput = element("input");
    withdrawInput.inputMode = "decimal";
    withdrawInput.setAttribute("aria-label", "How much to withdraw");
    withdrawBtn = element("button", "primary");
    withdrawForm.append(withdrawInput, withdrawBtn);
    withdrawForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const typed = withdrawAmount();
      if (typed !== null && typed > 0n) withdraw(item, typed);
    });
    withdrawInput.addEventListener("input", () => paint());
    actions.append(withdrawForm);
  }
  let cancelBtn: HTMLButtonElement | null = null;
  if (account?.address === item.sender && !item.cancelled) {
    cancelBtn = element("button");
    cancelBtn.addEventListener("click", () => cancel(item));
    actions.append(cancelBtn);
  }

  const details = element("details");
  const facts = element("dl", "facts");
  fact(facts, "Recipient", item.recipient);
  fact(facts, "Sender", item.sender);
  fact(facts, "Token", item.token);
  fact(facts, "Pace", formatRate(item.deposit, item.stop - item.start, item.meta));
  details.append(element("summary", "", "Details"), facts);

  card.append(head, timeline, amounts, actions, details);

  /** What "withdraw all" asks for: what had arrived a little before now, by the local clock. */
  const available = () => accruedAt(item, Date.now() - CLOCK_MARGIN_MS) - item.withdrawn;

  /** The amount typed in, everything available if nothing is, `null` if it is not a number. */
  function withdrawAmount(): bigint | null {
    const text = withdrawInput?.value.trim() ?? "";
    return text ? parseAmount(text, item.meta.decimals) : available();
  }

  function paint() {
    const accrued = accruedAt(item, Date.now());
    const ready = accrued - item.withdrawn;
    const percent = (value: bigint) =>
      item.deposit === 0n ? "0%" : `${Number((value * 10_000n) / item.deposit) / 100}%`;
    const state = status(item, accrued);
    chip.textContent = state.text;
    chip.className = `chip ${state.tone}`;
    accruedBar.style.width = percent(accrued);
    withdrawnBar.style.width = percent(item.withdrawn);
    withdrawnTile.textContent = figure(item.withdrawn);
    readyTile.textContent = figure(ready);
    restTile.textContent = figure(item.cancelled ? item.refunded : item.deposit - accrued);

    if (withdrawForm && withdrawInput && withdrawBtn) {
      withdrawForm.hidden = item.withdrawn === item.deposit;
      withdrawInput.placeholder = figure(ready);
      const typed = withdrawAmount();
      if (typed === null) {
        withdrawBtn.textContent = "Not an amount";
        withdrawBtn.disabled = true;
      } else if (typed === 0n) {
        withdrawBtn.textContent = "Nothing to withdraw yet";
        withdrawBtn.disabled = true;
      } else if (typed > ready) {
        withdrawBtn.textContent = `Only ${amount(ready)} has arrived`;
        withdrawBtn.disabled = true;
      } else {
        withdrawBtn.textContent = withdrawInput.value.trim()
          ? `Withdraw ${amount(typed)}`
          : `Withdraw all ${amount(typed)}`;
        withdrawBtn.disabled = busy;
      }
    }
    if (cancelBtn) {
      cancelBtn.hidden = accrued === item.deposit;
      cancelBtn.textContent = `Stop the stream and take back ${amount(item.deposit - accrued)}`;
      cancelBtn.disabled = busy;
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
  // Newest first. One read per stream, one after another: the node proxy is shared.
  const built: Card[] = [];
  for (const id of [...ids].reverse()) {
    built.push(buildCard(await loadItem(id)));
  }
  target.replaceChildren(...built.map((card) => card.element));
  return built;
}

let listVersion = 0;

async function refreshStreams() {
  const version = ++listVersion;
  if (!account) {
    cards = [];
    streamsEl.replaceChildren(element("p", "empty", "Connect a wallet to see your streams."));
    return;
  }
  try {
    const ids = await streamIds(tab === "receiving" ? "by_recipient" : "by_sender", account.address);
    if (version !== listVersion) return;
    const built = await renderList(
      streamsEl,
      ids,
      tab === "receiving"
        ? "Nobody streams tokens to you yet."
        : "You have not streamed tokens to anyone yet.",
    );
    if (version === listVersion) cards = built;
  } catch (error) {
    if (version !== listVersion) return;
    cards = [];
    streamsEl.replaceChildren(element("p", "notice", `Could not load: ${errorText(error)}`));
  }
}

let lookupCard: Card | null = null;

async function lookup(id: bigint) {
  lookupCard = null;
  lookupResult.replaceChildren(element("p", "empty", "Loading…"));
  try {
    const count = await streamsCount();
    if (id >= count) {
      const text = count === 0n ? "No stream has been started yet." : `Numbers run from 0 to ${count - 1n}.`;
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
  await Promise.all([refreshBalance(), refreshStreams()]);
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

const withdraw = (item: Item, amount: bigint) =>
  withBusy(async () => {
    await send(`Withdrawing from stream #${item.id}`, GAS.withdraw, () =>
      streaming.withdraw(item.id, U256.fromBigInt(amount)),
    );
  });

const cancel = (item: Item) =>
  withBusy(async () => {
    await send(`Stopping stream #${item.id}`, GAS.cancel, () => streaming.cancel(item.id));
  });

function showCreateError(text: string) {
  createError.textContent = text;
  createError.hidden = !text;
}

async function create() {
  showCreateError("");
  if (!account) return;

  let recipient: string;
  let token: string;
  try {
    recipient = parseAddress(fRecipient.value);
  } catch {
    return showCreateError("The recipient is not a public key or an account hash.");
  }
  try {
    token = parseAddress(fToken.value);
  } catch {
    return showCreateError("The token is not a contract address (hash-…).");
  }
  const meta = await tokenMeta(token);
  const deposit = parseAmount(fAmount.value, meta.decimals);
  if (deposit === null || deposit === 0n) {
    return showCreateError(`The amount must be a number above zero with up to ${meta.decimals} decimals.`);
  }
  const [start, stop] = formTimes();
  if (Number.isNaN(start) || Number.isNaN(stop)) return showCreateError("Fill in both dates.");
  if (start >= stop) return showCreateError("The end must come after the start.");

  await withBusy(async () => {
    const me = account!.address;
    const cep18 = tokenClient(token);
    const balance = await balanceOf(token, me);
    if (balance < deposit) {
      return showCreateError(
        `You have ${formatAmount(balance, meta.decimals)} ${meta.symbol}, less than the amount.`,
      );
    }
    const allowance = await allowanceOf(token, me, streamingAddress);
    if (allowance < deposit) {
      const approved = await send("Step 1 of 2, allowing the contract to take the deposit", GAS.approve, () =>
        cep18.approve(address(streamingAddress), U256.fromBigInt(deposit)),
      );
      if (!approved) return;
    }
    const created = await send("Step 2 of 2, starting the stream", GAS.create, () =>
      streaming.createStream(
        address(recipient),
        address(token),
        U256.fromBigInt(deposit),
        BigInt(start),
        BigInt(stop),
      ),
    );
    if (created) {
      fAmount.value = "";
      updateSummary();
      $("step-create").classList.add("done");
      setTab(recipient === me ? "receiving" : "sent");
    }
  });
}

// ---------- Form helpers ----------

const PRESETS: Record<string, number> = {
  "10m": 10 * 60_000,
  "1h": 3_600_000,
  "30d": 30 * 86_400_000,
  "1y": 365 * 86_400_000,
};

const formTimes = () => [fStart, fStop].map((input) => new Date(input.value).getTime());

function applyPreset(name: string) {
  const now = Date.now();
  fStart.value = toInputValue(now);
  fStop.value = toInputValue(now + PRESETS[name]);
  markPreset(name);
  updateSummary();
}

/** Highlights the preset the dates were filled from; none once the dates are edited by hand. */
function markPreset(name: string | null) {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-preset]")) {
    button.classList.toggle("active", button.dataset.preset === name);
  }
}

/** The button of the form says what it does, with the amount. */
function updateSubmit() {
  const deposit = parseAmount(fAmount.value, formMeta.decimals);
  createSubmit.disabled = busy || !account;
  createSubmit.textContent = !account
    ? "Connect a wallet to start a stream"
    : deposit
      ? `Stream ${formatAmount(deposit, formMeta.decimals)} ${formMeta.symbol}`
      : "Start the stream";
}

/** Says in a sentence what the stream in the form will do. */
function updateSummary() {
  const deposit = parseAmount(fAmount.value, formMeta.decimals);
  const [start, stop] = formTimes();
  const show = (value: bigint) => `${formatAmount(value, formMeta.decimals)} ${formMeta.symbol}`;

  let text: string;
  if (deposit === null || deposit === 0n) {
    text = "Enter an amount to see how it reaches the recipient.";
  } else if (Number.isNaN(start) || Number.isNaN(stop)) {
    text = "Fill in both dates to see how the tokens reach the recipient.";
  } else if (start >= stop) {
    text = "The end must come after the start.";
  } else {
    text =
      `${show(deposit)} reach the recipient evenly from ${formatDate(start)} to ${formatDate(stop)}: ` +
      `${formatRate(deposit, stop - start, formMeta)}. You can stop the stream at any time and take back ` +
      `what has not reached them.`;
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

function setTab(next: "receiving" | "sent") {
  tab = next;
  $("tab-receiving").classList.toggle("active", tab === "receiving");
  $("tab-sent").classList.toggle("active", tab === "sent");
  void refreshStreams();
}

// ---------- Wallet ----------

async function onAccount(info: AccountInfo) {
  account = { publicKey: info.publicKey, address: key(info.address) };
  accountKey.textContent = short(info.publicKey);
  accountKey.title = info.publicKey;
  connectBtn.hidden = true;
  accountBox.hidden = false;
  if (!fRecipient.value) fRecipient.value = info.publicKey;
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
  streamingAddress = key(contracts.get("Streaming").address);
  streaming = new StreamingWasmClient(client, address(streamingAddress));
  streamingStorage = await ContractStorage.open(streamingSchema, streamingAddress);
  testTokenHash = key(contracts.get("TestToken").address);

  $("contract").textContent = `Streaming contract: ${streamingAddress}.`;
  fToken.value = testTokenHash;
  applyPreset("10m");
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
  for (const input of [fStart, fStop]) {
    input.addEventListener("input", () => {
      markPreset(null);
      updateSummary();
    });
  }
  $("tab-receiving").addEventListener("click", () => setTab("receiving"));
  $("tab-sent").addEventListener("click", () => setTab("sent"));
  lookupForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = lookupId.value.trim();
    if (/^\d+$/.test(value)) void lookup(BigInt(value));
  });
  $("tx-close").addEventListener("click", () => (txBox.hidden = true));

  // A stream pays by the millisecond: repaint every second from the local clock, without asking
  // the node.
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
