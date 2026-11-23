import "../../../style/odra.css";
import "./style.css";
import init, {
  AccountInfo,
  Address,
  Contracts,
  CrowdfundingErrors,
  CrowdfundingWasmClient,
  CsprClickCallbacks,
  OdraWasmClient,
  setGas,
  TestTokenErrors,
  TestTokenWasmClient,
  TransactionResult,
  TransactionStatus,
  U256,
} from "crowdfunding-wasm-client";
import crowdfundingSchema from "../../resources/casper_contract_schemas/crowdfunding_schema.json";
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
 * Payment limits of the transactions the app sends, in motes. On CasperVM `faucet` uses 0.30
 * CSPR, `approve` 0.36, `create_campaign` 0.90, `pledge` 1.82 and `claim` 1.26.
 */
const GAS = {
  faucet: 3n * CSPR,
  approve: 3n * CSPR,
  create: 3n * CSPR,
  pledge: 5n * CSPR,
  claim: 5n * CSPR,
  refund: 5n * CSPR,
};
/** The longest title the contract takes, in characters (`MAX_TITLE_LENGTH`). */
const MAX_TITLE = 64;
/** Campaigns loaded at a time in a list. */
const PAGE = 10;
/** How long after the deadline claiming and taking back are enabled; see `buildCard`. */
const SETTLE_MS = 30_000;

const ERRORS: Record<number, string> = {
  [CrowdfundingErrors.ZeroGoal]: "The goal must be greater than zero.",
  [CrowdfundingErrors.DeadlineNotInFuture]: "The deadline must be in the future.",
  [CrowdfundingErrors.InvalidTitle]: `The title must have between 1 and ${MAX_TITLE} characters.`,
  [CrowdfundingErrors.CampaignNotFound]: "There is no campaign with this number.",
  [CrowdfundingErrors.ZeroAmount]: "The amount must be greater than zero.",
  [CrowdfundingErrors.CampaignEnded]: "The campaign has ended: it takes no more pledges.",
  [CrowdfundingErrors.CampaignNotEnded]: "The campaign has not ended yet.",
  [CrowdfundingErrors.NotCreator]: "Only the creator of the campaign can claim it.",
  [CrowdfundingErrors.GoalNotReached]: "The pledges did not reach the goal.",
  [CrowdfundingErrors.AlreadyClaimed]: "The pledges have been claimed already.",
  [CrowdfundingErrors.GoalReached]: "The campaign reached its goal: pledges go to the creator.",
  [CrowdfundingErrors.NothingToRefund]: "You have no pledge to take back in this campaign.",
  [TestTokenErrors.InsufficientBalance]: "The token balance is too low.",
  [TestTokenErrors.InsufficientAllowance]: "The token allowance is too low.",
};

// ---------- Types ----------

interface TokenMeta {
  symbol: string;
  decimals: number;
}

/** A campaign as plain values, read once from the contract. */
interface Item {
  id: bigint;
  creator: string;
  token: string;
  title: string;
  goal: bigint;
  createdAt: number;
  deadline: number;
  pledged: bigint;
  claimed: boolean;
  meta: TokenMeta;
  /** What the connected account has pledged and not taken back; `null` if it never pledged. */
  mine: bigint | null;
}

/** A rendered view: the element and the function that refreshes what changes with time. */
interface Card {
  element: HTMLElement;
  paint: () => void;
}

type Tab = "all" | "mine" | "backed";
type State = "open" | "funded" | "failed" | "claimed";

// ---------- State ----------

let client: OdraWasmClient;
let crowdfunding: CrowdfundingWasmClient;
let storage: ContractStorage;
let crowdfundingAddress: string;
let testTokenHash: string;
let account: { publicKey: string; address: string } | null = null;
let busy = false;
let tab: Tab = "all";
let cards: Card[] = [];
/** Ids of the current list, newest first, and how many of them are shown. */
let listIds: bigint[] = [];
let shown = 0;
/** The token the form is filled in for: the unit of the goal and of the summary. */
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
const fTitle = $<HTMLInputElement>("f-title");
const fGoal = $<HTMLInputElement>("f-goal");
const fToken = $<HTMLInputElement>("f-token");
const fTokenInfo = $("f-token-info");
const fDeadline = $<HTMLInputElement>("f-deadline");
const summaryEl = $("summary");
const listEl = $("campaigns");
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

/** The share of the goal pledged, in whole percent, rounded down. */
const percent = (pledged: bigint, goal: bigint) => (goal === 0n ? 0 : Number((pledged * 100n) / goal));

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
  let opened = tokenStorages.get(token);
  if (!opened) {
    opened = ContractStorage.open(testTokenSchema, token);
    opened.catch(() => tokenStorages.delete(token));
    tokenStorages.set(token, opened);
  }
  return opened;
}

/** The symbol and decimals of a token. A token that cannot be read is shown in raw units. */
function tokenMeta(token: string): Promise<TokenMeta> {
  let meta = tokenMetas.get(token);
  if (!meta) {
    meta = (async () => {
      try {
        const opened = await tokenStorage(token);
        const symbol = await opened.read("token.symbol");
        const decimals = await opened.read("token.decimals");
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

/** The ids of the campaigns `account` started (`by_creator`) or backed (`by_backer`). */
async function campaignIds(field: "by_creator" | "by_backer", owner: string): Promise<bigint[]> {
  const list = await storage.read(field, [owner]);
  return (list?.match(/\d+/g) ?? []).map(BigInt);
}

/** Every campaign id, from `count`. */
async function allIds(): Promise<bigint[]> {
  const count = BigInt((await storage.read("count")) ?? "0");
  return Array.from({ length: Number(count) }, (_, index) => BigInt(index));
}

async function loadItem(id: bigint): Promise<Item> {
  const stored = await storage.read("campaigns", [id.toString()]);
  if (stored === null) throw new Error(`There is no campaign ${id}.`);
  // A struct is printed as a JSON object whose values are all strings.
  const campaign: Record<string, string> = JSON.parse(stored);
  const token = formattedKey(campaign.token);
  const mine = account ? await storage.read("pledges", [`${id}:${account.address}`]) : null;
  return {
    id,
    creator: formattedKey(campaign.creator),
    token,
    title: campaign.title,
    goal: BigInt(campaign.goal),
    createdAt: Number(campaign.created_at),
    deadline: Number(campaign.deadline),
    pledged: BigInt(campaign.pledged),
    claimed: campaign.claimed === "true",
    meta: await tokenMeta(token),
    mine: mine === null ? null : BigInt(mine),
  };
}

/** Loads campaigns one after another: the node proxy is shared. */
async function loadItems(ids: bigint[]): Promise<Item[]> {
  const items: Item[] = [];
  for (const id of ids) items.push(await loadItem(id));
  return items;
}

/** The state of a campaign on the local clock, by the same rules as the contract. */
function stateOf(item: Item, now = Date.now()): State {
  if (item.claimed) return "claimed";
  if (now < item.deadline) return "open";
  return item.pledged >= item.goal ? "funded" : "failed";
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

const amountText = (item: Item, value: bigint) =>
  `${formatAmount(value, item.meta.decimals)} ${item.meta.symbol}`;

const CHIPS: Record<State, { text: string; tone: "" | "good" | "warn" }> = {
  open: { text: "Open", tone: "" },
  funded: { text: "Funded", tone: "good" },
  failed: { text: "Failed", tone: "warn" },
  claimed: { text: "Claimed", tone: "" },
};

/** One campaign: how far it has got, what the connected account pledged, and what it can do. */
function buildCard(item: Item): Card {
  const card = element("article", "item");
  const mineToCreator = account?.address === item.creator;

  const head = element("div", "head");
  const heading = element("div");
  // The title comes from whoever created the campaign: text only, never markup.
  heading.append(
    element("div", "title", item.title),
    element("div", "from", `Campaign #${item.id} · started by ${who(item.creator)}`),
  );
  const chip = element("span", "chip");
  head.append(heading, chip);

  const tiles = element("div", "tiles");
  const tile = (name: string) => {
    const node = element("div", "tile");
    const value = element("div", "value");
    const sub = element("div", "sub");
    node.append(element("div", "label", name), value, sub);
    tiles.append(node);
    return { value, sub };
  };
  const raised = tile("Pledged");
  raised.value.textContent = amountText(item, item.pledged);
  raised.sub.textContent = `${percent(item.pledged, item.goal)}% of the ${amountText(item, item.goal)} goal`;
  const time = tile("Time left");
  const yours = tile("Your pledge");

  // The bar runs from nothing to the goal; pledges past the goal fill it.
  const bar = element("div", "progress");
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-label", "Pledged towards the goal");
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  bar.setAttribute("aria-valuenow", Math.min(100, percent(item.pledged, item.goal)).toString());
  const fill = element("div", "fill");
  fill.style.width = `${Math.min(100, percent(item.pledged, item.goal))}%`;
  bar.append(fill);

  const actions = element("div", "actions");
  const pledgeForm = element("form", "inline");
  const pledgeInput = element("input");
  pledgeInput.inputMode = "decimal";
  pledgeInput.placeholder = `Amount, ${item.meta.symbol}`;
  pledgeInput.required = true;
  pledgeInput.setAttribute("aria-label", `Amount to pledge, ${item.meta.symbol}`);
  const pledgeBtn = element("button");
  const pledgeText = () => {
    const amount = parseAmount(pledgeInput.value, item.meta.decimals);
    pledgeBtn.textContent = amount ? `Back this with ${amountText(item, amount)}` : "Back this";
  };
  pledgeInput.addEventListener("input", pledgeText);
  pledgeText();
  pledgeForm.append(pledgeInput, pledgeBtn);
  pledgeForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void pledge(item, pledgeInput.value);
  });
  const claimBtn = element("button", "", `Claim ${amountText(item, item.pledged)}`);
  claimBtn.addEventListener("click", () => claim(item));
  const refundBtn = element("button", "", `Take your ${amountText(item, item.mine ?? 0n)} back`);
  refundBtn.addEventListener("click", () => refund(item));
  const note = element("p", "hint");
  actions.append(pledgeForm, claimBtn, refundBtn, note);

  const details = element("details");
  const facts = element("dl", "facts");
  fact(facts, "Started by", item.creator);
  fact(facts, "Token", item.token);
  fact(facts, "Started on", formatDate(item.createdAt));
  fact(facts, "Deadline", formatDate(item.deadline));
  details.append(element("summary", "", "Details"), facts);

  card.append(head, tiles, bar, actions, details);

  const paint = () => {
    const now = Date.now();
    const state = stateOf(item, now);
    chip.textContent = CHIPS[state].text;
    chip.className = `chip ${CHIPS[state].tone}`;

    time.value.textContent = state === "open" ? formatDuration(item.deadline - now) : "Ended";
    time.sub.textContent = `${state === "open" ? "Ends" : "Ended"} ${formatDate(item.deadline)}`;

    if (!account) {
      yours.value.textContent = "—";
      yours.sub.textContent = "Connect a wallet to see it";
    } else if (item.mine === null) {
      yours.value.textContent = "None";
      yours.sub.textContent = state === "open" ? "You have not backed this" : "You did not back this";
    } else if (item.mine === 0n) {
      yours.value.textContent = "Taken back";
      yours.sub.textContent = "Your pledge is back in your wallet";
    } else {
      yours.value.textContent = amountText(item, item.mine);
      yours.sub.textContent =
        state === "failed"
          ? "The goal was missed: take it back"
          : state === "open"
            ? "Pledged"
            : "Went to the creator";
    }

    const canPledge = state === "open" && account !== null;
    const canClaim = state === "funded" && mineToCreator;
    const canRefund = state === "failed" && item.mine !== null && item.mine > 0n;
    pledgeForm.hidden = !canPledge;
    claimBtn.hidden = !canClaim;
    refundBtn.hidden = !canRefund;
    note.textContent =
      state === "open" && !account
        ? "Connect a wallet to back this campaign."
        : state === "funded" && !mineToCreator
          ? "The goal was reached: the pledges go to the creator."
          : state === "failed" && !canRefund
            ? "The goal was missed: every backer can take their pledge back."
            : "";
    note.hidden = !note.textContent;
    actions.hidden = !canPledge && !canClaim && !canRefund && note.hidden;
    // Block time trails the clock of the page: a claim sent the moment the deadline passes could
    // run in a block timed before it, fail and still cost its gas.
    const settled = now >= item.deadline + SETTLE_MS;
    pledgeBtn.disabled = busy;
    claimBtn.disabled = busy || !settled;
    refundBtn.disabled = busy || !settled;
  };
  paint();
  return { element: card, paint };
}

const EMPTY: Record<Tab, string> = {
  all: "No campaign has been started yet.",
  mine: "You have not started a campaign yet.",
  backed: "You have not backed a campaign yet.",
};

const NOTES: Record<Tab, string> = {
  all: "Newest first. Anyone can read them, no wallet needed.",
  mine: "Campaigns you started, newest first.",
  backed: "Campaigns you pledged to, newest first, with your pledge in each.",
};

let listVersion = 0;

/** Reloads the ids of the current tab and shows the first page of them. */
async function refreshList() {
  const version = ++listVersion;
  listNote.textContent = NOTES[tab];
  if (tab !== "all" && !account) {
    cards = [];
    listIds = [];
    moreBtn.hidden = true;
    listEl.replaceChildren(element("p", "empty", "Connect a wallet to see your campaigns."));
    return;
  }
  try {
    const ids =
      tab === "all"
        ? await allIds()
        : await campaignIds(tab === "mine" ? "by_creator" : "by_backer", account!.address);
    if (version !== listVersion) return;
    // Ids grow with time: the highest is the newest.
    listIds = ids.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    if (listIds.length === 0) {
      cards = [];
      moreBtn.hidden = true;
      listEl.replaceChildren(element("p", "empty", EMPTY[tab]));
      return;
    }
    if (cards.length === 0) listEl.replaceChildren(element("p", "empty", "Loading…"));
    const count = Math.max(PAGE, shown);
    const built = (await loadItems(listIds.slice(0, count))).map(buildCard);
    if (version !== listVersion) return;
    cards = built;
    shown = built.length;
    listEl.replaceChildren(...built.map((card) => card.element));
    moreBtn.hidden = shown >= listIds.length;
  } catch (error) {
    if (version !== listVersion) return;
    cards = [];
    moreBtn.hidden = true;
    listEl.replaceChildren(element("p", "notice", `Could not load: ${errorText(error)}`));
  }
}

async function showMore() {
  const version = listVersion;
  moreBtn.disabled = true;
  try {
    const built = (await loadItems(listIds.slice(shown, shown + PAGE))).map(buildCard);
    if (version !== listVersion) return;
    cards.push(...built);
    shown += built.length;
    listEl.append(...built.map((card) => card.element));
    moreBtn.hidden = shown >= listIds.length;
  } catch (error) {
    showTx(`Could not load more: ${errorText(error)}`, { error: true });
  } finally {
    moreBtn.disabled = false;
  }
}

function selectTab(next: Tab) {
  if (next === tab) return;
  tab = next;
  shown = 0;
  cards = [];
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
    const active = button.dataset.tab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  }
  void refreshList();
}

async function refreshBalance() {
  $("step-connect").classList.toggle("done", account !== null);
  if (!account) {
    balanceEl.textContent = "—";
    $("step-faucet").classList.remove("done");
    $("step-back").classList.remove("done");
    return;
  }
  try {
    const [balance, backed, started] = await Promise.all([
      balanceOf(testTokenHash, account.address),
      campaignIds("by_backer", account.address),
      campaignIds("by_creator", account.address),
    ]);
    balanceEl.textContent = `${formatAmount(balance, 9)} TEST`;
    $("step-faucet").classList.toggle("done", balance > 0n || backed.length > 0);
    $("step-back").classList.toggle("done", backed.length > 0 || started.length > 0);
  } catch (error) {
    balanceEl.textContent = "?";
    console.error(error);
  }
}

function repaint() {
  for (const card of cards) card.paint();
  connectBtn.disabled = busy;
  faucetBtn.disabled = busy || !account;
  createSubmit.disabled = busy || !account;
  updateSummary();
}

async function refreshAll() {
  refreshState();
  repaint();
  await Promise.all([refreshBalance(), refreshList()]);
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

function pledge(item: Item, text: string) {
  if (!account) return;
  const amount = parseAmount(text, item.meta.decimals);
  if (amount === null || amount === 0n) {
    return showTx(`Enter an amount above zero with up to ${item.meta.decimals} decimals.`, { error: true });
  }
  if (Date.now() >= item.deadline) return showTx("The campaign has ended.", { error: true });
  const label = amountText(item, amount);
  return withBusy(async () => {
    const me = account!.address;
    const balance = await balanceOf(item.token, me);
    if (balance < amount) {
      return showTx(`You have ${amountText(item, balance)}, less than ${label}.`, { error: true });
    }
    const allowance = await allowanceOf(item.token, me, crowdfundingAddress);
    if (allowance < amount) {
      const approved = await send("Step 1 of 2, allowing the contract to take the tokens", GAS.approve, () =>
        tokenClient(item.token).approve(address(crowdfundingAddress), U256.fromBigInt(amount)),
      );
      if (!approved) return;
    }
    const done = await send(`Step 2 of 2, backing campaign #${item.id} with ${label}`, GAS.pledge, () =>
      crowdfunding.pledge(item.id, U256.fromBigInt(amount)),
    );
    if (done) $("step-back").classList.add("done");
  });
}

const claim = (item: Item) =>
  withBusy(async () => {
    await send(`Claiming ${amountText(item, item.pledged)} from campaign #${item.id}`, GAS.claim, () =>
      crowdfunding.claim(item.id),
    );
  });

const refund = (item: Item) =>
  withBusy(async () => {
    await send(
      `Taking your ${amountText(item, item.mine ?? 0n)} back from campaign #${item.id}`,
      GAS.refund,
      () => crowdfunding.refund(item.id),
    );
  });

function showCreateError(text: string) {
  createError.textContent = text;
  createError.hidden = !text;
}

/** The token, title, goal and deadline in the form, or why the campaign cannot be started. */
function readForm(): { token: string; title: string; goal: bigint; deadline: number } | string {
  let token: string;
  try {
    token = parseAddress(fToken.value);
  } catch {
    return "The token is not a contract address (hash-…).";
  }
  const title = fTitle.value.trim();
  if (!title) return "Give the campaign a title.";
  if ([...title].length > MAX_TITLE) return `The title can have at most ${MAX_TITLE} characters.`;
  const goal = parseAmount(fGoal.value, formMeta.decimals);
  if (goal === null || goal === 0n) {
    return `The goal must be a number above zero with up to ${formMeta.decimals} decimals.`;
  }
  const deadline = new Date(fDeadline.value).getTime();
  if (Number.isNaN(deadline)) return "Pick the deadline.";
  if (deadline <= Date.now()) return "The deadline must be in the future.";
  return { token, title, goal, deadline };
}

async function create() {
  showCreateError("");
  if (!account) return;
  await describeToken();
  const form = readForm();
  if (typeof form === "string") return showCreateError(form);
  const { token, title, goal, deadline } = form;

  await withBusy(async () => {
    const done = await send("Starting the campaign", GAS.create, () =>
      crowdfunding.createCampaign(address(token), title, U256.fromBigInt(goal), BigInt(deadline)),
    );
    if (done) {
      fTitle.value = "";
      fGoal.value = "";
      $("step-back").classList.add("done");
      selectTab("mine");
    }
  });
}

// ---------- Form helpers ----------

const PRESETS: Record<string, number> = {
  "10m": 10 * 60_000,
  "1d": 86_400_000,
  "1w": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

function applyPreset(name: string) {
  fDeadline.value = toInputValue(Date.now() + PRESETS[name]);
  markPreset(name);
  updateSummary();
}

/** Highlights the preset the date was filled from; none once the date is edited by hand. */
function markPreset(name: string | null) {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-preset]")) {
    button.classList.toggle("active", button.dataset.preset === name);
  }
}

/** Says in a sentence what the campaign in the form will do, and names the button after it. */
function updateSummary() {
  const form = readForm();
  if (typeof form === "string") {
    const started = fTitle.value.trim() || fGoal.value.trim();
    summaryEl.textContent = started ? form : "Enter a title and a goal to see what will happen.";
    createSubmit.textContent = account ? "Start the campaign" : "Connect a wallet to start a campaign";
    return;
  }
  const goal = `${formatAmount(form.goal, formMeta.decimals)} ${formMeta.symbol}`;
  const until = formatDate(form.deadline);
  summaryEl.textContent =
    `Anyone can back it with ${formMeta.symbol} until ${until}, ${formatDuration(form.deadline - Date.now())} ` +
    `from now. If the pledges reach ${goal} by then, you claim all of them; if not, every backer takes ` +
    "their pledge back.";
  createSubmit.textContent = account
    ? `Start a campaign for ${goal} by ${until}`
    : "Connect a wallet to start a campaign";
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
  $("f-goal-symbol").textContent = meta.symbol;
  updateSummary();
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
  crowdfundingAddress = key(contracts.get("Crowdfunding").address);
  crowdfunding = new CrowdfundingWasmClient(client, address(crowdfundingAddress));
  storage = await ContractStorage.open(crowdfundingSchema, crowdfundingAddress);
  testTokenHash = key(contracts.get("TestToken").address);

  $("contract").textContent = `Crowdfunding contract: ${crowdfundingAddress}.`;
  fToken.value = testTokenHash;
  applyPreset("10m");
  void describeToken();
  // A visitor sees every campaign straight away, without a wallet.
  void refreshList();

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
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
    button.addEventListener("click", () => selectTab(button.dataset.tab as Tab));
  }
  moreBtn.addEventListener("click", () => void showMore());
  fToken.addEventListener("change", () => void describeToken());
  fTitle.addEventListener("input", updateSummary);
  fGoal.addEventListener("input", updateSummary);
  fDeadline.addEventListener("input", () => {
    markPreset(null);
    updateSummary();
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
