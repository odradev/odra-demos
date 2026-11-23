import "../../../style/odra.css";
import "./style.css";
import init, {
  AccountInfo,
  Address,
  AirdropErrors,
  AirdropWasmClient,
  Contracts,
  CsprClickCallbacks,
  OdraWasmClient,
  setGas,
  TestTokenErrors,
  TestTokenWasmClient,
  TransactionResult,
  TransactionStatus,
  U256,
} from "airdrop-wasm-client";
import airdropSchema from "../../resources/casper_contract_schemas/airdrop_schema.json";
import testTokenSchema from "../../resources/casper_contract_schemas/test_token_schema.json";
import deployedContracts from "./contracts.json";
import { toHex, Tree } from "./merkle";
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
const CSPR_DECIMALS = 9;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/**
 * How far the clock of this computer may be from the chain's. The contract checks the deadline
 * against the block time; a transaction sent too close to it could fail, and a failed one is
 * charged its whole fee.
 */
const CLOCK_MARGIN = 60 * 1000;
/** Lists longer than this are shared as a file: a link would be too long to paste anywhere. */
const MAX_LINK_ENTRIES = 300;
/** The preview shows this many rows; the totals count all of them. */
const PREVIEW_ROWS = 200;

/**
 * Payment limits in motes. Measured on CasperVM, and on the testnet in November 2026 for the
 * first four: faucet 0.30 CSPR, approve 0.36, create_drop 1.72 whatever the length of the list,
 * claim 1.45 with a proof of 2 nodes and 1.54 with 10 (a list of 1,000), reclaim 1.24. 2.5 CSPR is
 * the smallest limit worth setting for a contract call; the network refunds three quarters of
 * what a transaction leaves unused.
 */
const GAS = {
  faucet: 2_500_000_000n,
  approve: 2_500_000_000n,
  create: 3n * CSPR,
  claim: 2_500_000_000n,
  reclaim: 2_500_000_000n,
};

const ERRORS: Record<number, string> = {
  [AirdropErrors.ZeroAmount]: "The drop has no tokens.",
  [AirdropErrors.NoRecipients]: "The list is empty.",
  [AirdropErrors.InvalidRoot]: "The fingerprint of the list is not 32 bytes long.",
  [AirdropErrors.DeadlineInPast]: "The deadline has already passed.",
  [AirdropErrors.DropNotFound]: "There is no drop with this number.",
  [AirdropErrors.ClaimsClosed]: "Claims for this drop have closed.",
  [AirdropErrors.AlreadyClaimed]: "This account has claimed from this drop already.",
  [AirdropErrors.InvalidProof]: "The list does not match the drop, so the proof was rejected.",
  [AirdropErrors.ExceedsDrop]:
    "The drop holds less than this claim: its list adds up to more than was put in.",
  [AirdropErrors.NotCreator]: "Only the creator of the drop can take back what is left.",
  [AirdropErrors.NoDeadline]: "The drop has no deadline, so nothing can be taken back.",
  [AirdropErrors.DeadlineNotReached]: "The deadline has not passed yet.",
  [AirdropErrors.NothingToReclaim]: "Nothing is left to take back.",
  [TestTokenErrors.InsufficientBalance]: "The token balance is too low.",
  [TestTokenErrors.InsufficientAllowance]: "The token allowance is too low.",
};

// ---------- Types ----------

interface Unit {
  symbol: string;
  decimals: number;
}

/** One line of a list: what was typed and, when it is valid, what it means. */
interface Row {
  line: number;
  text: string;
  recipient?: string;
  amount?: bigint;
  problem?: string;
}

/** A drop as stored, with the unit of its token. */
interface Drop {
  id: number;
  creator: string;
  token: string;
  root: Uint8Array;
  total: bigint;
  claimed: bigint;
  recipients: number;
  claims: number;
  /** Block time in milliseconds; 0 for none. */
  deadline: number;
  reclaimed: bigint;
  unit: Unit;
}

/** What the claim form found: the drop, and the connected account's line of the list. */
interface ClaimState {
  drop: Drop;
  tree: Tree;
  index: number;
  amount: bigint;
}

// ---------- State ----------

let client: OdraWasmClient;
let airdrop: AirdropWasmClient;
let airdropAddress: string;
let airdropStorage: ContractStorage;
let testTokenHash: string;
let account: { publicKey: string; address: string } | null = null;
/** The token the create form drops, as a formatted key. */
let token = "";
let tokenUnit: Unit = { symbol: "TEST", decimals: 9 };
let rows: Row[] = [];
/** The creator's balance of the token; `null` until it is read. */
let available: bigint | null = null;
let busy = false;
/** What the claim button would claim; `null` when there is nothing to claim. */
let claimable: ClaimState | null = null;
/** Increases with every read of the claim form, so that a slow read does not paint over a newer one. */
let claimRead = 0;
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
const createForm = $<HTMLFormElement>("create");
const createError = $("create-error");
const createSubmit = $<HTMLButtonElement>("create-submit");
const createHint = $("create-hint");
const fToken = $<HTMLInputElement>("f-token");
const fTokenInfo = $("f-token-info");
const fList = $<HTMLTextAreaElement>("f-list");
const fDeadline = $<HTMLInputElement>("f-deadline");
const summaryEl = $("summary");
const previewEl = $("preview");
const shareBox = $("share");
const shareLink = $<HTMLInputElement>("share-link");
const shareFile = $<HTMLAnchorElement>("share-file");
const claimForm = $<HTMLFormElement>("claim");
const cDrop = $<HTMLInputElement>("c-drop");
const cList = $<HTMLTextAreaElement>("c-list");
const cFile = $<HTMLInputElement>("c-file");
const claimSummary = $("claim-summary");
const claimError = $("claim-error");
const claimSubmit = $<HTMLButtonElement>("claim-submit");
const dropEl = $("drop");
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

/** An amount of the smallest unit as a decimal number with every digit, as a list is written. */
function exactAmount(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const fraction = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${value / base}.${fraction}` : `${value / base}`;
}

const show = (value: bigint, unit: Unit) => `${formatAmount(value, unit.decimals)} ${unit.symbol}`;

/** Parses a decimal number into the smallest unit; `null` if it is not a valid amount. */
function parseAmount(text: string, decimals: number): bigint | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text.replace(/_/g, ""));
  if (!match) return null;
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) return null;
  return BigInt(match[1]) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
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

/** Text as URL-safe base64 of its UTF-8 bytes, and back: how a list travels in a claim link. */
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

/** The number of drops created: also the number the next one gets. */
async function dropsCount(): Promise<number> {
  return Number((await airdropStorage.read("count")) ?? "0");
}

/** The drop with number `id`, or `null` if there is none. */
async function readDrop(id: number): Promise<Drop | null> {
  const stored = await airdropStorage.read("drops", [String(id)]);
  if (stored === null) return null;
  const drop = JSON.parse(stored) as Record<string, string>;
  const tokenKey = formattedKey(drop.token);
  return {
    id,
    creator: formattedKey(drop.creator),
    token: tokenKey,
    // Bytes inside a struct are printed as a list of numbers: "[195,88,…]".
    root: Uint8Array.from(JSON.parse(drop.root) as number[]),
    total: BigInt(drop.total),
    claimed: BigInt(drop.claimed),
    recipients: Number(drop.recipients),
    claims: Number(drop.claims),
    deadline: Number(drop.deadline),
    reclaimed: BigInt(drop.reclaimed),
    unit: await readTokenUnit(tokenKey),
  };
}

/** Whether `recipient` has claimed from drop `id`. */
async function hasClaimed(id: number, recipient: string): Promise<boolean> {
  return (await airdropStorage.read("claimed", [`${id}:${recipient}`])) === "true";
}

// ---------- Lists ----------

/**
 * Reads a list into rows: an address and an amount per line, separated by commas, spaces or
 * tabs. An address may appear once: the contract pays each recipient of a drop once.
 */
function parseList(text: string, unit: Unit): Row[] {
  const parsed: Row[] = [];
  const seen = new Map<string, number>();
  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    const row: Row = { line: index + 1, text: line };
    const parts = line.split(/[\s,;]+/).filter(Boolean);
    if (parts.length !== 2) {
      row.problem = "Expected an address and an amount";
    } else {
      try {
        row.recipient = parseAddress(parts[0]);
      } catch {
        row.problem = "Not an address";
      }
      const amount = parseAmount(parts[1], unit.decimals);
      if (!row.problem && amount === null) {
        row.problem = `Not an amount of ${unit.symbol} (up to ${unit.decimals} decimals, with a dot)`;
      } else if (!row.problem && amount === 0n) {
        row.problem = "The amount is zero";
      } else if (!row.problem && seen.has(row.recipient!)) {
        row.problem = `Already on line ${seen.get(row.recipient!)}`;
      }
      if (!row.problem) seen.set(row.recipient!, row.line);
      row.amount = amount ?? undefined;
    }
    parsed.push(row);
  });
  return parsed;
}

const entries = (list: Row[]) => list.map((row) => ({ address: row.recipient!, amount: row.amount! }));
const sum = (list: Row[]) => list.reduce((total, row) => total + (row.problem ? 0n : row.amount!), 0n);

/** The list as the share link and the file carry it: one `address, amount` per line, every digit. */
const listText = (list: Row[], unit: Unit) =>
  list.map((row) => `${row.recipient}, ${exactAmount(row.amount!, unit.decimals)}`).join("\n") + "\n";

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

// ---------- Creating a drop ----------

/** The deadline chosen in the form, in milliseconds; 0 for none, NaN if it cannot be read. */
function deadline(): number {
  return fDeadline.value ? new Date(fDeadline.value).getTime() : 0;
}

function setDeadline(choice: string) {
  const after: Record<string, number> = { "1h": HOUR, "1w": 7 * DAY, "30d": 30 * DAY };
  fDeadline.value = choice in after ? localInput(Date.now() + after[choice]) : "";
  markDeadline(choice);
  renderSummary();
}

function markDeadline(choice: string) {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-deadline]")) {
    button.classList.toggle("active", button.dataset.deadline === choice);
  }
}

/** What stops the list from being dropped, or an empty string when it can be. */
function blocker(): string {
  if (rows.length === 0) return "Paste at least one recipient.";
  const broken = brokenLines(rows);
  if (broken) return `Fix ${broken.toLowerCase()} first; see the list on the right.`;
  if (rows.length > 0xffff_ffff) return "The list is too long.";
  const until = deadline();
  if (Number.isNaN(until)) return "The deadline is not a date.";
  if (until !== 0 && until < Date.now() + 10 * CLOCK_MARGIN) return "The deadline must be in the future.";
  if (account && available !== null && available < sum(rows)) {
    return `The list adds up to ${show(sum(rows), tokenUnit)}, and you have ${show(available, tokenUnit)}.`;
  }
  return "";
}

/** The tree of the list in the form, when every line is valid. */
function formTree(): Tree | null {
  return rows.length > 0 && !rows.some((row) => row.problem) ? new Tree(entries(rows)) : null;
}

function renderPreview(tree: Tree | null) {
  if (rows.length === 0) {
    previewEl.replaceChildren(element("p", "empty", "Nothing yet. Paste a list on the left."));
    return;
  }
  const facts = element("dl", "facts");
  const valid = rows.filter((row) => !row.problem).length;
  facts.append(
    element("dt", "", "Recipients"),
    element("dd", "", valid.toLocaleString("en-US")),
    element("dt", "", "Total"),
    element("dd", "", show(sum(rows), tokenUnit)),
    element("dt", "", "Fingerprint"),
    element("dd", "mono", tree ? toHex(tree.root) : "Worked out once every line is valid."),
  );

  const table = element("table");
  const head = element("tr");
  head.append(element("th", "", "Recipient"), element("th", "", `Amount, ${tokenUnit.symbol}`));
  const thead = element("thead");
  thead.append(head);
  const tbody = element("tbody");
  for (const row of rows.slice(0, PREVIEW_ROWS)) {
    const tr = element("tr");
    const recipient = element("td");
    if (row.problem) {
      recipient.append(
        element("span", "mono", row.text.slice(0, 40)),
        " ",
        element("span", "chip warn", row.problem),
      );
    } else {
      const name = element(
        "span",
        "mono",
        account?.address === row.recipient ? "you" : short(row.recipient!),
      );
      name.title = row.recipient!;
      recipient.append(name);
    }
    const amount =
      row.amount !== undefined && !row.problem ? formatAmount(row.amount, tokenUnit.decimals) : "—";
    tr.append(recipient, element("td", "", amount));
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

/** Says in a sentence what creating the drop will do, and sets the button to match. */
function renderSummary() {
  const stop = blocker();
  const people = plural(rows.length, "recipient");
  const total = show(sum(rows), tokenUnit);
  const until = deadline();

  if (stop) {
    summaryEl.textContent = stop;
    createSubmit.textContent = account ? "Create the drop" : "Connect a wallet to create a drop";
  } else {
    const close =
      until === 0
        ? "Claims never close."
        : `Claims close on ${formatDate(until)}; after that you can take back what is left.`;
    summaryEl.textContent = `You put ${total} into the contract in one transaction, and ${people} can each claim their amount. ${close}`;
    createSubmit.textContent = account ? `Drop ${total} to ${people}` : "Connect a wallet to create a drop";
  }
  createSubmit.disabled = busy || !account || stop !== "";
  createHint.textContent = `Your wallet will ask twice: first to let the contract take the tokens, then to create the drop. The network takes up to ${formatAmount(GAS.approve + GAS.create, CSPR_DECIMALS)} CSPR as a fee and refunds most of what is not used.`;
}

function refreshList() {
  rows = parseList(fList.value, tokenUnit);
  renderPreview(formTree());
  renderSummary();
}

function showCreateError(text: string) {
  createError.textContent = text;
  createError.hidden = !text;
}

/** Finds the number of the drop just created: the first new one with this creator and root. */
async function findDrop(from: number, creator: string, root: string): Promise<number | null> {
  const count = await dropsCount();
  for (let id = from; id < count; id++) {
    const drop = await readDrop(id);
    if (drop && drop.creator === creator && toHex(drop.root) === root) return id;
  }
  return null;
}

async function createDrop() {
  showCreateError("");
  refreshList();
  const tree = formTree();
  if (!account || blocker() || !tree) return;

  // The list as it is now: what the reader checked is what gets dropped.
  const list = rows.slice();
  const total = sum(list);
  const root = tree.root;
  const until = deadline();
  const what = show(total, tokenUnit);
  const unit = tokenUnit;
  const dropping = token;

  await withBusy(async () => {
    const me = account!.address;
    if ((await balanceOf(dropping, me)) < total) return showCreateError(`You have less than ${what}.`);
    if ((await allowanceOf(dropping, me, airdropAddress)) < total) {
      const approved = await send("Step 1 of 2, allowing the contract to take the tokens", GAS.approve, () =>
        tokenClient(dropping).approve(address(airdropAddress), U256.fromBigInt(total)),
      );
      if (!approved) return;
    }
    const before = await dropsCount();
    const created = await send(
      `Step 2 of 2, dropping ${what} to ${plural(list.length, "recipient")}`,
      GAS.create,
      () => airdrop.createDrop(address(dropping), root, U256.fromBigInt(total), list.length, BigInt(until)),
    );
    if (!created) return;

    refreshState();
    const id = await findDrop(before, me, toHex(root));
    fList.value = "";
    showShare(id, list, unit, total, until);
  });
}

/** Shows how to hand the list to the recipients, and fills in the claim form with it. */
function showShare(id: number | null, list: Row[], unit: Unit, total: bigint, until: number) {
  const text = listText(list, unit);
  const number = id === null ? "Your drop" : `Drop #${id}`;
  const close = until === 0 ? "" : ` until ${formatDate(until)}`;
  $("share-text").textContent =
    `${number} is ready: ${plural(list.length, "recipient")} can claim ${show(total, unit)}${close}. ` +
    "Send them the link or the file: the page works out each one's proof from the list.";

  const fitsLink = id !== null && list.length <= MAX_LINK_ENTRIES;
  $("share-link-field").hidden = !fitsLink;
  $("share-copy").hidden = !fitsLink;
  if (fitsLink) {
    const base = location.href.replace(/#.*$/, "");
    shareLink.value = `${base}#drop=${id}&list=${toBase64Url(text)}`;
  }
  if (shareFile.href) URL.revokeObjectURL(shareFile.href);
  shareFile.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  shareFile.download = id === null ? "drop.txt" : `drop-${id}.txt`;
  shareBox.hidden = false;

  if (id !== null) {
    cDrop.value = String(id);
    cList.value = text;
    void refreshClaim();
  }
}

// ---------- Claiming ----------

function showClaimError(text: string) {
  claimError.textContent = text;
  claimError.hidden = !text;
}

/** The number typed in the claim form, or `null`. */
function dropNumber(): number | null {
  const typed = cDrop.value.trim();
  return /^\d+$/.test(typed) ? Number(typed) : null;
}

/** Reads the drop and the list in the claim form and says what the connected account can claim. */
async function refreshClaim() {
  const read = ++claimRead;
  const current = () => read === claimRead;
  claimable = null;
  paintClaimButton("Claim");

  const id = dropNumber();
  if (id === null) {
    claimSummary.textContent = cDrop.value.trim()
      ? "A drop number is a whole number."
      : "Enter the drop number.";
    dropEl.replaceChildren(element("p", "empty", "Enter a drop number to see it."));
    return;
  }

  let drop: Drop | null;
  try {
    drop = await readDrop(id);
  } catch (error) {
    if (!current()) return;
    claimSummary.textContent = errorText(error);
    return;
  }
  if (!current()) return;
  if (!drop) {
    claimSummary.textContent = `There is no drop #${id} yet.`;
    dropEl.replaceChildren(element("p", "empty", `There is no drop #${id} yet.`));
    return;
  }
  renderDrop(drop);

  const list = parseList(cList.value, drop.unit);
  if (list.length === 0) {
    claimSummary.textContent = "Paste the list of the drop, or open its file.";
    return;
  }
  const broken = brokenLines(list);
  if (broken) {
    claimSummary.textContent = `${broken} of the list cannot be read: ${list.find((row) => row.problem)!.problem}.`;
    return;
  }
  const tree = new Tree(entries(list));
  if (toHex(tree.root) !== toHex(drop.root)) {
    claimSummary.textContent = `This list is not the list of drop #${id}: its fingerprint is different. You need the whole list, exactly as it was when the drop was created.`;
    return;
  }

  const matches = `The list matches drop #${id}.`;
  if (!account) {
    claimSummary.textContent = `${matches} Connect a wallet to see whether you are on it.`;
    return;
  }
  const me = account.address;
  const index = list.findIndex((row) => row.recipient === me);
  if (index < 0) {
    claimSummary.textContent = `${matches} Your account is not on it.`;
    return;
  }
  const amount = list[index].amount!;
  const yours = show(amount, drop.unit);
  let claimed: boolean;
  try {
    claimed = await hasClaimed(id, me);
  } catch (error) {
    if (current()) claimSummary.textContent = errorText(error);
    return;
  }
  if (!current()) return;
  if (claimed) {
    claimSummary.textContent = `You are on the list for ${yours}, and you have claimed it.`;
    $("step-drop").classList.add("done");
    return;
  }
  if (drop.deadline !== 0 && Date.now() >= drop.deadline - CLOCK_MARGIN) {
    claimSummary.textContent = `You are on the list for ${yours}, but claims closed on ${formatDate(drop.deadline)}.`;
    return;
  }
  if (drop.reclaimed > 0n) {
    claimSummary.textContent = `You are on the list for ${yours}, but the creator has taken back what was left.`;
    return;
  }
  claimable = { drop, tree, index, amount };
  const close = drop.deadline === 0 ? "" : ` Claims close on ${formatDate(drop.deadline)}.`;
  claimSummary.textContent = `You are on the list for ${yours}, and you have not claimed it yet.${close}`;
  paintClaimButton(`Claim ${yours}`);
}

function paintClaimButton(text: string) {
  claimSubmit.textContent = text;
  claimSubmit.disabled = busy || claimable === null;
}

async function claim() {
  showClaimError("");
  const state = claimable;
  if (!account || !state) return;
  const me = account.address;
  const proof = state.tree.proofBytes(state.index);
  await withBusy(async () => {
    const claimed = await send(`Claiming ${show(state.amount, state.drop.unit)}`, GAS.claim, () =>
      airdrop.claim(BigInt(state.drop.id), address(me), U256.fromBigInt(state.amount), proof),
    );
    if (claimed) $("step-drop").classList.add("done");
  });
}

async function reclaim(drop: Drop) {
  const left = drop.total - drop.claimed - drop.reclaimed;
  await withBusy(async () => {
    await send(`Taking back ${show(left, drop.unit)}`, GAS.reclaim, () => airdrop.reclaim(BigInt(drop.id)));
  });
}

// ---------- The drop ----------

/** `you` for the connected account, a shortened address for anyone else. */
const who = (formatted: string) => (account?.address === formatted ? "you" : short(formatted));

function dropState(drop: Drop): { text: string; tone: "" | "good" | "warn" } {
  if (drop.reclaimed > 0n) return { text: "Closed, the rest taken back", tone: "warn" };
  if (drop.claimed === drop.total) return { text: "All claimed", tone: "good" };
  if (drop.deadline !== 0 && Date.now() >= drop.deadline) return { text: "Claims closed", tone: "warn" };
  if (drop.deadline === 0) return { text: "Open", tone: "" };
  return { text: `Open until ${formatDate(drop.deadline)}`, tone: "" };
}

function renderDrop(drop: Drop) {
  const amount = (value: bigint) => show(value, drop.unit);
  const card = element("article", "item");

  const head = element("div", "head");
  const heading = element("div");
  heading.append(
    element("div", "title", amount(drop.total)),
    element("div", "from", `Drop #${drop.id} · by ${who(drop.creator)}`),
  );
  const state = dropState(drop);
  head.append(heading, element("span", `chip ${state.tone}`, state.text));

  const bar = element("div", "progress");
  const fill = element("div", "fill");
  fill.style.width = drop.total === 0n ? "0%" : `${Number((drop.claimed * 10_000n) / drop.total) / 100}%`;
  bar.append(fill);
  bar.title = `${amount(drop.claimed)} of ${amount(drop.total)} claimed`;

  const tiles = element("div", "tiles");
  /** A stat tile; `dot` is the class of its legend dot ("" for the brand colour), `null` for none. */
  const tile = (dot: string | null, name: string, value: string, sub: string) => {
    const node = element("div", "tile");
    const label = element("div", "label", name);
    if (dot !== null) label.prepend(element("span", `dot ${dot}`.trim()));
    node.append(label, element("div", "value", value), element("div", "sub", sub));
    tiles.append(node);
  };
  const left = drop.total - drop.claimed - drop.reclaimed;
  tile("", "Claimed", formatAmount(drop.claimed, drop.unit.decimals), drop.unit.symbol);
  tile(
    "rest",
    drop.reclaimed > 0n ? "Taken back" : "Not claimed yet",
    formatAmount(drop.reclaimed > 0n ? drop.reclaimed : left, drop.unit.decimals),
    drop.unit.symbol,
  );
  tile(
    null,
    "Recipients",
    `${drop.claims.toLocaleString("en-US")} of ${drop.recipients.toLocaleString("en-US")}`,
    "have claimed",
  );

  const parts: HTMLElement[] = [head, bar, tiles];

  const canReclaim =
    account?.address === drop.creator &&
    drop.deadline !== 0 &&
    left > 0n &&
    Date.now() >= drop.deadline + CLOCK_MARGIN;
  if (canReclaim) {
    const actions = element("div", "actions");
    const button = element("button", "", `Take back ${amount(left)}`);
    button.disabled = busy;
    button.addEventListener("click", () => void reclaim(drop));
    actions.append(button);
    parts.push(actions);
  }

  const details = element("details");
  const facts = element("dl", "facts");
  const fact = (name: string, value: string) =>
    facts.append(element("dt", "", name), element("dd", "mono", value));
  fact("Creator", drop.creator);
  fact("Token", drop.token);
  fact("Fingerprint", toHex(drop.root));
  fact("Claims close", drop.deadline === 0 ? "Never" : formatDate(drop.deadline));
  details.append(element("summary", "", "Details"), facts);
  parts.push(details);

  card.append(...parts);
  dropEl.replaceChildren(card);
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
  paintClaimButton(claimSubmit.textContent ?? "Claim");
}

async function refreshAll() {
  refreshState();
  repaint();
  await refreshBalances();
  refreshList();
  await refreshClaim();
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
  $("unit-hint").textContent = found.symbol;
  available = null;
  refreshList();
  await refreshBalances();
  refreshList();
}

/** You and two accounts made up on the spot: nobody holds their keys. */
function fillExample() {
  const randomAccount = () =>
    "account-hash-" +
    [...crypto.getRandomValues(new Uint8Array(32))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  const lines = [`${randomAccount()}, 10`, `${randomAccount()}, 5`];
  if (account) lines.unshift(`${account.address}, 25`);
  else lines.unshift(`${randomAccount()}, 25`);
  fList.value = lines.join("\n");
  if (!account) showCreateError("Connect a wallet first to put yourself on the list.");
  setDeadline("1w");
  refreshList();
  fList.scrollIntoView({ behavior: "smooth", block: "center" });
}

/** Fills in the claim form from a claim link: `#drop=<number>&list=<base64url of the list>`. */
function readLink() {
  const params = new URLSearchParams(location.hash.slice(1));
  const drop = params.get("drop");
  const list = params.get("list");
  if (drop === null) return;
  cDrop.value = drop;
  if (list) {
    try {
      cList.value = fromBase64Url(list);
    } catch {
      showClaimError("The list in this link is damaged. Ask for the link again, or for the file.");
    }
  }
  claimForm.scrollIntoView({ block: "start" });
}

async function openFile() {
  const file = cFile.files?.[0];
  if (!file) return;
  cList.value = await file.text();
  await refreshClaim();
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
  airdropAddress = key(contracts.get("Airdrop").address);
  airdrop = new AirdropWasmClient(client, address(airdropAddress));
  testTokenHash = key(contracts.get("TestToken").address);
  token = testTokenHash;
  airdropStorage = await ContractStorage.open(airdropSchema, airdropAddress);

  $("contract").textContent = `Airdrop contract: ${airdropAddress}.`;
  setDeadline("1w");
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
  createForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void createDrop();
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-deadline]")) {
    button.addEventListener("click", () => setDeadline(button.dataset.deadline!));
  }
  fDeadline.addEventListener("input", () => {
    markDeadline("");
    renderSummary();
  });
  fToken.addEventListener("change", () => void setToken());
  fList.addEventListener("input", () => {
    showCreateError("");
    refreshList();
  });
  $("share-copy").addEventListener("click", () => {
    navigator.clipboard
      .writeText(shareLink.value)
      .then(() => showTx("The claim link is copied."))
      .catch(() => shareLink.select());
  });
  claimForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void claim();
  });
  cDrop.addEventListener("input", () => {
    showClaimError("");
    void refreshClaim();
  });
  cList.addEventListener("input", () => {
    showClaimError("");
    void refreshClaim();
  });
  cFile.addEventListener("change", () => void openFile());
  window.addEventListener("hashchange", () => {
    readLink();
    void refreshClaim();
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
