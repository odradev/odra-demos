import "../../../style/odra.css";
import "./style.css";
import init, {
  AccountInfo,
  Address,
  Contracts,
  CsprClickCallbacks,
  OdraWasmClient,
  setGas,
  SplitterErrors,
  SplitterWasmClient,
  TestTokenErrors,
  TestTokenWasmClient,
  TransactionResult,
  TransactionStatus,
  U256,
} from "splitter-wasm-client";
import splitterSchema from "../../resources/casper_contract_schemas/splitter_schema.json";
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
/** `MAX_PAYEES` of the contract. 40 payees with their shares take about 1.7 KB of the 2 KB a
 * transaction's arguments may take on the testnet. */
const MAX_PAYEES = 40;
const U64_MAX = 2n ** 64n - 1n;

/**
 * Payment limits in motes, from what the calls used (CasperVM, and the testnet for a split of two
 * payees, in November 2026): faucet 0.30 CSPR, approve 0.36, creating a split 0.7 and 0.22 more
 * per payee (1.14 for two, 9.6 for forty), paying in 1.6, withdrawing 1.4. The network refunds
 * three quarters of what a transaction leaves unused.
 */
const GAS = {
  faucet: 2_500_000_000n,
  approve: 2_500_000_000n,
  create: (payees: number) => {
    const limit = 1_500_000_000n + BigInt(payees) * 250_000_000n;
    return limit > 2_500_000_000n ? limit : 2_500_000_000n;
  },
  // Another token may do more work in `transfer_from` than the test token.
  pay: (testToken: boolean) => (testToken ? 3n * CSPR : 5n * CSPR),
  withdraw: 2_500_000_000n,
};

const ERRORS: Record<number, string> = {
  [SplitterErrors.NoPayees]: "The list of payees is empty.",
  [SplitterErrors.TooManyPayees]: `A split has at most ${MAX_PAYEES} payees.`,
  [SplitterErrors.LengthMismatch]: "The list has a payee without a share.",
  [SplitterErrors.ZeroShare]: "One of the shares is zero.",
  [SplitterErrors.DuplicatePayee]: "An account is listed twice.",
  [SplitterErrors.SharesOverflow]: "The shares add up to too much.",
  [SplitterErrors.SplitterAsPayee]: "The splitter contract cannot be a payee.",
  [SplitterErrors.SplitNotFound]: "There is no split with this number.",
  [SplitterErrors.ZeroAmount]: "The amount must be greater than zero.",
  [SplitterErrors.AmountTooLarge]: "The amount is too large for the split to divide.",
  [SplitterErrors.NotPayee]: "You are not a payee of this split.",
  [SplitterErrors.NothingToWithdraw]: "There is nothing for you to withdraw.",
  [TestTokenErrors.InsufficientBalance]: "The token balance is too low.",
  [TestTokenErrors.InsufficientAllowance]: "The token allowance is too low.",
  [TestTokenErrors.CannotTargetSelfUser]: "The token does not allow a transfer to yourself.",
};

// ---------- Types ----------

interface TokenMeta {
  symbol: string;
  decimals: number;
}

interface Payee {
  account: string;
  share: bigint;
}

/** A split as stored: it never changes once created. */
interface SplitInfo {
  id: bigint;
  creator: string;
  totalShares: bigint;
  payees: Payee[];
}

/** What a split has received in one token and what each payee has withdrawn of it. */
interface Flow {
  token: string;
  meta: TokenMeta;
  received: bigint;
  paidOut: bigint;
  released: Map<string, bigint>;
}

/** One line of the list: what was typed and, when it is valid, what it means. */
interface Row {
  line: number;
  text: string;
  account?: string;
  share?: bigint;
  problem?: string;
  note?: string;
}

// ---------- State ----------

let client: OdraWasmClient;
let splitter: SplitterWasmClient;
let splitterStorage: ContractStorage;
let splitterAddress: string;
let testTokenHash: string;
let account: { publicKey: string; address: string } | null = null;
let tab: "paying" | "created" = "paying";
let busy = false;
let rows: Row[] = [];
/** The token the pay form pays in, as a formatted key, and its unit. */
let payToken = "";
let payMeta: TokenMeta = { symbol: "TEST", decimals: 9 };
/** Whether the pay form holds a split and an amount that can be paid. */
let payReady = false;
const splitCache = new Map<bigint, Promise<SplitInfo>>();
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
const createSummary = $("create-summary");
const createHint = $("create-hint");
const fList = $<HTMLTextAreaElement>("f-list");
const previewEl = $("preview");
const payForm = $<HTMLFormElement>("pay");
const pSplit = $<HTMLInputElement>("p-split");
const pAmount = $<HTMLInputElement>("p-amount");
const pToken = $<HTMLInputElement>("p-token");
const pTokenInfo = $("p-token-info");
const paySummary = $("pay-summary");
const payPreview = $("pay-preview");
const payError = $("pay-error");
const paySubmit = $<HTMLButtonElement>("pay-submit");
const splitsEl = $("splits");
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

/** Formats an amount of the smallest unit as a decimal number with up to 4 fraction digits. */
function formatAmount(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = (value / base).toLocaleString("en-US");
  const fraction = (value % base).toString().padStart(decimals, "0").slice(0, 4).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Like `formatAmount`, but shows every digit, so that a few units of dust do not read as zero. */
function formatExact(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = (value / base).toLocaleString("en-US");
  const fraction = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

const amountOf = (meta: TokenMeta) => (value: bigint) =>
  `${formatAmount(value, meta.decimals)} ${meta.symbol}`;

/** Parses a decimal number into the smallest unit; `null` if it is not a valid amount. */
function parseAmount(text: string, decimals: number): bigint | null {
  const match = /^(\d+)(?:[.,](\d+))?$/.exec(text.trim().replace(/[\s_]/g, ""));
  if (!match) return null;
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) return null;
  return BigInt(match[1]) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

/** `share / total` as a percentage with up to two decimals. */
function percent(share: bigint, total: bigint): string {
  if (total === 0n) return "0%";
  return `${(Number((share * 10_000n) / total) / 100).toLocaleString("en-US")}%`;
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

/** `you` for the connected account, a shortened address for anyone else. */
const who = (formatted: string) => (account?.address === formatted ? "you" : short(formatted));

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

/** A table with a header row and the given rows; each cell is text or an element. */
function table(head: string[], body: (string | Node)[][], foot?: string[]): HTMLElement {
  const row = (cells: (string | Node)[], tag: "td" | "th") => {
    const tr = element("tr");
    for (const cell of cells) {
      const td = element(tag);
      td.append(cell);
      tr.append(td);
    }
    return tr;
  };
  const node = element("table");
  const thead = element("thead");
  thead.append(row(head, "th"));
  const tbody = element("tbody");
  tbody.append(...body.map((cells) => row(cells, "td")));
  node.append(thead, tbody);
  if (foot) {
    const tfoot = element("tfoot");
    tfoot.append(row(foot, "td"));
    node.append(tfoot);
  }
  const scroll = element("div", "scroll");
  scroll.append(node);
  return scroll;
}

/** An address cell: shortened, the whole address on hover, `you` for the connected account. */
function accountCell(formatted: string): HTMLElement {
  const name = element("span", "mono", who(formatted));
  name.title = formatted;
  return name;
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

/** A U256 of the splitter stored under `keys`; one never written is zero. */
async function splitterAmount(path: string, keys: string[]): Promise<bigint> {
  return BigInt((await splitterStorage.read(path, keys)) ?? "0");
}

const splitsCount = async () => BigInt((await splitterStorage.read("count")) ?? "0");

/** The ids of the splits listed for `owner` in `by_payee` or `by_creator`. */
async function splitIds(field: "by_payee" | "by_creator", owner: string): Promise<bigint[]> {
  const list = await splitterStorage.read(field, [owner]);
  return (list?.match(/\d+/g) ?? []).map(BigInt);
}

/** A split, read once: a split never changes. Throws if there is no split with this id. */
function loadSplit(id: bigint): Promise<SplitInfo> {
  let found = splitCache.get(id);
  if (!found) {
    found = (async () => {
      const stored = await splitterStorage.read("splits", [id.toString()]);
      if (stored === null) throw new Error(`There is no split ${id}.`);
      // A struct is printed as a JSON object of strings; a list of structs as an array of them.
      const split: { creator: string; total_shares: string; payees: { account: string; share: string }[] } =
        JSON.parse(stored);
      return {
        id,
        creator: formattedKey(split.creator),
        totalShares: BigInt(split.total_shares),
        payees: split.payees.map((payee) => ({
          account: formattedKey(payee.account),
          share: BigInt(payee.share),
        })),
      };
    })();
    found.catch(() => splitCache.delete(id));
    splitCache.set(id, found);
  }
  return found;
}

/** Runs `read` for every item, a few at a time: the node proxy is shared. */
async function inBatches<T, R>(items: T[], read: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += 8) {
    results.push(...(await Promise.all(items.slice(i, i + 8).map(read))));
  }
  return results;
}

/** What the split received in each token paid into it, and what each payee withdrew. */
async function loadFlows(split: SplitInfo): Promise<Flow[]> {
  const listed = await splitterStorage.read("tokens", [split.id.toString()]);
  const tokens = (listed?.match(/Key::(Account|Hash)\([0-9a-f]{64}\)/g) ?? []).map(formattedKey);
  const flows: Flow[] = [];
  for (const token of tokens) {
    const pair = `${split.id}:${token}`;
    const [meta, received, paidOut] = await Promise.all([
      tokenMeta(token),
      splitterAmount("received", [pair]),
      splitterAmount("paid_out", [pair]),
    ]);
    const released = await inBatches(split.payees, (payee) =>
      splitterAmount("released", [`${pair}:${payee.account}`]),
    );
    flows.push({
      token,
      meta,
      received,
      paidOut,
      released: new Map(split.payees.map((payee, i) => [payee.account, released[i]])),
    });
  }
  return flows;
}

/** A payee's part of everything the split received, withdrawn or not: the contract's formula. */
const dueOf = (received: bigint, share: bigint, total: bigint) => (received * share) / total;

/** What a payee can withdraw now. */
const readyOf = (split: SplitInfo, flow: Flow, payee: Payee) =>
  dueOf(flow.received, payee.share, split.totalShares) - (flow.released.get(payee.account) ?? 0n);

// ---------- A split ----------

function renderFlow(split: SplitInfo, flow: Flow): HTMLElement {
  const amount = amountOf(flow.meta);
  const figure = (value: bigint) => formatAmount(value, flow.meta.decimals);
  const box = element("div", "flow");

  // Paid out of everything received; the rest waits in the contract for the payees.
  const bar = element("div", "progress");
  const fill = element("div", "fill");
  fill.style.width =
    flow.received === 0n ? "0%" : `${Number((flow.paidOut * 10_000n) / flow.received) / 100}%`;
  bar.append(fill);
  bar.title = `${amount(flow.paidOut)} of ${amount(flow.received)} withdrawn`;

  const tiles = element("div", "tiles");
  const tile = (dot: string, name: string, value: bigint) => {
    const node = element("div", "tile");
    const label = element("div", "label", name);
    if (dot !== "none") label.prepend(element("span", `dot ${dot}`));
    node.append(label, element("div", "value", figure(value)), element("div", "sub", flow.meta.symbol));
    tiles.append(node);
  };
  tile("none", "Received", flow.received);
  tile("", "Withdrawn", flow.paidOut);
  tile("rest", "Waiting for the payees", flow.received - flow.paidOut);

  const rowsOfTable = split.payees.map((payee) => {
    const released = flow.released.get(payee.account) ?? 0n;
    return [
      percent(payee.share, split.totalShares),
      accountCell(payee.account),
      figure(dueOf(flow.received, payee.share, split.totalShares)),
      figure(released),
      figure(readyOf(split, flow, payee)),
    ];
  });
  box.append(
    bar,
    tiles,
    table(
      ["Share", "Payee", `Their part, ${flow.meta.symbol}`, "Withdrawn", "Can withdraw now"],
      rowsOfTable,
    ),
  );
  return box;
}

/** A split as a card: what it received, who has it, and the reader's own part. */
async function buildCard(id: bigint): Promise<HTMLElement> {
  const split = await loadSplit(id);
  const flows = await loadFlows(split);
  const me = account ? split.payees.find((payee) => payee.account === account!.address) : undefined;
  const card = element("article", "item");

  const head = element("div", "head");
  const heading = element("div");
  const title =
    flows.length === 0
      ? "Nothing paid in yet"
      : `${flows.map((flow) => amountOf(flow.meta)(flow.received)).join(" · ")} received`;
  const people = `${split.payees.length} payee${split.payees.length === 1 ? "" : "s"}`;
  const yours = me ? ` · your share ${percent(me.share, split.totalShares)}` : "";
  heading.append(
    element("div", "title", title),
    element("div", "from", `Split #${id} · created by ${who(split.creator)} · ${people}${yours}`),
  );
  const ready = me ? flows.map((flow) => ({ flow, amount: readyOf(split, flow, me) })) : [];
  const waiting = flows.some((flow) => flow.paidOut < flow.received);
  const chip = ready.some((entry) => entry.amount > 0n)
    ? element("span", "chip good", "Ready for you")
    : flows.length > 0 && !waiting
      ? element("span", "chip good", "All withdrawn")
      : element("span", "chip", flows.length === 0 ? "Waiting for a payment" : "Waiting for the payees");
  head.append(heading, chip);
  card.append(head);

  if (flows.length === 0) {
    card.append(
      table(
        ["Share", "Payee"],
        split.payees.map((payee) => [percent(payee.share, split.totalShares), accountCell(payee.account)]),
      ),
    );
  }
  for (const flow of flows) card.append(renderFlow(split, flow));

  const actions = element("div", "actions");
  let primary = true;
  for (const entry of ready) {
    if (entry.amount === 0n) continue;
    const button = element(
      "button",
      primary ? "primary" : "",
      `Withdraw ${amountOf(entry.flow.meta)(entry.amount)}`,
    );
    primary = false;
    button.disabled = busy;
    button.addEventListener("click", () => withdraw(split, entry.flow, entry.amount));
    actions.append(button);
  }
  const payIn = element("button", "", `Pay into split #${id}`);
  payIn.addEventListener("click", () => {
    pSplit.value = id.toString();
    void refreshPayPreview();
    pAmount.focus();
    pAmount.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  actions.append(payIn);
  card.append(actions);

  const details = element("details");
  const facts = element("dl", "facts");
  const fact = (name: string, value: string) =>
    facts.append(element("dt", "", name), element("dd", "mono", value));
  fact("Created by", split.creator);
  fact("Shares in total", split.totalShares.toString());
  for (const flow of flows) fact(`Token ${flow.meta.symbol}`, flow.token);
  details.append(element("summary", "", "Details"), facts);
  card.append(details);
  return card;
}

let listVersion = 0;

async function refreshSplits() {
  const version = ++listVersion;
  if (!account) {
    splitsEl.replaceChildren(element("p", "empty", "Connect a wallet to see your splits."));
    return;
  }
  try {
    const ids = await splitIds(tab === "paying" ? "by_payee" : "by_creator", account.address);
    if (version !== listVersion) return;
    if (ids.length === 0) {
      const text =
        tab === "paying" ? "No split pays you yet." : "You have not created a split yet. Use the form above.";
      splitsEl.replaceChildren(element("p", "empty", text));
      return;
    }
    splitsEl.replaceChildren(element("p", "empty", "Loading…"));
    // Newest first, one split after another: the node proxy is shared.
    const cards: HTMLElement[] = [];
    for (const id of [...ids].reverse()) {
      cards.push(await buildCard(id));
      if (version !== listVersion) return;
    }
    splitsEl.replaceChildren(...cards);
  } catch (error) {
    if (version !== listVersion) return;
    splitsEl.replaceChildren(element("p", "notice", `Could not load: ${errorText(error)}`));
  }
}

let lookupShown: bigint | null = null;

async function lookup(id: bigint) {
  lookupShown = null;
  lookupResult.replaceChildren(element("p", "empty", "Loading…"));
  try {
    const count = await splitsCount();
    if (id >= count) {
      const text = count === 0n ? "No split has been created yet." : `Numbers run from 0 to ${count - 1n}.`;
      lookupResult.replaceChildren(element("p", "empty", text));
      return;
    }
    lookupResult.replaceChildren(await buildCard(id));
    lookupShown = id;
  } catch (error) {
    lookupResult.replaceChildren(element("p", "notice", `Could not load: ${errorText(error)}`));
  }
}

function setTab(next: "paying" | "created") {
  tab = next;
  $("tab-paying").classList.toggle("active", tab === "paying");
  $("tab-created").classList.toggle("active", tab === "created");
  void refreshSplits();
}

// ---------- Creating a split ----------

/** Reads the textarea into rows: an address and a share per line, separated by commas or spaces. */
function parseList(): Row[] {
  const parsed: Row[] = [];
  const seen = new Map<string, number>();
  fList.value.split("\n").forEach((raw, index) => {
    const text = raw.trim();
    if (!text) return;
    const row: Row = { line: index + 1, text };
    const parts = text.split(/[\s,;]+/).filter(Boolean);
    if (parts.length !== 2) {
      row.problem = "Expected an address and a share";
    } else {
      try {
        row.account = parseAddress(parts[0]);
      } catch {
        row.problem = "Not an address";
      }
      const share = /^\d+$/.test(parts[1]) ? BigInt(parts[1]) : null;
      if (!row.problem && share === null) {
        row.problem = "The share must be a whole number";
      } else if (!row.problem && share === 0n) {
        row.problem = "The share is zero";
      } else if (!row.problem && share! > U64_MAX) {
        row.problem = "The share is too large";
      } else if (!row.problem && row.account === splitterAddress) {
        row.problem = "This is the splitter contract itself";
      } else if (!row.problem && seen.has(row.account!)) {
        row.problem = `Listed already, on line ${seen.get(row.account!)}`;
      } else if (!row.problem && row.account!.startsWith("hash-")) {
        row.note = "A contract: it must call withdraw itself";
      }
      if (!row.problem) seen.set(row.account!, row.line);
      row.share = share ?? undefined;
    }
    parsed.push(row);
  });
  return parsed;
}

const validRows = () => rows.filter((row) => !row.problem);
const totalShares = () => validRows().reduce((sum, row) => sum + row.share!, 0n);

/** What stops the list from being created, or an empty string when it can be. */
function blocker(): string {
  if (rows.length === 0) return "Paste at least one payee.";
  const broken = rows.filter((row) => row.problem);
  if (broken.length > 0) {
    const lines = broken.map((row) => row.line).join(", ");
    return `Fix line${broken.length === 1 ? "" : "s"} ${lines} first; see the list on the right.`;
  }
  if (rows.length > MAX_PAYEES)
    return `A split has at most ${MAX_PAYEES} payees; this list has ${rows.length}.`;
  if (totalShares() > U64_MAX) return "The shares add up to too much. Use smaller numbers.";
  return "";
}

function renderPreview() {
  if (rows.length === 0) {
    previewEl.replaceChildren(element("p", "empty", "Nothing yet. Paste a list on the left."));
    return;
  }
  const total = totalShares();
  const body = rows.map((row) => {
    if (row.problem) {
      const cell = element("span");
      cell.append(
        element("span", "mono", row.text.slice(0, 40)),
        " ",
        element("span", "chip warn", row.problem),
      );
      return ["—", cell, "—"];
    }
    const cell = element("span");
    cell.append(accountCell(row.account!));
    if (row.note) cell.append(" ", element("span", "chip", row.note));
    return [percent(row.share!, total), cell, row.share!.toString()];
  });
  const count = validRows().length;
  previewEl.replaceChildren(
    table(["Of every payment", "Payee", "Shares"], body, [
      "100%",
      `${count} payee${count === 1 ? "" : "s"}`,
      total.toString(),
    ]),
  );
}

function renderCreateSummary() {
  const stop = blocker();
  const count = rows.length;
  const people = `${count} payee${count === 1 ? "" : "s"}`;
  if (stop) {
    createSummary.textContent = stop;
    createSubmit.textContent = account ? "Create the split" : "Connect a wallet to create a split";
  } else {
    const mine = account ? validRows().find((row) => row.account === account!.address) : undefined;
    const yours = mine ? ` You get ${percent(mine.share!, totalShares())} of every payment.` : "";
    createSummary.textContent =
      `A new split of ${people}. Every payment into it is divided by the shares on the right, ` +
      `and each payee withdraws their part when they like.${yours}`;
    createSubmit.textContent = account ? `Create a split of ${people}` : "Connect a wallet to create a split";
  }
  createSubmit.disabled = busy || !account || stop !== "";
  createHint.textContent =
    `Your wallet will ask once. The network takes up to ${formatAmount(GAS.create(count), 9)} CSPR ` +
    "as a fee and refunds most of what is not used.";
}

function refreshList() {
  rows = parseList();
  renderPreview();
  renderCreateSummary();
}

/** You and two accounts made up on the spot: nobody holds their keys. */
function fillExample() {
  const randomAccount = () =>
    "account-hash-" +
    [...crypto.getRandomValues(new Uint8Array(32))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  const first = account ? account.publicKey : randomAccount();
  fList.value = [`${first}, 50`, `${randomAccount()}, 30`, `${randomAccount()}, 20`].join("\n");
  pAmount.value = "100";
  refreshList();
  fList.scrollIntoView({ behavior: "smooth", block: "center" });
}

function showCreateError(text: string) {
  createError.textContent = text;
  createError.hidden = !text;
}

async function create() {
  showCreateError("");
  refreshList();
  if (!account || blocker()) return;
  const list = validRows().map((row) => ({ account: row.account!, share: row.share! }));
  const people = `${list.length} payee${list.length === 1 ? "" : "s"}`;

  await withBusy(async () => {
    const me = account!.address;
    const before = (await splitIds("by_creator", me)).length;
    const created = await send(`Creating a split of ${people}`, GAS.create(list.length), () =>
      splitter.createSplit(
        list.map((entry) => address(entry.account)),
        BigUint64Array.from(list.map((entry) => entry.share)),
      ),
    );
    if (!created) return;
    // The new split is the last one listed for its creator.
    refreshState();
    const ids = await splitIds("by_creator", me);
    const id = ids.length > before ? ids[ids.length - 1] : null;
    fList.value = "";
    $("step-split").classList.add("done");
    if (id !== null) {
      pSplit.value = id.toString();
      showTx(`Split #${id} created. Pay into it with the form below.`);
    }
    tab = "created";
  });
}

// ---------- Paying in ----------

let payVersion = 0;

/** The split, the amount and the token the pay form is filled in with, when they are valid. */
async function payInput(): Promise<{ split: SplitInfo; amount: bigint } | string> {
  const typed = pSplit.value.trim();
  if (!/^\d+$/.test(typed)) return "Enter the number of a split.";
  let split: SplitInfo;
  try {
    split = await loadSplit(BigInt(typed));
  } catch {
    return `There is no split #${typed}.`;
  }
  const amount = parseAmount(pAmount.value, payMeta.decimals);
  if (amount === null || amount === 0n) return "Enter an amount to see how it will be divided.";
  return { split, amount };
}

/** Shows how the amount in the form would be divided, with the contract's rounding. */
async function refreshPayPreview() {
  const version = ++payVersion;
  const input = await payInput();
  if (version !== payVersion) return;
  const symbol = payMeta.symbol;
  payReady = false;
  if (typeof input === "string") {
    paySummary.textContent = input;
    payPreview.replaceChildren();
    paySubmit.textContent = "Pay in";
    paySubmit.disabled = true;
    return;
  }
  const { split, amount } = input;
  let received: bigint;
  try {
    received = await splitterAmount("received", [`${split.id}:${payToken}`]);
  } catch (error) {
    paySummary.textContent = `Could not read the split: ${errorText(error)}`;
    return;
  }
  if (version !== payVersion) return;

  // Each payee's part grows from what it was to what it will be: the same rounding as the contract.
  const gains = split.payees.map(
    (payee) =>
      dueOf(received + amount, payee.share, split.totalShares) -
      dueOf(received, payee.share, split.totalShares),
  );
  const dust = amount - gains.reduce((sum, gain) => sum + gain, 0n);
  const what = amountOf(payMeta)(amount);
  paySummary.textContent =
    `${what} go into split #${split.id} and are divided among ${split.payees.length} ` +
    `payee${split.payees.length === 1 ? "" : "s"} as below.` +
    (dust > 0n
      ? ` ${formatExact(dust, payMeta.decimals)} ${symbol} cannot be divided evenly and stays in the split ` +
        "until a later payment makes it divisible."
      : "");
  payPreview.replaceChildren(
    table(
      ["Share", "Payee", `Gets, ${symbol}`],
      split.payees.map((payee, i) => [
        percent(payee.share, split.totalShares),
        accountCell(payee.account),
        formatExact(gains[i], payMeta.decimals),
      ]),
    ),
  );
  paySubmit.textContent = account ? `Pay ${what} into split #${split.id}` : "Connect a wallet to pay in";
  payReady = true;
  paySubmit.disabled = busy || !account;
}

function showPayError(text: string) {
  payError.textContent = text;
  payError.hidden = !text;
}

async function pay() {
  showPayError("");
  if (!account) return;
  const input = await payInput();
  if (typeof input === "string") return showPayError(input);
  const { split, amount } = input;
  const token = payToken;
  const meta = payMeta;
  const what = amountOf(meta)(amount);

  await withBusy(async () => {
    const me = account!.address;
    const balance = await balanceOf(token, me);
    if (balance < amount) return showPayError(`You have ${amountOf(meta)(balance)}, less than ${what}.`);
    if ((await allowanceOf(token, me, splitterAddress)) < amount) {
      const approved = await send("Step 1 of 2, allowing the contract to take the tokens", GAS.approve, () =>
        tokenClient(token).approve(address(splitterAddress), U256.fromBigInt(amount)),
      );
      if (!approved) return;
    }
    const paid = await send(
      `Step 2 of 2, paying ${what} into split #${split.id}`,
      GAS.pay(token === testTokenHash),
      () => splitter.pay(split.id, address(token), U256.fromBigInt(amount)),
    );
    if (paid) {
      pAmount.value = "";
      lookupId.value = split.id.toString();
      lookupShown = split.id;
    }
  });
}

/** Takes the token typed in the form, or goes back to the test token when the field is empty. */
async function setPayToken() {
  const typed = pToken.value.trim();
  let next = testTokenHash;
  pTokenInfo.textContent = "";
  if (typed) {
    try {
      next = parseAddress(typed);
    } catch {
      pTokenInfo.textContent = "Not a contract address (hash-…).";
      return;
    }
  }
  const found = await tokenMeta(next);
  if (pToken.value.trim() !== typed) return;
  payToken = next;
  payMeta = found;
  if (typed) pTokenInfo.textContent = `${found.symbol}, ${found.decimals} decimals`;
  $("p-symbol").textContent = found.symbol;
  await refreshPayPreview();
}

// ---------- Withdrawing ----------

const withdraw = (split: SplitInfo, flow: Flow, amount: bigint) =>
  withBusy(async () => {
    await send(`Withdrawing ${amountOf(flow.meta)(amount)} from split #${split.id}`, GAS.withdraw, () =>
      splitter.withdraw(split.id, address(flow.token)),
    );
  });

// ---------- Balance ----------

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
  connectBtn.disabled = busy;
  faucetBtn.disabled = busy || !account;
  for (const button of document.querySelectorAll<HTMLButtonElement>(".item .actions button")) {
    button.disabled = busy;
  }
  renderCreateSummary();
  paySubmit.disabled = busy || !account || !payReady;
}

async function refreshAll() {
  refreshState();
  repaint();
  $("tab-paying").classList.toggle("active", tab === "paying");
  $("tab-created").classList.toggle("active", tab === "created");
  await Promise.all([refreshBalance(), refreshSplits(), refreshPayPreview()]);
  if (lookupShown !== null) await lookup(lookupShown);
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

// ---------- Wallet ----------

async function onAccount(info: AccountInfo) {
  account = { publicKey: info.publicKey, address: key(info.address) };
  accountKey.textContent = short(info.publicKey);
  accountKey.title = info.publicKey;
  connectBtn.hidden = true;
  accountBox.hidden = false;
  refreshList();
  await refreshAll();
}

async function onSignedOut() {
  account = null;
  connectBtn.hidden = false;
  accountBox.hidden = true;
  refreshList();
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
  splitterAddress = key(contracts.get("Splitter").address);
  splitter = new SplitterWasmClient(client, address(splitterAddress));
  splitterStorage = await ContractStorage.open(splitterSchema, splitterAddress);
  testTokenHash = key(contracts.get("TestToken").address);
  payToken = testTokenHash;

  $("contract").textContent = `Splitter contract: ${splitterAddress}.`;
  $("max-payees").textContent = String(MAX_PAYEES);
  refreshList();
  void setPayToken();

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
  fList.addEventListener("input", refreshList);
  createForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void create();
  });
  for (const input of [pSplit, pAmount]) input.addEventListener("input", () => void refreshPayPreview());
  pToken.addEventListener("change", () => void setPayToken());
  payForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void pay();
  });
  $("tab-paying").addEventListener("click", () => setTab("paying"));
  $("tab-created").addEventListener("click", () => setTab("created"));
  lookupForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = lookupId.value.trim();
    if (/^\d+$/.test(value)) void lookup(BigInt(value));
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
