import "../../../style/odra.css";
import "./style.css";
import init, {
  AccountInfo,
  Address,
  Contracts,
  CsprClickCallbacks,
  FeeConfigErrors,
  OdraWasmClient,
  setGas,
  TimelockErrors,
  TimelockWasmClient,
  TransactionResult,
  TransactionStatus,
} from "timelock-wasm-client";
import feeConfigSchema from "../../resources/casper_contract_schemas/fee_config_schema.json";
import timelockSchema from "../../resources/casper_contract_schemas/timelock_schema.json";
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
/** Payment limits of the transactions the app sends, in motes. Estimates, with room to spare. */
const GAS = {
  propose: 5n * CSPR,
  // Executing makes a call of another contract.
  execute: 10n * CSPR,
  cancel: 5n * CSPR,
};

/** The most proposals the list shows. */
const LIST_LIMIT = 25;
/** The address that stands for every account when it holds a role. */
const ANYONE = `account-hash-${"0".repeat(64)}`;
const MINUTE = 60_000;
/** The roles of the timelock by number, as a verb and as a noun of the activity. */
const ROLES: Record<number, [string, string]> = {
  1: ["propose", "proposing"],
  2: ["execute", "executing"],
  3: ["cancel", "cancelling"],
};

const ERRORS: Record<number, string> = {
  [TimelockErrors.MissingRole]: "Your account is not allowed to do this on this timelock.",
  [TimelockErrors.NotTimelock]: "Only the timelock itself may do this, through a proposal.",
  [TimelockErrors.DelayTooShort]: "The delay is shorter than the minimum delay.",
  [TimelockErrors.DelayTooLong]: "The delay is longer than 30 days.",
  [TimelockErrors.TargetNotContract]: "The target is not a contract.",
  [TimelockErrors.EmptyEntryPoint]: "The entry point is empty.",
  [TimelockErrors.InvalidArgs]: "The arguments of the call are not valid.",
  [TimelockErrors.OperationNotFound]: "There is no proposal with this number.",
  [TimelockErrors.NotReady]:
    "Not yet: the delay has not passed by the clock of the chain, which can lag a few seconds. Try again shortly.",
  [TimelockErrors.AlreadyExecuted]: "This proposal has been executed already.",
  [TimelockErrors.AlreadyCancelled]: "This proposal has been cancelled.",
  [TimelockErrors.UnknownRole]: "There is no such role.",
  [FeeConfigErrors.NotOwner]: "The fee contract refused: the caller is not its owner.",
  [FeeConfigErrors.FeeTooHigh]: "The fee contract refused: the fee is above 100%.",
};

// ---------- Types ----------

/** One argument of a call, decoded as far as the app knows the type. */
interface Arg {
  name: string;
  /** The value as text. */
  text: string;
  /** The value as a number, for the numeric types. */
  number?: bigint;
}

/** An operation as plain values, read once from the timelock. */
interface Operation {
  id: bigint;
  proposer: string;
  target: string;
  entryPoint: string;
  args: Arg[];
  proposedAt: number;
  readyAt: number;
  executed: boolean;
  cancelled: boolean;
}

/** A rendered operation: the element and the function that refreshes what changes with time. */
interface Card {
  element: HTMLElement;
  paint: () => void;
}

// ---------- State ----------

let client: OdraWasmClient;
let timelock: TimelockWasmClient;
let timelockStorage: ContractStorage;
let feeStorage: ContractStorage;
let timelockAddress: string;
let feeAddress: string;
let account: { publicKey: string; address: string } | null = null;
/** What the connected account may do on the timelock. */
let may = { propose: false, execute: false, cancel: false };
let minDelay = MINUTE;
let currentFee: number | null = null;
let chosenDelay = MINUTE;
let busy = false;
let cards: Card[] = [];

// ---------- DOM ----------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const connectBtn = $<HTMLButtonElement>("connect");
const accountBox = $("account");
const accountKey = $("account-key");
const fatalBox = $("fatal");
const feeEl = $("fee");
const minDelayEl = $("min-delay");
const proposeForm = $<HTMLFormElement>("propose");
const proposeError = $("propose-error");
const proposeSubmit = $<HTMLButtonElement>("propose-submit");
const fFee = $<HTMLInputElement>("f-fee");
const delaysEl = $("delays");
const summaryEl = $("summary");
const operationsEl = $("operations");
const txBox = $("tx");
const txText = $("tx-text");
const txLink = $<HTMLAnchorElement>("tx-link");

// ---------- Formatting ----------

const short = (value: string) => {
  const body = value.replace(/^(account-hash-|hash-)/, "");
  return body.length > 14 ? `${body.slice(0, 6)}…${body.slice(-6)}` : body;
};

const formatTime = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });

/** A fee in basis points as a percentage: 250 is "2.5%". */
const formatFee = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;

/** Parses a percentage with up to two decimals into basis points; `null` if it is not one. */
function parseFee(text: string): number | null {
  const match = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(text.trim().replace(/%$/, "").trim());
  if (!match) return null;
  const bps = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return bps <= 10_000 ? bps : null;
}

/** A duration in words, in its two largest units: "1 minute", "2 hours 5 minutes", "40 seconds". */
function formatDuration(ms: number): string {
  const units: [number, string][] = [
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
    [1_000, "second"],
  ];
  let rest = Math.max(0, Math.ceil(ms / 1000) * 1000);
  const parts: string[] = [];
  for (const [size, name] of units) {
    const count = Math.floor(rest / size);
    rest -= count * size;
    if (count > 0) parts.push(`${count} ${name}${count === 1 ? "" : "s"}`);
    else if (parts.length > 0) break;
    if (parts.length === 2) break;
  }
  return parts.length ? parts.join(" ") : "0 seconds";
}

/**
 * The formatted key of an address: `account-hash-…` or `hash-…`. `Address.value` prints another
 * form (`entity-account-…`, `contract-package-…`), which `new Address` does not read back.
 *
 * Addresses are kept as strings: a call of the client consumes the `Address` objects passed to
 * it, so each call gets fresh ones (`address(text)`).
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

// ---------- Call arguments ----------

// The timelock stores the arguments of a call as `RuntimeArgs` in their bytesrepr form. The app
// writes them for the one call it proposes (`set_fee`) and reads back the simple types to show
// what a proposal will do. The layout is pinned by a test of the contract
// (`arguments_are_serialized_as_the_web_app_writes_them`).

const CL_BOOL = 0;
const CL_U8 = 3;
const CL_U32 = 4;
const CL_U64 = 5;
const CL_U256 = 7;
const CL_U512 = 8;
const CL_STRING = 10;
const CL_KEY = 11;

const u32Bytes = (value: number) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
};

function concat(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/** `RuntimeArgs` with one `u32` argument. */
function u32Args(name: string, value: number): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  return concat([
    u32Bytes(1),
    u32Bytes(nameBytes.length),
    nameBytes,
    u32Bytes(4),
    u32Bytes(value),
    Uint8Array.of(CL_U32),
  ]);
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Little-endian bytes as a number. */
const littleEndian = (bytes: Uint8Array) =>
  bytes.reduceRight((value, byte) => (value << 8n) | BigInt(byte), 0n);

/** Decodes `RuntimeArgs`. An argument of a type the app does not know is shown in hex, and ends the list. */
function decodeArgs(bytes: Uint8Array): Arg[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const u32 = () => {
    const value = view.getUint32(at, true);
    at += 4;
    return value;
  };
  const take = (length: number) => {
    if (at + length > bytes.length) throw new Error("Truncated arguments.");
    const part = bytes.subarray(at, at + length);
    at += length;
    return part;
  };
  const args: Arg[] = [];
  try {
    const count = u32();
    for (let i = 0; i < count; i++) {
      const name = new TextDecoder().decode(take(u32()));
      const value = take(u32());
      const tag = take(1)[0];
      const number = (v: bigint): Arg => ({ name, text: v.toString(), number: v });
      switch (tag) {
        case CL_BOOL:
          args.push({ name, text: value[0] === 1 ? "true" : "false" });
          break;
        case CL_U8:
        case CL_U32:
        case CL_U64:
          args.push(number(littleEndian(value)));
          break;
        case CL_U256:
        case CL_U512:
          // A length byte, then the little-endian bytes.
          args.push(number(littleEndian(value.subarray(1))));
          break;
        case CL_STRING:
          args.push({ name, text: JSON.stringify(new TextDecoder().decode(value.subarray(4))) });
          break;
        case CL_KEY:
          if (value[0] === 0 || value[0] === 1) {
            const body = hex(value.subarray(1, 33));
            args.push({ name, text: `${value[0] === 0 ? "account-hash" : "hash"}-${body}` });
            break;
          }
          args.push({ name, text: `0x${hex(value)}` });
          break;
        default:
          args.push({ name, text: `0x${hex(value)}` });
          return args;
      }
    }
  } catch {
    // Shown as far as it could be read.
  }
  return args;
}

/** What a proposal will do, in words. */
function describe(op: Operation): string {
  const arg = (name: string) => op.args.find((a) => a.name === name);
  if (op.target === feeAddress && op.entryPoint === "set_fee") {
    const fee = arg("fee_bps")?.number;
    if (fee !== undefined) return `Set the fee to ${formatFee(Number(fee))}`;
  }
  if (op.target === feeAddress && op.entryPoint === "transfer_ownership") {
    const owner = arg("new_owner");
    if (owner) return `Hand the fee contract to ${who(owner.text)}`;
  }
  if (op.target === timelockAddress) {
    const delay = arg("new_delay")?.number;
    if (op.entryPoint === "update_delay" && delay !== undefined) {
      return `Make every change wait at least ${formatDuration(Number(delay))}`;
    }
    const role = ROLES[Number(arg("role")?.number ?? 0)];
    const holder = arg("account");
    if (role && holder && op.entryPoint === "grant_role") return `Let ${who(holder.text)} ${role[0]}`;
    if (role && holder && op.entryPoint === "revoke_role") return `Stop ${who(holder.text)} from ${role[1]}`;
  }
  const args = op.args.map((a) => `${a.name}: ${a.text}`).join(", ");
  return `Call ${op.entryPoint}(${args})`;
}

// ---------- Reading the contracts ----------

// State is read from the node's storage (see storage.ts). The generated client is used only to
// send transactions.

const operationsCount = async () => BigInt((await timelockStorage.read("count")) ?? "0");

/** Whether `account` holds a role, or the role is open to anyone. */
async function hasRole(field: "proposers" | "executors" | "cancellers", holder: string): Promise<boolean> {
  const [open, own] = await Promise.all([
    timelockStorage.read(field, [ANYONE]),
    timelockStorage.read(field, [holder]),
  ]);
  return open === "true" || own === "true";
}

async function loadOperation(id: bigint): Promise<Operation> {
  const stored = await timelockStorage.read("operations", [id.toString()]);
  if (stored === null) throw new Error(`There is no proposal ${id}.`);
  // A struct is printed as a JSON object whose values are all strings; bytes as a list of numbers.
  const op: Record<string, string> = JSON.parse(stored);
  const bytes = Uint8Array.from((op.args.match(/\d+/g) ?? []).map(Number));
  return {
    id,
    proposer: formattedKey(op.proposer),
    target: formattedKey(op.target),
    entryPoint: op.entry_point,
    args: decodeArgs(bytes),
    proposedAt: Number(op.proposed_at),
    readyAt: Number(op.ready_at),
    executed: op.executed === "true",
    cancelled: op.cancelled === "true",
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

/** `you` for the connected account, names for the two contracts, a shortened address otherwise. */
function who(formatted: string): string {
  if (account?.address === formatted) return "you";
  if (formatted === timelockAddress) return "the timelock";
  if (formatted === feeAddress) return "the fee contract";
  if (formatted === ANYONE) return "anyone";
  return short(formatted);
}

function state(op: Operation): { text: string; tone: "" | "good" | "warn" } {
  if (op.executed) return { text: "Executed", tone: "good" };
  if (op.cancelled) return { text: "Cancelled", tone: "warn" };
  const left = op.readyAt - Date.now();
  if (left > 0) return { text: `Waiting, ${formatDuration(left)} left`, tone: "" };
  return { text: "Ready to execute", tone: "good" };
}

function buildCard(op: Operation): Card {
  const card = element("article", "item");

  const head = element("div", "head");
  const heading = element("div");
  heading.append(
    element("div", "title", describe(op)),
    element("div", "from", `Proposal #${op.id} · by ${who(op.proposer)} · ${formatTime(op.proposedAt)}`),
  );
  const chip = element("span", "chip");
  head.append(heading, chip);

  // The bar runs from the moment of proposing to the moment the proposal becomes executable.
  const timeline = element("div", "timeline");
  const bar = element("div", "progress");
  const fill = element("div", "fill");
  bar.append(fill);
  const ticks = element("div", "ticks");
  const tick = (name: string, ms: number) => {
    const node = element("span", "", formatTime(ms));
    node.prepend(element("b", "", name));
    return node;
  };
  ticks.append(tick("Proposed", op.proposedAt), tick("Can be executed from", op.readyAt));
  timeline.append(bar, ticks);

  const actions = element("div", "actions");
  const executeBtn = element("button", "primary");
  executeBtn.addEventListener("click", () => execute(op));
  const cancelBtn = element("button", "", "Cancel");
  cancelBtn.addEventListener("click", () => cancel(op));
  actions.append(executeBtn, cancelBtn);

  const details = element("details");
  const facts = element("dl", "facts");
  fact(facts, "Contract", `${op.target} (${who(op.target)})`);
  fact(facts, "Entry point", op.entryPoint);
  for (const arg of op.args) fact(facts, `Argument ${arg.name}`, arg.text);
  if (op.args.length === 0) fact(facts, "Arguments", "none");
  fact(facts, "Proposed by", op.proposer);
  details.append(element("summary", "", "What exactly will be called"), facts);

  card.append(head, timeline, actions, details);

  const paint = () => {
    const open = !op.executed && !op.cancelled;
    const now = Date.now();
    const left = op.readyAt - now;
    const status = state(op);
    chip.textContent = status.text;
    chip.className = `chip ${status.tone}`;
    const span = op.readyAt - op.proposedAt;
    const done = !open || span <= 0 ? 1 : Math.min(1, Math.max(0, (now - op.proposedAt) / span));
    fill.style.width = `${done * 100}%`;
    fill.classList.toggle("soft", op.cancelled);

    actions.hidden = !open;
    executeBtn.textContent = left > 0 ? `Can be executed in ${formatDuration(left)}` : "Execute";
    executeBtn.disabled = busy || !account || !may.execute || left > 0;
    executeBtn.title = !account
      ? "Connect a wallet first"
      : may.execute
        ? ""
        : "Your account may not execute on this timelock";
    const mayCancel = account !== null && (may.cancel || account.address === op.proposer);
    cancelBtn.hidden = !mayCancel;
    cancelBtn.disabled = busy;
  };
  paint();
  return { element: card, paint };
}

let listVersion = 0;

async function refreshOperations() {
  const version = ++listVersion;
  try {
    const count = await operationsCount();
    if (version !== listVersion) return;
    if (count === 0n) {
      cards = [];
      operationsEl.replaceChildren(element("p", "empty", "Nobody has proposed a change yet."));
      return;
    }
    // Newest first. One read per proposal, one after another: the node proxy is shared.
    const built: Card[] = [];
    const oldest = count > BigInt(LIST_LIMIT) ? count - BigInt(LIST_LIMIT) : 0n;
    for (let id = count - 1n; id >= oldest; id--) {
      built.push(buildCard(await loadOperation(id)));
      if (version !== listVersion) return;
    }
    const nodes: HTMLElement[] = built.map((card) => card.element);
    if (oldest > 0n) nodes.push(element("p", "empty", `${oldest} older proposals are not shown.`));
    operationsEl.replaceChildren(...nodes);
    cards = built;
  } catch (error) {
    if (version !== listVersion) return;
    cards = [];
    operationsEl.replaceChildren(element("p", "notice", `Could not load: ${errorText(error)}`));
  }
}

async function refreshSettings() {
  try {
    const [fee, owner, delay] = await Promise.all([
      feeStorage.read("fee_bps"),
      feeStorage.read("owner"),
      timelockStorage.read("min_delay"),
    ]);
    currentFee = fee === null ? null : Number(fee);
    feeEl.textContent = currentFee === null ? "—" : formatFee(currentFee);
    if (owner !== null) $("fee-owner").textContent = `${formattedKey(owner)} (${who(formattedKey(owner))})`;
    minDelay = Number(delay ?? "0");
    minDelayEl.textContent = formatDuration(minDelay);
    $("step-delay").textContent = formatDuration(minDelay);
    renderDelays();
  } catch (error) {
    feeEl.textContent = "?";
    console.error(error);
  }
}

async function refreshRoles() {
  $("step-connect").classList.toggle("done", account !== null);
  if (!account) {
    may = { propose: false, execute: false, cancel: false };
    return;
  }
  const [propose, execute, cancel] = await Promise.all([
    hasRole("proposers", account.address),
    hasRole("executors", account.address),
    hasRole("cancellers", account.address),
  ]);
  may = { propose, execute, cancel };
}

function repaint() {
  for (const card of cards) card.paint();
  connectBtn.disabled = busy;
  proposeSubmit.disabled = busy || !account || !may.propose;
  const fee = parseFee(fFee.value);
  proposeSubmit.textContent = !account
    ? "Connect a wallet to propose"
    : !may.propose
      ? "Your account may not propose on this timelock"
      : fee === null
        ? "Propose the change"
        : `Propose a fee of ${formatFee(fee)}`;
}

async function refreshAll() {
  refreshState();
  repaint();
  await Promise.all([refreshSettings(), refreshRoles(), refreshOperations()]);
  updateSummary();
  repaint();
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

const execute = (op: Operation) =>
  withBusy(async () => {
    const done = await send(`Executing proposal #${op.id}`, GAS.execute, () => timelock.execute(op.id));
    if (done) $("step-execute").classList.add("done");
  });

const cancel = (op: Operation) =>
  withBusy(async () => {
    await send(`Cancelling proposal #${op.id}`, GAS.cancel, () => timelock.cancel(op.id));
  });

function showProposeError(text: string) {
  proposeError.textContent = text;
  proposeError.hidden = !text;
}

async function propose() {
  showProposeError("");
  if (!account) return;
  const fee = parseFee(fFee.value);
  if (fee === null)
    return showProposeError("The fee must be a percentage from 0 to 100, with up to two decimals.");
  const delay = Math.max(chosenDelay, minDelay);

  await withBusy(async () => {
    const proposed = await send(`Proposing a fee of ${formatFee(fee)}`, GAS.propose, () =>
      timelock.schedule(address(feeAddress), "set_fee", u32Args("fee_bps", fee), BigInt(delay)),
    );
    if (proposed) {
      fFee.value = "";
      $("step-propose").classList.add("done");
    }
  });
}

// ---------- Form helpers ----------

/** The delays offered: the minimum, and a few longer ones. */
function renderDelays() {
  const choices = [...new Set([minDelay, 5 * MINUTE, 60 * MINUTE].filter((d) => d >= minDelay))];
  if (!choices.includes(chosenDelay)) chosenDelay = minDelay;
  delaysEl.replaceChildren(
    ...choices.map((delay) => {
      const button = element(
        "button",
        `small${delay === chosenDelay ? " active" : ""}`,
        delay === minDelay ? `${formatDuration(delay)}, the minimum` : formatDuration(delay),
      );
      button.type = "button";
      button.addEventListener("click", () => {
        chosenDelay = delay;
        renderDelays();
        updateSummary();
      });
      return button;
    }),
  );
}

/** Says in a sentence what the proposal in the form will do. */
function updateSummary() {
  const fee = parseFee(fFee.value);
  const delay = Math.max(chosenDelay, minDelay);
  const from = currentFee === null ? "" : ` from ${formatFee(currentFee)}`;
  summaryEl.textContent =
    fee === null
      ? "Enter a fee to see what will happen."
      : `Your proposal to change the fee${from} to ${formatFee(fee)} appears in the list at once. ` +
        `From ${formatDuration(delay)} after it is recorded, about ${formatTime(Date.now() + delay)}, ` +
        `anyone can execute it, and the fee changes then. Until that, it can be cancelled.`;
  repaint();
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
  timelockAddress = key(contracts.get("Timelock").address);
  feeAddress = key(contracts.get("FeeConfig").address);
  timelock = new TimelockWasmClient(client, address(timelockAddress));
  [timelockStorage, feeStorage] = await Promise.all([
    ContractStorage.open(timelockSchema, timelockAddress),
    ContractStorage.open(feeConfigSchema, feeAddress),
  ]);

  $("timelock-contract").textContent = timelockAddress;
  $("fee-contract").textContent = feeAddress;

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
  $("reload").addEventListener("click", () => void refreshAll());
  proposeForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void propose();
  });
  fFee.addEventListener("input", updateSummary);
  $("tx-close").addEventListener("click", () => (txBox.hidden = true));

  await refreshAll();

  // Countdowns run on the local clock, without asking the node.
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
