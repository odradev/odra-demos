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
  TransactionResult,
  TransactionStatus,
  U256,
  VestingErrors,
  VestingWasmClient,
} from "vesting-wasm-client";
import testTokenSchema from "../../resources/casper_contract_schemas/test_token_schema.json";
import vestingSchema from "../../resources/casper_contract_schemas/vesting_schema.json";
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
/** Payment limits of the transactions the app sends, in motes. */
const GAS = {
  faucet: 5n * CSPR,
  approve: 5n * CSPR,
  create: 10n * CSPR,
  release: 6n * CSPR,
  revoke: 6n * CSPR,
};

const ERRORS: Record<number, string> = {
  [VestingErrors.ZeroAmount]: "The amount must be greater than zero.",
  [VestingErrors.InvalidTimes]: "The dates must be in order: start, cliff, end.",
  [VestingErrors.AmountTooLarge]: "The amount is too large.",
  [VestingErrors.ScheduleNotFound]: "There is no schedule with this id.",
  [VestingErrors.NothingToRelease]: "Nothing has vested since the last release.",
  [VestingErrors.NotCreator]: "Only the creator of the schedule can revoke it.",
  [VestingErrors.NotRevocable]: "This schedule is not revocable.",
  [VestingErrors.AlreadyRevoked]: "This schedule has been revoked already.",
  [TestTokenErrors.InsufficientBalance]: "The token balance is too low.",
  [TestTokenErrors.InsufficientAllowance]: "The token allowance is too low.",
  [TestTokenErrors.CannotTargetSelfUser]: "The token does not allow a transfer to yourself.",
};

// ---------- Types ----------

interface TokenMeta {
  symbol: string;
  decimals: number;
}

/** A schedule as plain values, read once from the contract. */
interface Item {
  id: bigint;
  creator: string;
  beneficiary: string;
  token: string;
  total: bigint;
  released: bigint;
  start: number;
  cliff: number;
  end: number;
  revocable: boolean;
  revoked: boolean;
  meta: TokenMeta;
}

/** A rendered schedule: the element and the function that refreshes what changes with time. */
interface Card {
  element: HTMLElement;
  paint: () => void;
}

// ---------- State ----------

let client: OdraWasmClient;
let vesting: VestingWasmClient;
let vestingStorage: ContractStorage;
let vestingAddress: string;
let testTokenHash: string;
let account: { publicKey: string; address: string } | null = null;
let tab: "receiving" | "created" = "receiving";
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
const fBeneficiary = $<HTMLInputElement>("f-beneficiary");
const fToken = $<HTMLInputElement>("f-token");
const fTokenInfo = $("f-token-info");
const fAmount = $<HTMLInputElement>("f-amount");
const fStart = $<HTMLInputElement>("f-start");
const fCliff = $<HTMLInputElement>("f-cliff");
const fEnd = $<HTMLInputElement>("f-end");
const fRevocable = $<HTMLInputElement>("f-revocable");
const summaryEl = $("summary");
const schedulesEl = $("schedules");
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
async function tokenAmount(token: string, path: string, keys: string[]): Promise<bigint> {
  return BigInt((await (await tokenStorage(token)).read(path, keys)) ?? "0");
}

const balanceOf = (token: string, owner: string) => tokenAmount(token, "token.balances", [owner]);

const allowanceOf = (token: string, owner: string, spender: string) =>
  tokenAmount(token, "token.allowances", [`${owner}:${spender}`]);

const schedulesCount = async () => BigInt((await vestingStorage.read("count")) ?? "0");

/** The ids of the schedules listed for `account` in `by_beneficiary` or `by_creator`. */
async function scheduleIds(field: "by_beneficiary" | "by_creator", account: string): Promise<bigint[]> {
  const list = await vestingStorage.read(field, [account]);
  return (list?.match(/\d+/g) ?? []).map(BigInt);
}

async function loadItem(id: bigint): Promise<Item> {
  const stored = await vestingStorage.read("schedules", [id.toString()]);
  if (stored === null) throw new Error(`There is no schedule ${id}.`);
  // A struct is printed as a JSON object whose values are all strings.
  const schedule: Record<string, string> = JSON.parse(stored);
  const token = formattedKey(schedule.token);
  return {
    id,
    creator: formattedKey(schedule.creator),
    beneficiary: formattedKey(schedule.beneficiary),
    token,
    total: BigInt(schedule.total),
    released: BigInt(schedule.released),
    start: Number(schedule.start),
    cliff: Number(schedule.cliff),
    end: Number(schedule.end),
    revocable: schedule.revocable === "true",
    revoked: schedule.revoked === "true",
    meta: await tokenMeta(token),
  };
}

/** The amount vested now. The same rule as the contract's, on the local clock. */
function vestedNow(item: Item): bigint {
  if (item.revoked) return item.total;
  const now = Date.now();
  if (now < item.cliff) return 0n;
  if (now >= item.end) return item.total;
  return (item.total * BigInt(now - item.start)) / BigInt(item.end - item.start);
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

function status(item: Item, vested: bigint): { text: string; tone: "" | "good" | "warn" } {
  const now = Date.now();
  if (item.revoked) return { text: "Stopped by the sender", tone: "warn" };
  if (item.released === item.total) return { text: "All claimed", tone: "good" };
  if (now < item.cliff) return { text: `Cliff in ${formatDuration(item.cliff - now)}`, tone: "" };
  if (vested === item.total) return { text: "Fully unlocked", tone: "good" };
  return { text: `Unlocking, ${formatDuration(item.end - now)} left`, tone: "" };
}

/** `you` for the connected account, a shortened address for anyone else. */
const who = (formatted: string) => (account?.address === formatted ? "you" : short(formatted));

function buildCard(item: Item): Card {
  const amount = (value: bigint) => `${formatAmount(value, item.meta.decimals)} ${item.meta.symbol}`;
  const mine = account?.address === item.beneficiary;
  const card = element("article", "item");

  const head = element("div", "head");
  const heading = element("div");
  heading.append(
    element("div", "title", amount(item.total)),
    element("div", "from", `Schedule #${item.id} · from ${who(item.creator)} to ${who(item.beneficiary)}`),
  );
  const chip = element("span", "chip");
  head.append(heading, chip);

  // The bar runs from start to end; the mark shows where the cliff is.
  const timeline = element("div", "timeline");
  const bar = element("div", "progress");
  const vestedBar = element("div", "fill soft");
  const releasedBar = element("div", "fill");
  const cliffMark = element("div", "mark");
  cliffMark.style.left = `${((item.cliff - item.start) / (item.end - item.start)) * 100}%`;
  cliffMark.title = `Cliff: ${formatDate(item.cliff)}`;
  bar.append(vestedBar, releasedBar, cliffMark);
  const ticks = element("div", "ticks");
  const tick = (name: string, ms: number) => {
    const node = element("span", "", formatDate(ms));
    node.prepend(element("b", "", name));
    return node;
  };
  ticks.append(tick("Start", item.start), tick("Cliff", item.cliff), tick("End", item.end));
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
  const releasedValue = amountEntry("", "Claimed");
  const releasableValue = amountEntry("soft", "Ready to claim");
  const lockedValue = amountEntry("rest", "Still locked");

  const actions = element("div", "actions");
  const releaseBtn = element("button", "primary");
  releaseBtn.addEventListener("click", () => release(item));
  actions.append(releaseBtn);
  let revokeBtn: HTMLButtonElement | null = null;
  if (item.revocable && !item.revoked && account?.address === item.creator) {
    revokeBtn = element("button");
    revokeBtn.addEventListener("click", () => revoke(item));
    actions.append(revokeBtn);
  }

  const details = element("details");
  const facts = element("dl", "facts");
  fact(facts, "Recipient", item.beneficiary);
  fact(facts, "Sender", item.creator);
  fact(facts, "Token", item.token);
  fact(
    facts,
    "Can be stopped",
    item.revoked ? "It was stopped" : item.revocable ? "Yes, by the sender" : "No",
  );
  details.append(element("summary", "", "Details"), facts);

  card.append(head, timeline, amounts, actions, details);

  const paint = () => {
    const vested = vestedNow(item);
    const releasable = vested - item.released;
    const percent = (value: bigint) =>
      item.total === 0n ? "0%" : `${Number((value * 10_000n) / item.total) / 100}%`;
    const state = status(item, vested);
    chip.textContent = state.text;
    chip.className = `chip ${state.tone}`;
    vestedBar.style.width = percent(vested);
    releasedBar.style.width = percent(item.released);
    releasedValue.textContent = figure(item.released);
    releasableValue.textContent = figure(releasable);
    lockedValue.textContent = figure(item.total - vested);

    // Anyone may trigger a release; the tokens always go to the recipient.
    releaseBtn.hidden = item.released === item.total;
    releaseBtn.textContent =
      releasable === 0n
        ? "Nothing to claim yet"
        : mine
          ? `Claim ${amount(releasable)}`
          : `Send ${amount(releasable)} to the recipient`;
    releaseBtn.disabled = busy || !account || releasable === 0n;
    releaseBtn.title = account ? "" : "Connect a wallet first";
    if (revokeBtn) {
      revokeBtn.textContent = `Stop and take back ${amount(item.total - vested)}`;
      revokeBtn.hidden = vested === item.total;
      revokeBtn.disabled = busy;
    }
  };
  paint();
  return { element: card, paint };
}

async function renderList(target: HTMLElement, ids: bigint[], emptyText: string): Promise<Card[]> {
  if (ids.length === 0) {
    target.replaceChildren(element("p", "empty", emptyText));
    return [];
  }
  target.replaceChildren(element("p", "empty", "Loading…"));
  // Newest first. One read per schedule, one after another: the node proxy is shared.
  const built: Card[] = [];
  for (const id of [...ids].reverse()) {
    built.push(buildCard(await loadItem(id)));
  }
  target.replaceChildren(...built.map((card) => card.element));
  return built;
}

let listVersion = 0;

async function refreshSchedules() {
  const version = ++listVersion;
  if (!account) {
    cards = [];
    schedulesEl.replaceChildren(element("p", "empty", "Connect a wallet to see your schedules."));
    return;
  }
  try {
    const ids = await scheduleIds(tab === "receiving" ? "by_beneficiary" : "by_creator", account.address);
    if (version !== listVersion) return;
    const built = await renderList(
      schedulesEl,
      ids,
      tab === "receiving"
        ? "Nobody has locked tokens for you yet."
        : "You have not locked tokens for anyone yet.",
    );
    if (version === listVersion) cards = built;
  } catch (error) {
    if (version !== listVersion) return;
    cards = [];
    schedulesEl.replaceChildren(element("p", "notice", `Could not load: ${errorText(error)}`));
  }
}

let lookupCard: Card | null = null;

async function lookup(id: bigint) {
  lookupCard = null;
  lookupResult.replaceChildren(element("p", "empty", "Loading…"));
  try {
    const count = await schedulesCount();
    if (id >= count) {
      const text =
        count === 0n ? "No schedule has been created yet." : `Numbers run from 0 to ${count - 1n}.`;
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
  createSubmit.disabled = busy || !account;
  createSubmit.textContent = account ? "Lock tokens" : "Connect a wallet to lock tokens";
}

async function refreshAll() {
  refreshState();
  repaint();
  await Promise.all([refreshBalance(), refreshSchedules()]);
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
    await send(`Claim from schedule #${item.id}`, GAS.release, () => vesting.release(item.id));
  });

const revoke = (item: Item) =>
  withBusy(async () => {
    await send(`Stopping schedule #${item.id}`, GAS.revoke, () => vesting.revoke(item.id));
  });

function showCreateError(text: string) {
  createError.textContent = text;
  createError.hidden = !text;
}

async function create() {
  showCreateError("");
  if (!account) return;

  let beneficiary: string;
  let token: string;
  try {
    beneficiary = parseAddress(fBeneficiary.value);
  } catch {
    return showCreateError("The recipient is not a public key or an account hash.");
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
  const [start, cliff, end] = [fStart, fCliff, fEnd].map((input) => new Date(input.value).getTime());
  if ([start, cliff, end].some(Number.isNaN)) return showCreateError("Fill in all three dates.");
  if (start > cliff || cliff > end || start === end) {
    return showCreateError("The dates must be in order: start, cliff, end.");
  }

  await withBusy(async () => {
    const me = account!.address;
    const cep18 = tokenClient(token);
    const balance = await balanceOf(token, me);
    if (balance < amount) {
      return showCreateError(
        `You have ${formatAmount(balance, meta.decimals)} ${meta.symbol}, less than the amount.`,
      );
    }
    const allowance = await allowanceOf(token, me, vestingAddress);
    if (allowance < amount) {
      const approved = await send("Step 1 of 2, allowing the contract to take the tokens", GAS.approve, () =>
        cep18.approve(address(vestingAddress), U256.fromBigInt(amount)),
      );
      if (!approved) return;
    }
    const created = await send("Step 2 of 2, creating the schedule", GAS.create, () =>
      vesting.createSchedule(
        address(beneficiary),
        address(token),
        U256.fromBigInt(amount),
        BigInt(start),
        BigInt(cliff),
        BigInt(end),
        fRevocable.checked,
      ),
    );
    if (created) {
      fAmount.value = "";
      updateSummary();
      $("step-create").classList.add("done");
      setTab("created");
    }
  });
}

// ---------- Form helpers ----------

const PRESETS: Record<string, { duration: number; cliff: number }> = {
  "10m": { duration: 10 * 60_000, cliff: 2 * 60_000 },
  "1h": { duration: 3_600_000, cliff: 10 * 60_000 },
  "1y": { duration: 365 * 86_400_000, cliff: 91 * 86_400_000 },
  "4y": { duration: 4 * 365 * 86_400_000, cliff: 365 * 86_400_000 },
};

function applyPreset(name: string) {
  const preset = PRESETS[name];
  const now = Date.now();
  fStart.value = toInputValue(now);
  fCliff.value = toInputValue(now + preset.cliff);
  fEnd.value = toInputValue(now + preset.duration);
  markPreset(name);
  updateSummary();
}

/** Highlights the preset the dates were filled from; none once the dates are edited by hand. */
function markPreset(name: string | null) {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-preset]")) {
    button.classList.toggle("active", button.dataset.preset === name);
  }
}

/** Says in a sentence what the schedule in the form will do. */
function updateSummary() {
  const amount = parseAmount(fAmount.value, formMeta.decimals);
  const [start, cliff, end] = [fStart, fCliff, fEnd].map((input) => new Date(input.value).getTime());
  const show = (value: bigint) => `${formatAmount(value, formMeta.decimals)} ${formMeta.symbol}`;

  let text: string;
  if (amount === null || amount === 0n) {
    text = "Enter an amount to see how it unlocks.";
  } else if ([start, cliff, end].some(Number.isNaN)) {
    text = "Fill in the three dates to see how the tokens unlock.";
  } else if (start > cliff || cliff > end || start === end) {
    text = "The dates must be in order: start, cliff, end.";
  } else if (cliff === end) {
    text = `Nothing can be claimed until ${formatDate(end)}. Then all ${show(amount)} unlock at once.`;
  } else if (cliff === start) {
    text = `${show(amount)} unlock evenly from ${formatDate(start)} to ${formatDate(end)}.`;
  } else {
    const atCliff = (amount * BigInt(cliff - start)) / BigInt(end - start);
    text =
      `Nothing can be claimed until ${formatDate(cliff)}. At that moment ${show(atCliff)} unlock at once, ` +
      `and the other ${show(amount - atCliff)} unlock evenly until ${formatDate(end)}.`;
  }
  summaryEl.textContent = text;
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

function setTab(next: "receiving" | "created") {
  tab = next;
  $("tab-receiving").classList.toggle("active", tab === "receiving");
  $("tab-created").classList.toggle("active", tab === "created");
  void refreshSchedules();
}

// ---------- Wallet ----------

async function onAccount(info: AccountInfo) {
  account = { publicKey: info.publicKey, address: key(info.address) };
  accountKey.textContent = short(info.publicKey);
  accountKey.title = info.publicKey;
  connectBtn.hidden = true;
  accountBox.hidden = false;
  if (!fBeneficiary.value) fBeneficiary.value = info.publicKey;
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
  vestingAddress = key(contracts.get("Vesting").address);
  vesting = new VestingWasmClient(client, address(vestingAddress));
  vestingStorage = await ContractStorage.open(vestingSchema, vestingAddress);
  testTokenHash = key(contracts.get("TestToken").address);

  $("contract").textContent = `Vesting contract: ${vestingAddress}.`;
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
  for (const input of [fStart, fCliff, fEnd]) {
    input.addEventListener("input", () => {
      markPreset(null);
      updateSummary();
    });
  }
  $("tab-receiving").addEventListener("click", () => setTab("receiving"));
  $("tab-created").addEventListener("click", () => setTab("created"));
  lookupForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = lookupId.value.trim();
    if (/^\d+$/.test(value)) void lookup(BigInt(value));
  });
  $("tx-close").addEventListener("click", () => (txBox.hidden = true));

  // Vested amounts grow with time: repaint from the local clock, without asking the node.
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
