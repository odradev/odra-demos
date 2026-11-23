import "../../../style/odra.css";
import "./style.css";
import init, {
  AccountInfo,
  Address,
  Contracts,
  CsprClickCallbacks,
  MultisendErrors,
  MultisendWasmClient,
  OdraWasmClient,
  setGas,
  TestTokenErrors,
  TestTokenWasmClient,
  TransactionResult,
  TransactionStatus,
  U256,
  U512,
} from "multisend-wasm-client";
import testTokenSchema from "../../resources/casper_contract_schemas/test_token_schema.json";
import deployedContracts from "./contracts.json";
import { ContractStorage, csprBalance, initStorage, refreshState } from "./storage";

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
/**
 * The most recipients the app puts in one transaction. The arguments of a transaction may take
 * 2048 bytes on the testnet, which is about 50 recipients; 60 were rejected when tried.
 */
const MAX_RECIPIENTS = 40;

/**
 * Payment limits in motes, from what the calls used on the testnet in November 2026: a token
 * send used 0.2 CSPR and 1.0 more per recipient, a CSPR send 4.7 CSPR and 2.1 more per recipient.
 * The network refunds three quarters of what a transaction leaves unused.
 */
const GAS = {
  faucet: 5n * CSPR,
  approve: 5n * CSPR,
  sendToken: (recipients: number) => 2n * CSPR + BigInt(recipients) * 1_200_000_000n,
  sendCspr: (recipients: number) => 8n * CSPR + BigInt(recipients) * 2_600_000_000n,
};

const ERRORS: Record<number, string> = {
  [MultisendErrors.NoRecipients]: "The list of recipients is empty.",
  [MultisendErrors.LengthMismatch]: "The list has a recipient without an amount.",
  [MultisendErrors.ZeroAmount]: "One of the amounts is zero.",
  [MultisendErrors.WrongAttachedValue]: "The CSPR sent along is not the sum of the amounts.",
  [MultisendErrors.AmountOverflow]: "The amounts add up to more than can be sent.",
  [TestTokenErrors.InsufficientBalance]: "The token balance is too low.",
  [TestTokenErrors.InsufficientAllowance]: "The token allowance is too low.",
  [TestTokenErrors.CannotTargetSelfUser]: "A token cannot be sent to the account it comes from.",
};

// ---------- Types ----------

type Asset = "token" | "cspr";

interface Unit {
  symbol: string;
  decimals: number;
}

/** One line of the list: what was typed and, when it is valid, what it means. */
interface Row {
  line: number;
  text: string;
  recipient?: string;
  amount?: bigint;
  problem?: string;
}

// ---------- State ----------

let client: OdraWasmClient;
let multisend: MultisendWasmClient;
let multisendAddress: string;
let testTokenHash: string;
let account: { publicKey: string; address: string } | null = null;
let asset: Asset = "token";
/** The token the form sends when the asset is a token, as a formatted key. */
let token = "";
let tokenUnit: Unit = { symbol: "TEST", decimals: 9 };
let rows: Row[] = [];
/** The sender's balance of what is being sent; `null` until it is read. */
let available: bigint | null = null;
let busy = false;
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
const sendForm = $<HTMLFormElement>("send");
const sendError = $("send-error");
const sendSubmit = $<HTMLButtonElement>("send-submit");
const sendHint = $("send-hint");
const tokenField = $<HTMLDetailsElement>("token-field");
const fToken = $<HTMLInputElement>("f-token");
const fTokenInfo = $("f-token-info");
const fList = $<HTMLTextAreaElement>("f-list");
const summaryEl = $("summary");
const previewEl = $("preview");
const txBox = $("tx");
const txText = $("tx-text");
const txLink = $<HTMLAnchorElement>("tx-link");

// ---------- Formatting ----------

const unit = (): Unit => (asset === "cspr" ? { symbol: "CSPR", decimals: CSPR_DECIMALS } : tokenUnit);

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

const show = (value: bigint) => `${formatAmount(value, unit().decimals)} ${unit().symbol}`;

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
 * Addresses are kept as strings: a call of the client consumes the `Address`, `U256` and `U512`
 * objects passed to it, so each call gets fresh ones (`address(text)`).
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

// ---------- The list ----------

/** Reads the textarea into rows: an address and an amount per line, separated by commas or spaces. */
function parseList(): Row[] {
  const { decimals, symbol } = unit();
  const parsed: Row[] = [];
  fList.value.split("\n").forEach((raw, index) => {
    const text = raw.trim();
    if (!text) return;
    const row: Row = { line: index + 1, text };
    const parts = text.split(/[\s,;]+/).filter(Boolean);
    if (parts.length !== 2) {
      row.problem = "Expected an address and an amount";
    } else {
      try {
        row.recipient = parseAddress(parts[0]);
      } catch {
        row.problem = "Not an address";
      }
      const amount = parseAmount(parts[1], decimals);
      if (!row.problem && amount === null) {
        row.problem = `Not an amount of ${symbol} (up to ${decimals} decimals, with a dot)`;
      } else if (!row.problem && amount === 0n) {
        row.problem = "The amount is zero";
      } else if (!row.problem && asset === "token" && row.recipient === account?.address) {
        row.problem = "This is you: a token cannot be sent to its own sender";
      }
      row.amount = amount ?? undefined;
    }
    parsed.push(row);
  });
  return parsed;
}

const validRows = () => rows.filter((row) => !row.problem);
const total = () => validRows().reduce((sum, row) => sum + row.amount!, 0n);

/** What stops the list from being sent, or an empty string when it can be. */
function blocker(): string {
  if (rows.length === 0) return "Paste at least one recipient.";
  const broken = rows.filter((row) => row.problem);
  if (broken.length > 0) {
    const lines = broken.map((row) => row.line).join(", ");
    return `Fix line${broken.length === 1 ? "" : "s"} ${lines} first; see the list on the right.`;
  }
  if (rows.length > MAX_RECIPIENTS) {
    return `${rows.length} recipients do not fit in one transaction. Send ${MAX_RECIPIENTS} at a time.`;
  }
  if (account && available !== null && available < total()) {
    return `The list adds up to ${show(total())}, and you have ${show(available)}.`;
  }
  return "";
}

const gasLimit = () => (asset === "token" ? GAS.sendToken(rows.length) : GAS.sendCspr(rows.length));

function renderPreview() {
  if (rows.length === 0) {
    previewEl.replaceChildren(element("p", "empty", "Nothing yet. Paste a list on the left."));
    return;
  }
  const table = element("table");
  const head = element("tr");
  head.append(element("th", "", "Recipient"), element("th", "", `Amount, ${unit().symbol}`));
  const thead = element("thead");
  thead.append(head);

  const tbody = element("tbody");
  for (const row of rows) {
    const tr = element("tr");
    const recipient = element("td");
    if (row.problem) {
      recipient.append(
        element("span", "mono", row.text.slice(0, 40)),
        " ",
        element("span", "chip warn", row.problem),
      );
    } else {
      const name = element("span", "mono", short(row.recipient!));
      name.title = row.recipient!;
      recipient.append(name);
    }
    const amount = row.amount !== undefined && !row.problem ? formatAmount(row.amount, unit().decimals) : "—";
    tr.append(recipient, element("td", "", amount));
    tbody.append(tr);
  }

  const foot = element("tr", "total");
  const count = validRows().length;
  foot.append(
    element("td", "", `${count} recipient${count === 1 ? "" : "s"}`),
    element("td", "", formatAmount(total(), unit().decimals)),
  );
  const tfoot = element("tfoot");
  tfoot.append(foot);

  table.append(thead, tbody, tfoot);
  const scroll = element("div", "scroll");
  scroll.append(table);
  previewEl.replaceChildren(scroll);
}

/** Says in a sentence what sending the list will do, and sets the button to match. */
function renderSummary() {
  const stop = blocker();
  const count = rows.length;
  const people = `${count} recipient${count === 1 ? "" : "s"}`;

  if (stop) {
    summaryEl.textContent = stop;
    sendSubmit.textContent = account ? "Send" : "Connect a wallet to send";
  } else {
    const have = account && available !== null ? ` You have ${show(available)}.` : "";
    summaryEl.textContent = `${people} get ${show(total())} in total, in one transaction: all of them or none.${have}`;
    sendSubmit.textContent = account ? `Send ${show(total())} to ${people}` : "Connect a wallet to send";
  }
  sendSubmit.disabled = busy || !account || stop !== "";

  const fee = `The network takes up to ${formatAmount(gasLimit(), CSPR_DECIMALS)} CSPR as a fee and refunds most of what is not used.`;
  sendHint.textContent =
    asset === "token"
      ? `Your wallet will ask twice: first to let the contract move the tokens, then to send them. ${fee}`
      : `Your wallet will ask once. ${fee}`;
}

function refreshList() {
  rows = parseList();
  renderPreview();
  renderSummary();
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
    available = asset === "cspr" ? await csprBalance(me) : await balanceOf(token, me);
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
}

async function refreshAll() {
  refreshState();
  repaint();
  await refreshBalances();
  refreshList();
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

function showSendError(text: string) {
  sendError.textContent = text;
  sendError.hidden = !text;
}

async function sendList() {
  showSendError("");
  refreshList();
  if (!account || blocker()) return;

  // The list as it is now: what the reader checked is what gets sent.
  const list = validRows().map((row) => ({ recipient: row.recipient!, amount: row.amount! }));
  const sum = total();
  const people = `${list.length} recipient${list.length === 1 ? "" : "s"}`;
  const what = show(sum);
  const sending = asset;
  const sendingToken = token;

  await withBusy(async () => {
    const me = account!.address;
    let sent: boolean;
    if (sending === "cspr") {
      if ((await csprBalance(me)) < sum + GAS.sendCspr(list.length)) {
        return showSendError(`You need ${what} and the fee in your wallet.`);
      }
      sent = await send(`Sending ${what} to ${people}`, GAS.sendCspr(list.length), () =>
        multisend.sendCspr(
          list.map((entry) => address(entry.recipient)),
          list.map((entry) => U512.fromBigInt(entry.amount)),
          U512.fromBigInt(sum),
        ),
      );
    } else {
      if ((await balanceOf(sendingToken, me)) < sum) {
        return showSendError(`You have less than ${what}.`);
      }
      if ((await allowanceOf(sendingToken, me, multisendAddress)) < sum) {
        const approved = await send(
          "Step 1 of 2, allowing the contract to move the tokens",
          GAS.approve,
          () => tokenClient(sendingToken).approve(address(multisendAddress), U256.fromBigInt(sum)),
        );
        if (!approved) return;
      }
      sent = await send(`Step 2 of 2, sending ${what} to ${people}`, GAS.sendToken(list.length), () =>
        multisend.sendToken(
          address(sendingToken),
          list.map((entry) => address(entry.recipient)),
          list.map((entry) => U256.fromBigInt(entry.amount)),
        ),
      );
    }
    if (sent) {
      fList.value = "";
      $("step-send").classList.add("done");
    }
  });
}

// ---------- Form helpers ----------

async function setAsset(next: Asset) {
  asset = next;
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-asset]")) {
    button.classList.toggle("active", button.dataset.asset === asset);
  }
  tokenField.hidden = asset !== "token";
  $("unit-hint").textContent = unit().symbol;
  available = null;
  refreshList();
  await refreshBalances();
  refreshList();
}

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
  $<HTMLButtonElement>("asset-token").textContent = found.symbol;
  await setAsset(asset);
}

/** Three accounts made up on the spot: nobody holds their keys, so use amounts you can lose. */
function fillExample() {
  const randomAccount = () =>
    "account-hash-" +
    [...crypto.getRandomValues(new Uint8Array(32))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  const amounts = asset === "cspr" ? ["2.5", "2.5", "2.5"] : ["25", "10.5", "4"];
  fList.value = amounts.map((amount) => `${randomAccount()}, ${amount}`).join("\n");
  refreshList();
  fList.scrollIntoView({ behavior: "smooth", block: "center" });
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
  multisendAddress = key(contracts.get("Multisend").address);
  multisend = new MultisendWasmClient(client, address(multisendAddress));
  testTokenHash = key(contracts.get("TestToken").address);
  token = testTokenHash;

  $("contract").textContent = `Multisend contract: ${multisendAddress}.`;
  $("max-recipients").textContent = String(MAX_RECIPIENTS);
  await setAsset("token");

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
  sendForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void sendList();
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-asset]")) {
    button.addEventListener("click", () => void setAsset(button.dataset.asset as Asset));
  }
  fToken.addEventListener("change", () => void setToken());
  fList.addEventListener("input", refreshList);
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
