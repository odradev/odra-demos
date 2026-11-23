import "../../../style/odra.css";
import "./style.css";
import init, {
  AccountInfo,
  Address,
  Contracts,
  CsprClickCallbacks,
  FeeConfigErrors,
  GovernorErrors,
  GovernorWasmClient,
  OdraWasmClient,
  setGas,
  TestTokenErrors,
  TestTokenWasmClient,
  TimelockErrors,
  TransactionResult,
  TransactionStatus,
  U256,
} from "governor-wasm-client";
import feeConfigSchema from "../../resources/casper_contract_schemas/fee_config_schema.json";
import governorSchema from "../../resources/casper_contract_schemas/governor_schema.json";
import testTokenSchema from "../../resources/casper_contract_schemas/test_token_schema.json";
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
/**
 * Payment limits of the transactions the app sends, in motes: what each uses on CasperVM, with
 * room to spare (see the README).
 */
const GAS = {
  faucet: 5n * CSPR,
  approve: 5n * CSPR,
  propose: 5n * CSPR,
  vote: 5n * CSPR,
  // Queueing and executing call the timelock, which executing has call the fee contract.
  queue: 6n * CSPR,
  execute: 6n * CSPR,
  withdraw: 5n * CSPR,
};

/** TEST has 9 decimals. */
const DECIMALS = 9;
/** The most proposals the list shows. */
const LIST_LIMIT = 25;
const MINUTE = 60_000;

const ERRORS: Record<number, string> = {
  [GovernorErrors.BelowProposalThreshold]:
    "You hold too few TEST to propose. Get some from the faucet first.",
  [GovernorErrors.FeeTooHigh]: "The fee cannot be above 100%.",
  [GovernorErrors.ProposalNotFound]: "There is no proposal with this number.",
  [GovernorErrors.VotingClosed]:
    "Voting on this proposal has ended by the clock of the chain, which can differ from yours by a few seconds.",
  [GovernorErrors.ZeroAmount]: "Vote with more than zero tokens.",
  [GovernorErrors.OtherSide]:
    "You voted the other way on this proposal already; you can only add to that vote.",
  [GovernorErrors.VotingNotOver]:
    "Not yet: voting has not ended by the clock of the chain, which can lag a few seconds. Try again shortly.",
  [GovernorErrors.NothingToWithdraw]: "You have no tokens to take back from this proposal.",
  [GovernorErrors.NotPassed]: "This proposal did not pass.",
  [GovernorErrors.AlreadyQueued]: "This proposal has been queued already.",
  [GovernorErrors.NotQueued]: "Queue the proposal in the timelock first.",
  [GovernorErrors.NotReady]:
    "Not yet: the timelock's delay has not passed by the clock of the chain, which can lag a few seconds. Try again shortly.",
  [GovernorErrors.AlreadyExecuted]: "This proposal has been executed already.",
  [TimelockErrors.AlreadyExecuted]:
    "The timelock has run this change already: someone executed it there directly.",
  [TimelockErrors.AlreadyCancelled]: "The change was cancelled in the timelock.",
  [TimelockErrors.MissingRole]: "The timelock no longer accepts proposals or executions from the governor.",
  [TimelockErrors.DelayTooShort]: "The timelock's delay changed. Reload and try again.",
  [FeeConfigErrors.NotOwner]: "The fee contract refused: the timelock is no longer its owner.",
  [FeeConfigErrors.FeeTooHigh]: "The fee contract refused: the fee is above 100%.",
  [TestTokenErrors.InsufficientBalance]: "You have fewer TEST than that.",
  [TestTokenErrors.InsufficientAllowance]: "The governor may not take that many of your TEST. Try again.",
};

// ---------- Types ----------

/** What one account deposited on one proposal. */
interface Ballot {
  support: boolean;
  amount: bigint;
  withdrawn: boolean;
}

/** A proposal as plain values, read once from the governor (and the timelock, once queued). */
interface Proposal {
  id: bigint;
  proposer: string;
  feeBps: number;
  createdAt: number;
  voteEnd: number;
  votesFor: bigint;
  votesAgainst: bigint;
  queued: boolean;
  operationId: bigint;
  readyAt: number;
  executed: boolean;
  /** The timelock operation of a queued proposal, which anyone may also run or cancel there. */
  operation: { executed: boolean; cancelled: boolean } | null;
  /** The deposit of the connected account. */
  ballot: Ballot | null;
}

/** A rendered proposal: the element and the function that refreshes what changes with time. */
interface Card {
  element: HTMLElement;
  paint: () => void;
}

// ---------- State ----------

let client: OdraWasmClient;
let governor: GovernorWasmClient;
let governorStorage: ContractStorage;
let timelockStorage: ContractStorage;
let feeStorage: ContractStorage;
let tokenStorage: ContractStorage;
let governorAddress: string;
let timelockAddress: string;
let feeAddress: string;
let tokenAddress: string;
let account: { publicKey: string; address: string } | null = null;
let balance = 0n;
let currentFee: number | null = null;
let votingPeriod = 3 * MINUTE;
let minDelay = MINUTE;
let quorum = 0n;
let threshold = 0n;
let busy = false;
let cards: Card[] = [];

// ---------- DOM ----------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const connectBtn = $<HTMLButtonElement>("connect");
const accountBox = $("account");
const accountKey = $("account-key");
const fatalBox = $("fatal");
const balanceEl = $("balance");
const faucetBtn = $<HTMLButtonElement>("faucet");
const feeEl = $("fee");
const minDelayEl = $("min-delay");
const proposeForm = $<HTMLFormElement>("propose");
const proposeError = $("propose-error");
const proposeSubmit = $<HTMLButtonElement>("propose-submit");
const fFee = $<HTMLInputElement>("f-fee");
const summaryEl = $("summary");
const proposalsEl = $("proposals");
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

/** An amount of the smallest unit as TEST, with up to 4 fraction digits: "1,000 TEST". */
function formatTest(value: bigint): string {
  const base = 10n ** BigInt(DECIMALS);
  const whole = (value / base).toLocaleString("en-US");
  const fraction = (value % base).toString().padStart(DECIMALS, "0").slice(0, 4).replace(/0+$/, "");
  return `${fraction ? `${whole}.${fraction}` : whole} TEST`;
}

/** Parses a decimal number of TEST into the smallest unit; `null` if it is not a valid amount. */
function parseTest(text: string): bigint | null {
  const match = /^(\d+)(?:[.,](\d+))?$/.exec(text.trim().replace(/[\s_,](?=\d{3})/g, ""));
  if (!match) return null;
  const fraction = match[2] ?? "";
  if (fraction.length > DECIMALS) return null;
  return BigInt(match[1]) * 10n ** BigInt(DECIMALS) + BigInt(fraction.padEnd(DECIMALS, "0") || "0");
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
 * Addresses are kept as strings: a call of the client consumes the `Address` and `U256` objects
 * passed to it, so each call gets fresh ones (`address(text)`).
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

/** `you` for the connected account, names for the contracts, a shortened address otherwise. */
function who(formatted: string): string {
  if (account?.address === formatted) return "you";
  if (formatted === governorAddress) return "the governor";
  if (formatted === timelockAddress) return "the timelock";
  if (formatted === feeAddress) return "the fee contract";
  return short(formatted);
}

// ---------- Reading the contracts ----------

// State is read from the node's storage (see storage.ts). The generated client is used only to
// send transactions.

/** A struct is printed as a JSON object whose values are all strings. */
const struct = (stored: string): Record<string, string> => JSON.parse(stored);

const proposalsCount = async () => BigInt((await governorStorage.read("count")) ?? "0");

const balanceOf = async (owner: string) =>
  BigInt((await tokenStorage.read("token.balances", [owner])) ?? "0");

const allowanceOf = async (owner: string, spender: string) =>
  BigInt((await tokenStorage.read("token.allowances", [`${owner}:${spender}`])) ?? "0");

async function loadProposal(id: bigint): Promise<Proposal> {
  const stored = await governorStorage.read("proposals", [id.toString()]);
  if (stored === null) throw new Error(`There is no proposal ${id}.`);
  const p = struct(stored);
  const proposal: Proposal = {
    id,
    proposer: formattedKey(p.proposer),
    feeBps: Number(p.fee_bps),
    createdAt: Number(p.created_at),
    voteEnd: Number(p.vote_end),
    votesFor: BigInt(p.votes_for),
    votesAgainst: BigInt(p.votes_against),
    queued: p.queued === "true",
    operationId: BigInt(p.operation_id),
    readyAt: Number(p.ready_at),
    executed: p.executed === "true",
    operation: null,
    ballot: null,
  };
  // The timelock is open: an operation the governor queued may be run or cancelled there directly.
  if (proposal.queued && !proposal.executed) {
    const op = await timelockStorage.read("operations", [proposal.operationId.toString()]);
    if (op !== null) {
      const fields = struct(op);
      proposal.operation = { executed: fields.executed === "true", cancelled: fields.cancelled === "true" };
    }
  }
  if (account) {
    // A mapping keyed by a pair takes the two keys joined with a colon.
    const ballot = await governorStorage.read("ballots", [`${id}:${account.address}`]);
    if (ballot !== null) {
      const b = struct(ballot);
      proposal.ballot = {
        support: b.support === "true",
        amount: BigInt(b.amount),
        withdrawn: b.withdrawn === "true",
      };
    }
  }
  return proposal;
}

// ---------- Where a proposal stands ----------

const votingOpen = (p: Proposal) => Date.now() < p.voteEnd;
const passed = (p: Proposal) => p.votesFor >= quorum && p.votesFor > p.votesAgainst;
const done = (p: Proposal) => p.executed || p.operation?.executed === true;

function state(p: Proposal): { text: string; tone: "" | "good" | "warn" } {
  if (done(p)) return { text: "Executed", tone: "good" };
  if (p.operation?.cancelled) return { text: "Cancelled in the timelock", tone: "warn" };
  if (p.queued) {
    const left = p.readyAt - Date.now();
    return left > 0
      ? { text: `Queued, executable in ${formatDuration(left)}`, tone: "" }
      : { text: "Ready to execute", tone: "good" };
  }
  if (votingOpen(p)) return { text: `Voting, ${formatDuration(p.voteEnd - Date.now())} left`, tone: "" };
  if (passed(p)) return { text: "Passed, ready to queue", tone: "good" };
  return { text: "Failed", tone: "warn" };
}

/** One sentence on what happens next, or why it ended as it did. */
function outlook(p: Proposal): string {
  if (done(p)) return "The timelock has set the fee.";
  if (p.operation?.cancelled) return "The change was cancelled in the timelock and will not run.";
  if (p.queued) return `Waiting in the timelock. Anyone can execute it from ${formatTime(p.readyAt)}.`;
  if (votingOpen(p)) return `Voting ends ${formatTime(p.voteEnd)}.`;
  if (passed(p)) return "The vote passed. Anyone can now hand it to the timelock.";
  if (p.votesFor < quorum) return `Fewer than ${formatTest(quorum)} voted for it.`;
  return "More tokens voted against it than for it.";
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

/** The vote bar: tokens for from the left, against from the right, a mark at the quorum. */
function voteBar(p: Proposal): HTMLElement {
  const total = p.votesFor + p.votesAgainst;
  // The scale leaves room to see the quorum mark before anyone has voted.
  const scale = Number(total > 2n * quorum ? total : 2n * quorum) || 1;
  const share = (value: bigint) => `${Math.min(100, (Number(value) / scale) * 100)}%`;

  const bar = element("div", "progress");
  const forFill = element("div", "fill");
  forFill.style.width = share(p.votesFor);
  const againstFill = element("div", "against");
  againstFill.style.width = share(p.votesAgainst);
  const mark = element("div", "mark");
  mark.style.left = share(quorum);
  mark.title = `Needs ${formatTest(quorum)} for`;
  bar.append(forFill, againstFill, mark);

  const side = (name: string, value: bigint, dot: string) => {
    const span = element("span");
    const label = element("b", "side");
    label.append(element("i", dot), name);
    span.append(label, formatTest(value));
    return span;
  };
  const needs = element("span", "", `${formatTest(quorum)} for`);
  needs.prepend(element("b", "", "Needs"));
  const ticks = element("div", "ticks");
  ticks.append(side("For", p.votesFor, "dot"), needs, side("Against", p.votesAgainst, "dot against"));

  const timeline = element("div", "timeline");
  timeline.append(bar, ticks);
  return timeline;
}

function buildCard(p: Proposal): Card {
  const card = element("article", "item");

  const head = element("div", "head");
  const heading = element("div");
  heading.append(
    element("div", "title", `Set the fee to ${formatFee(p.feeBps)}`),
    element("div", "from", `Proposal #${p.id} · by ${who(p.proposer)} · ${formatTime(p.createdAt)}`),
  );
  const chip = element("span", "chip");
  head.append(heading, chip);

  const next = element("div", "from");
  const mine = element("div", "from");
  if (p.ballot) {
    const side = p.ballot.support ? "for" : "against";
    mine.textContent = p.ballot.withdrawn
      ? `You voted ${side} with ${formatTest(p.ballot.amount)} and have taken them back.`
      : `You voted ${side} with ${formatTest(p.ballot.amount)}. They stay locked until voting ends.`;
  }
  mine.hidden = !p.ballot;

  // Voting: an amount and a button for each side.
  const vote = element("div", "vote");
  const amountBox = element("span", "with-unit");
  const amountInput = element("input");
  amountInput.inputMode = "decimal";
  amountInput.placeholder = "1000";
  amountInput.setAttribute("aria-label", "Tokens to vote with");
  if (balance > 0n)
    amountInput.value = formatTest(balance)
      .replace(/ TEST$/, "")
      .replace(/,/g, "");
  amountBox.append(amountInput, element("span", "unit", "TEST"));
  const forBtn = element("button");
  const againstBtn = element("button");
  forBtn.addEventListener("click", () => castVote(p, true, amountInput.value));
  againstBtn.addEventListener("click", () => castVote(p, false, amountInput.value));
  amountInput.addEventListener("input", () => paint());
  vote.append(amountBox, forBtn, againstBtn);

  const actions = element("div", "actions");
  const queueBtn = element("button", "primary", "Queue in the timelock");
  queueBtn.addEventListener("click", () => queue(p));
  const executeBtn = element("button", "primary");
  executeBtn.addEventListener("click", () => execute(p));
  const withdrawBtn = element("button");
  withdrawBtn.addEventListener("click", () => withdraw(p));
  actions.append(queueBtn, executeBtn, withdrawBtn);

  const details = element("details");
  const facts = element("dl", "facts");
  fact(facts, "Contract", `${feeAddress} (the fee contract)`);
  fact(facts, "Entry point", "set_fee");
  fact(facts, "Argument fee_bps", p.feeBps.toString());
  fact(facts, "Called by", `${timelockAddress} (the timelock)`);
  if (p.queued) fact(facts, "Timelock operation", `#${p.operationId}`);
  fact(facts, "Proposed by", p.proposer);
  details.append(element("summary", "", "What exactly will be called"), facts);

  card.append(head, voteBar(p), next, mine, vote, actions, details);

  function paint() {
    const now = Date.now();
    const status = state(p);
    chip.textContent = status.text;
    chip.className = `chip ${status.tone}`;
    next.textContent = outlook(p);

    const open = votingOpen(p);
    vote.hidden = !open || !account;
    const amount = parseTest(amountInput.value);
    const label = amount && amount > 0n ? ` with ${formatTest(amount)}` : "";
    forBtn.textContent = `Vote for${label}`;
    againstBtn.textContent = `Vote against${label}`;
    const held = p.ballot && !p.ballot.withdrawn ? p.ballot.support : null;
    forBtn.disabled = busy || !amount || held === false;
    againstBtn.disabled = busy || !amount || held === true;
    forBtn.title = held === false ? "You voted against already" : "";
    againstBtn.title = held === true ? "You voted for already" : "";

    queueBtn.hidden = open || p.queued || !passed(p);
    queueBtn.disabled = busy || !account;
    const waiting = p.queued && !done(p) && !p.operation?.cancelled;
    executeBtn.hidden = !waiting;
    const left = p.readyAt - now;
    executeBtn.textContent = left > 0 ? `Can be executed in ${formatDuration(left)}` : "Execute: set the fee";
    executeBtn.disabled = busy || !account || left > 0;
    const deposit = p.ballot && !p.ballot.withdrawn ? p.ballot.amount : 0n;
    withdrawBtn.hidden = open || deposit === 0n;
    withdrawBtn.textContent = `Take back ${formatTest(deposit)}`;
    withdrawBtn.disabled = busy;
    for (const button of [queueBtn, executeBtn]) {
      button.title = account ? "" : "Connect a wallet first";
    }
    actions.hidden = [queueBtn, executeBtn, withdrawBtn].every((button) => button.hidden);
  }
  paint();
  return { element: card, paint };
}

let listVersion = 0;

async function refreshProposals() {
  const version = ++listVersion;
  try {
    const count = await proposalsCount();
    if (version !== listVersion) return;
    if (count === 0n) {
      cards = [];
      proposalsEl.replaceChildren(element("p", "empty", "Nobody has proposed a fee yet."));
      return;
    }
    // Newest first. The reads go one after another: the node proxy is shared.
    const loaded: Proposal[] = [];
    const oldest = count > BigInt(LIST_LIMIT) ? count - BigInt(LIST_LIMIT) : 0n;
    for (let id = count - 1n; id >= oldest; id--) {
      loaded.push(await loadProposal(id));
      if (version !== listVersion) return;
    }
    const built = loaded.map(buildCard);
    const nodes: HTMLElement[] = built.map((card) => card.element);
    if (oldest > 0n) nodes.push(element("p", "empty", `${oldest} older proposals are not shown.`));
    proposalsEl.replaceChildren(...nodes);
    cards = built;
    if (account) {
      $("step-vote").classList.toggle(
        "done",
        loaded.some((p) => p.ballot !== null),
      );
      $("step-execute").classList.toggle(
        "done",
        loaded.some((p) => p.proposer === account?.address && done(p)),
      );
    }
  } catch (error) {
    if (version !== listVersion) return;
    cards = [];
    proposalsEl.replaceChildren(element("p", "notice", `Could not load: ${errorText(error)}`));
  }
}

async function refreshSettings() {
  try {
    const [fee, delay, period, needed, toPropose] = await Promise.all([
      feeStorage.read("fee_bps"),
      timelockStorage.read("min_delay"),
      governorStorage.read("voting_period"),
      governorStorage.read("quorum"),
      governorStorage.read("proposal_threshold"),
    ]);
    currentFee = fee === null ? null : Number(fee);
    feeEl.textContent = currentFee === null ? "—" : formatFee(currentFee);
    minDelay = Number(delay ?? "0");
    votingPeriod = Number(period ?? "0");
    quorum = BigInt(needed ?? "0");
    threshold = BigInt(toPropose ?? "0");
    minDelayEl.textContent = formatDuration(minDelay);
    $("step-delay").textContent = formatDuration(minDelay);
    $("step-period").textContent = formatDuration(votingPeriod);
    $("voting-period").textContent = formatDuration(votingPeriod);
    $("quorum").textContent = `at least ${formatTest(quorum)} for, and more for than against`;
    $("threshold").textContent = formatTest(threshold);
  } catch (error) {
    feeEl.textContent = "?";
    console.error(error);
  }
}

async function refreshBalance() {
  if (!account) {
    balance = 0n;
    balanceEl.textContent = "—";
    $("step-connect").classList.remove("done");
    return;
  }
  try {
    balance = await balanceOf(account.address);
    balanceEl.textContent = formatTest(balance);
    $("step-connect").classList.toggle("done", balance > 0n);
  } catch (error) {
    balanceEl.textContent = "?";
    console.error(error);
  }
}

function repaint() {
  for (const card of cards) card.paint();
  connectBtn.disabled = busy;
  faucetBtn.disabled = busy || !account;
  const fee = parseFee(fFee.value);
  proposeSubmit.disabled = busy || !account;
  proposeSubmit.textContent = !account
    ? "Connect a wallet to propose"
    : fee === null
      ? "Propose the fee"
      : `Propose a fee of ${formatFee(fee)}`;
}

async function refreshAll() {
  refreshState();
  repaint();
  // The settings first: the cards need the quorum.
  await Promise.all([refreshSettings(), refreshBalance()]);
  await refreshProposals();
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

const faucet = () =>
  withBusy(async () => {
    await send("Getting 1,000 TEST", GAS.faucet, () =>
      new TestTokenWasmClient(client, address(tokenAddress)).faucet(),
    );
  });

function castVote(p: Proposal, support: boolean, text: string) {
  const amount = parseTest(text);
  if (!account || !amount) return;
  if (amount > balance) {
    showTx(`You have ${formatTest(balance)}, less than ${formatTest(amount)}.`, { error: true });
    return;
  }
  const me = account.address;
  const side = support ? "for" : "against";
  void withBusy(async () => {
    // The governor takes the tokens with `transfer_from`: allow it first, if needed.
    let label = `Voting ${side} proposal #${p.id} with ${formatTest(amount)}`;
    if ((await allowanceOf(me, governorAddress)) < amount) {
      label = `Step 2 of 2, v${label.slice(1)}`;
      const approved = await send(
        `Step 1 of 2, letting the governor take ${formatTest(amount)}`,
        GAS.approve,
        () =>
          new TestTokenWasmClient(client, address(tokenAddress)).approve(
            address(governorAddress),
            U256.fromBigInt(amount),
          ),
      );
      if (!approved) return;
    }
    await send(label, GAS.vote, () => governor.vote(p.id, support, U256.fromBigInt(amount)));
  });
}

const queue = (p: Proposal) =>
  withBusy(async () => {
    await send(`Queueing proposal #${p.id} in the timelock`, GAS.queue, () => governor.queue(p.id));
  });

const execute = (p: Proposal) =>
  withBusy(async () => {
    await send(`Executing proposal #${p.id}`, GAS.execute, () => governor.execute(p.id));
  });

const withdraw = (p: Proposal) =>
  withBusy(async () => {
    const amount = p.ballot?.amount ?? 0n;
    await send(`Taking back ${formatTest(amount)}`, GAS.withdraw, () => governor.withdraw(p.id));
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
  if (balance < threshold) {
    return showProposeError(
      `To propose you need ${formatTest(threshold)}. Get 1,000 TEST from the faucet first.`,
    );
  }
  await withBusy(async () => {
    const proposed = await send(`Proposing a fee of ${formatFee(fee)}`, GAS.propose, () =>
      governor.propose(fee),
    );
    if (proposed) fFee.value = "";
  });
}

/** Says in a sentence what the proposal in the form will do. */
function updateSummary() {
  const fee = parseFee(fFee.value);
  const from = currentFee === null ? "" : ` from ${formatFee(currentFee)}`;
  summaryEl.textContent =
    fee === null
      ? "Enter a fee to see what will happen."
      : `A vote on changing the fee${from} to ${formatFee(fee)} opens at once and lasts ` +
        `${formatDuration(votingPeriod)}. If at least ${formatTest(quorum)} vote for it, and more for ` +
        `than against, anyone can queue it in the timelock, and ${formatDuration(minDelay)} later ` +
        `anyone can execute it.`;
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
  governorAddress = key(contracts.get("Governor").address);
  timelockAddress = key(contracts.get("Timelock").address);
  feeAddress = key(contracts.get("FeeConfig").address);
  tokenAddress = key(contracts.get("TestToken").address);
  governor = new GovernorWasmClient(client, address(governorAddress));
  [governorStorage, timelockStorage, feeStorage, tokenStorage] = await Promise.all([
    ContractStorage.open(governorSchema, governorAddress),
    ContractStorage.open(timelockSchema, timelockAddress),
    ContractStorage.open(feeConfigSchema, feeAddress),
    ContractStorage.open(testTokenSchema, tokenAddress),
  ]);

  $("governor-contract").textContent = governorAddress;
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
  faucetBtn.addEventListener("click", () => void faucet());
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
