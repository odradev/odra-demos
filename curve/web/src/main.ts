import "../../../style/odra.css";
import "./style.css";
import init, {
  AccountInfo,
  Address,
  Contracts,
  CsprClickCallbacks,
  CurveErrors,
  CurveWasmClient,
  OdraWasmClient,
  setGas,
  TransactionResult,
  TransactionStatus,
  U256,
  U512,
} from "curve-wasm-client";
import curveSchema from "../../resources/casper_contract_schemas/curve_schema.json";
import deployedContracts from "./contracts.json";
import { cost, Line, makeLine, price, proceeds, tokensFor } from "./curve";
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
 * Payment limits in motes. On the testnet in November 2026 a purchase used 3.92 CSPR (a payable
 * call runs through Odra's proxy session code) and a sale 3.18. A purchase that sends change back
 * makes one more transfer, 2.5 CSPR more on CasperVM. The network refunds three quarters of what a
 * transaction leaves unused, and charges the whole limit of one that fails.
 */
const GAS = {
  buy: 5n * CSPR,
  buyWithChange: 8n * CSPR,
  sell: 4n * CSPR,
};
/** How far below the quote a transaction may still fill, in percent. */
const SLIPPAGE = 1n;

const ERRORS: Record<number, string> = {
  [CurveErrors.ZeroAmount]: "The amount must be greater than zero.",
  [CurveErrors.NothingBought]: "That is not enough CSPR to buy any CURVE.",
  [CurveErrors.TooFewTokens]: "Someone bought first and the price moved more than 1%. Nothing was bought.",
  [CurveErrors.TooLittleCspr]: "Someone sold first and the price moved more than 1%. Nothing was sold.",
  [CurveErrors.Overflow]: "The amount is too large for the contract's arithmetic.",
  [CurveErrors.InsufficientBalance]: "You hold fewer CURVE than that.",
};

// ---------- State ----------

interface Snapshot {
  line: Line;
  decimals: number;
  symbol: string;
  supply: bigint;
  reserve: bigint;
}

/** What the form would do, to draw on the chart: the stretch of supply it adds or removes. */
interface Preview {
  kind: "buy" | "sell";
  from: bigint;
  to: bigint;
}

let client: OdraWasmClient;
let curve: CurveWasmClient;
let storage: ContractStorage;
let curveAddress: string;
let snapshot: Snapshot | null = null;
let account: { publicKey: string; address: string } | null = null;
let mine: bigint | null = null;
let myCspr: bigint | null = null;
let busy = false;
let tab: "buy" | "sell" = "buy";

// ---------- DOM ----------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const connectBtn = $<HTMLButtonElement>("connect");
const accountBox = $("account");
const accountKey = $("account-key");
const fatalBox = $("fatal");
const chart = document.getElementById("chart") as unknown as SVGSVGElement;
const chartCaption = $("chart-caption");
const fCspr = $<HTMLInputElement>("f-cspr");
const fTokens = $<HTMLInputElement>("f-tokens");
const buyForm = $<HTMLFormElement>("buy");
const sellForm = $<HTMLFormElement>("sell");
const buySummary = $("buy-summary");
const sellSummary = $("sell-summary");
const buySubmit = $<HTMLButtonElement>("buy-submit");
const sellSubmit = $<HTMLButtonElement>("sell-submit");
const buyError = $("buy-error");
const sellError = $("sell-error");
const txBox = $("tx");
const txText = $("tx-text");
const txLink = $<HTMLAnchorElement>("tx-link");

// ---------- Formatting ----------

const short = (value: string) => {
  const body = value.replace(/^(account-hash-|hash-)/, "");
  return body.length > 14 ? `${body.slice(0, 6)}…${body.slice(-6)}` : body;
};

/** Formats an amount of the smallest unit as a decimal number with up to `digits` fraction digits. */
function formatAmount(value: bigint, decimals: number, digits = 4): string {
  const base = 10n ** BigInt(decimals);
  const whole = (value / base).toLocaleString("en-US");
  const fraction = (value % base).toString().padStart(decimals, "0").slice(0, digits).replace(/0+$/, "");
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

const cspr = (motes: bigint, digits = 4) => `${formatAmount(motes, CSPR_DECIMALS, digits)} CSPR`;
const tokens = (units: bigint, digits = 4) =>
  `${formatAmount(units, snapshot?.decimals ?? 9, digits)} ${snapshot?.symbol ?? "CURVE"}`;

/**
 * The formatted key of an address: `account-hash-…` or `hash-…`. `Address.value` prints another
 * form (`entity-account-…`, `contract-package-…`), which `new Address` does not read back.
 *
 * Addresses are kept as strings: a call of the client consumes the `Address`, `U256` and `U512`
 * objects passed to it, so each call gets fresh ones.
 */
function key(parsed: Address): string {
  const value = parsed.value;
  const hex = value.slice(-64);
  return value.startsWith("contract-package-") || value.startsWith("hash-")
    ? `hash-${hex}`
    : `account-hash-${hex}`;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : JSON.stringify(error);
}

// ---------- Reading the contract ----------

// State is read from the node's storage (see storage.ts). The generated client is used only to
// send transactions.

const amount = async (path: string, keys: string[] = []) => BigInt((await storage.read(path, keys)) ?? "0");

async function loadSnapshot(): Promise<Snapshot> {
  const [basePrice, slope, decimals, symbol, supply, reserve] = await Promise.all([
    amount("base_price"),
    amount("slope"),
    storage.read("token.decimals"),
    storage.read("token.symbol"),
    amount("token.total_supply"),
    amount("reserve"),
  ]);
  const places = Number(decimals ?? "9");
  return {
    line: makeLine(basePrice, slope, places),
    decimals: places,
    symbol: symbol ?? "CURVE",
    supply,
    reserve,
  };
}

// ---------- The chart ----------

const SVG = "http://www.w3.org/2000/svg";
const W = 400;
const H = 240;
const PAD = { left: 52, right: 14, top: 30, bottom: 44 };

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | number>,
  text = "",
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  if (text) node.textContent = text;
  return node;
}

/** The smallest 1, 2 or 5 times a power of ten that is at least `value`. */
function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5, 10]) if (step * power >= value) return step * power;
  return 10 * power;
}

/** Whole tokens as a float, for drawing only. */
const whole = (units: bigint, unit: bigint) => Number(units) / Number(unit);

function drawChart(preview: Preview | null) {
  if (!snapshot) return;
  const { line, supply } = snapshot;
  const unit = line.unit;
  const now = whole(supply, unit);
  const reach = preview ? Math.max(whole(preview.from, unit), whole(preview.to, unit)) : 0;
  const xMax = niceCeil(Math.max(200, now * 1.6, reach * 1.2));
  const priceAt = (x: number) => Number(price(line, BigInt(Math.round(x * Number(unit))))) / Number(CSPR);
  // Three gridlines at a round step: the top one at or above the line's end.
  const yStep = niceCeil(priceAt(xMax) / 3);
  const yMax = yStep * 3;

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const px = (x: number) => PAD.left + (x / xMax) * plotW;
  const py = (y: number) => PAD.top + plotH - (y / yMax) * plotH;
  const bottom = py(0);
  const decimalsOf = (step: number) => (step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step))));

  const nodes: SVGElement[] = [];
  // Three faint lines and the axis.
  for (const step of [1, 2, 3]) {
    const y = yStep * step;
    nodes.push(svg("path", { class: "guide", d: `M${PAD.left} ${py(y)} H${W - PAD.right}` }));
    nodes.push(svg("text", { x: PAD.left - 6, y: py(y) + 4, "text-anchor": "end" }, y.toFixed(decimalsOf(yStep))));
  }
  nodes.push(svg("text", { x: PAD.left - 6, y: bottom + 4, "text-anchor": "end" }, "0"));
  nodes.push(svg("text", { x: PAD.left - 6, y: PAD.top - 16, "text-anchor": "end" }, "CSPR"));
  for (const share of [0, 0.5, 1]) {
    nodes.push(
      svg(
        "text",
        { x: px(xMax * share), y: bottom + 18, "text-anchor": share === 0 ? "start" : share === 1 ? "end" : "middle" },
        (xMax * share).toLocaleString("en-US"),
      ),
    );
  }
  nodes.push(svg("text", { x: px(xMax / 2), y: H - 4, "text-anchor": "middle" }, "CURVE in existence"));

  // The area under the line up to the supply: what the reserve holds.
  const area = (from: number, to: number, className: string) =>
    svg("path", {
      class: className,
      d: `M${px(from)} ${bottom} L${px(from)} ${py(priceAt(from))} L${px(to)} ${py(priceAt(to))} L${px(to)} ${bottom} Z`,
    });
  if (now > 0) nodes.push(area(0, now, "area"));
  if (preview && preview.from !== preview.to) {
    const from = whole(preview.from, unit);
    const to = whole(preview.to, unit);
    nodes.push(area(Math.min(from, to), Math.max(from, to), `preview ${preview.kind}`));
  }
  nodes.push(svg("path", { class: "axis", d: `M${PAD.left} ${PAD.top} V${bottom} H${W - PAD.right}` }));
  // The line itself is straight: two points draw it.
  nodes.push(svg("path", { class: "curve", d: `M${px(0)} ${py(priceAt(0))} L${px(xMax)} ${py(priceAt(xMax))}` }));

  // We are here.
  const hereX = px(now);
  const hereY = py(priceAt(now));
  nodes.push(svg("circle", { class: "point", cx: hereX, cy: hereY, r: 5 }));
  // The line rises to the right, so the label sits above and to the left of the point, clear of it;
  // near the left edge, below and to the right.
  const left = hereX > PAD.left + 120;
  nodes.push(
    svg(
      "text",
      {
        class: "here",
        x: hereX + (left ? -10 : 10),
        y: hereY + (left ? -10 : 20),
        "text-anchor": left ? "end" : "start",
      },
      `Now: ${formatAmount(price(line, supply), CSPR_DECIMALS)} CSPR`,
    ),
  );

  // A readout of the line under the pointer.
  const readout = svg("g", { class: "readout", visibility: "hidden" });
  const readLine = svg("path", { class: "guide", d: "" });
  const readDot = svg("circle", { class: "point", r: 3.5, cx: 0, cy: 0 });
  const readText = svg("text", { x: 0, y: PAD.top - 4 });
  readout.append(readLine, readDot, readText);
  nodes.push(readout);
  const catcher = svg("rect", {
    x: PAD.left,
    y: PAD.top,
    width: plotW,
    height: plotH,
    fill: "transparent",
  });
  catcher.addEventListener("pointermove", (event) => {
    const box = chart.getBoundingClientRect();
    const x = (((event.clientX - box.left) / box.width) * W - PAD.left) / plotW;
    const at = Math.min(Math.max(x, 0), 1) * xMax;
    const y = priceAt(at);
    readLine.setAttribute("d", `M${px(at)} ${PAD.top} V${bottom}`);
    readDot.setAttribute("cx", String(px(at)));
    readDot.setAttribute("cy", String(py(y)));
    const flip = px(at) > W - 150;
    readText.setAttribute("x", String(px(at) + (flip ? -6 : 6)));
    readText.setAttribute("text-anchor", flip ? "end" : "start");
    readText.textContent = `${at.toLocaleString("en-US", { maximumFractionDigits: 1 })} CURVE: ${y.toFixed(4)} CSPR`;
    readout.setAttribute("visibility", "visible");
  });
  catcher.addEventListener("pointerleave", () => readout.setAttribute("visibility", "hidden"));
  nodes.push(catcher);

  chart.replaceChildren(chart.querySelector("title")!, ...nodes);
  chartCaption.textContent = !preview
    ? "The price of a token, by how many exist. The shaded area is the reserve."
    : preview.kind === "buy"
      ? "The lighter stretch is your purchase: you pay the area under it."
      : "The lighter stretch is your sale: you are paid the area under it.";
}

/** The curve at a few supplies, as a table: the data of the chart. */
function drawTable() {
  if (!snapshot) return;
  const { line, supply } = snapshot;
  const top = niceCeil(Math.max(200, whole(supply, line.unit) * 1.6));
  const rows = [0, 0.1, 0.25, 0.5, 0.75, 1].map((share) => BigInt(Math.round(top * share)) * line.unit);
  $("curve-table").replaceChildren(
    ...rows.map((at) => {
      const row = document.createElement("tr");
      for (const text of [
        formatAmount(at, snapshot!.decimals, 0),
        formatAmount(price(line, at), CSPR_DECIMALS),
        formatAmount(cost(line, 0n, at), CSPR_DECIMALS),
      ]) {
        const cell = document.createElement("td");
        cell.textContent = text;
        row.append(cell);
      }
      return row;
    }),
  );
}

// ---------- The forms ----------

interface BuyQuote {
  paid: bigint;
  tokens: bigint;
  cost: bigint;
  min: bigint;
  /** The payment limit of the purchase. */
  gas: bigint;
}

interface SellQuote {
  tokens: bigint;
  proceeds: bigint;
  min: bigint;
}

/** What the CSPR in the buy form buys now, or why it cannot. */
function buyQuote(): BuyQuote | string {
  if (!snapshot) return "Loading the curve…";
  const paid = parseAmount(fCspr.value, CSPR_DECIMALS);
  if (paid === null) return "Enter an amount of CSPR, with up to 9 decimals.";
  if (paid === 0n) return "Enter an amount above zero.";
  const bought = tokensFor(snapshot.line, snapshot.supply, paid);
  if (bought === 0n) return "That is not enough CSPR to buy any CURVE.";
  // While a smallest unit costs less than a mote, the most the CSPR buys costs it exactly and
  // nothing comes back. Past that, the purchase may send change back: a transfer more. Twice the
  // purchase leaves room for others buying first.
  const change = price(snapshot.line, snapshot.supply + 2n * bought) >= snapshot.line.unit;
  return {
    paid,
    tokens: bought,
    cost: cost(snapshot.line, snapshot.supply, bought),
    min: (bought * (100n - SLIPPAGE)) / 100n,
    gas: change ? GAS.buyWithChange : GAS.buy,
  };
}

/** What selling the CURVE in the sell form pays now, or why it cannot. */
function sellQuote(): SellQuote | string {
  if (!snapshot) return "Loading the curve…";
  const sold = parseAmount(fTokens.value, snapshot.decimals);
  if (sold === null) return `Enter an amount of CURVE, with up to ${snapshot.decimals} decimals.`;
  if (sold === 0n) return "Enter an amount above zero.";
  if (mine !== null && sold > mine) return `You hold ${tokens(mine)}, less than that.`;
  if (sold > snapshot.supply) return `Only ${tokens(snapshot.supply)} exist.`;
  const paid = proceeds(snapshot.line, snapshot.supply, sold);
  return { tokens: sold, proceeds: paid, min: (paid * (100n - SLIPPAGE)) / 100n };
}

function renderForms() {
  let preview: Preview | null = null;
  if (tab === "buy") {
    const quote = buyQuote();
    if (typeof quote === "string") {
      buySummary.textContent = fCspr.value.trim() ? quote : "Enter an amount of CSPR to see what it buys.";
      buySubmit.textContent = account ? "Buy CURVE" : "Connect a wallet to buy";
    } else {
      const { line, supply } = snapshot!;
      const average = (quote.cost * line.unit) / quote.tokens;
      const change = quote.paid - quote.cost;
      buySummary.textContent =
        `You get ${tokens(quote.tokens)} for ${cspr(quote.paid)}, ${cspr(average)} each on average. ` +
        `The price moves from ${cspr(price(line, supply))} to ${cspr(price(line, supply + quote.tokens))}. ` +
        (change >= 100_000n ? `${cspr(change)} of what you send comes back. ` : "") +
        `If others buy first and it would get you less than ${tokens(quote.min)}, nothing is bought. ` +
        `The network fee is at most ${cspr(quote.gas, 0)}.`;
      buySubmit.textContent = account
        ? `Buy ${tokens(quote.tokens)} for ${cspr(quote.paid)}`
        : "Connect a wallet to buy";
      preview = { kind: "buy", from: supply, to: supply + quote.tokens };
    }
    buySubmit.disabled = busy || !account || typeof quote === "string";
  } else {
    const quote = sellQuote();
    if (typeof quote === "string") {
      sellSummary.textContent = fTokens.value.trim() ? quote : "Enter an amount of CURVE to see what it pays.";
      sellSubmit.textContent = account ? "Sell CURVE" : "Connect a wallet to sell";
    } else {
      const { line, supply } = snapshot!;
      sellSummary.textContent =
        `You get ${cspr(quote.proceeds)} for ${tokens(quote.tokens)}, ` +
        `${cspr((quote.proceeds * line.unit) / quote.tokens)} each on average. The contract burns them and the ` +
        `price moves from ${cspr(price(line, supply))} to ${cspr(price(line, supply - quote.tokens))}. ` +
        `If others sell first and it would pay less than ${cspr(quote.min)}, nothing is sold. ` +
        `The network fee is at most ${cspr(GAS.sell, 0)}.`;
      sellSubmit.textContent = account
        ? `Sell ${tokens(quote.tokens)} for ${cspr(quote.proceeds)}`
        : "Connect a wallet to sell";
      preview = { kind: "sell", from: supply, to: supply - quote.tokens };
    }
    sellSubmit.disabled = busy || !account || typeof quote === "string" || !mine;
  }
  drawChart(preview);
}

function selectTab(next: "buy" | "sell") {
  tab = next;
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
    const active = button.dataset.tab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  }
  buyForm.hidden = tab !== "buy";
  sellForm.hidden = tab !== "sell";
  $("trade-title").textContent = tab === "buy" ? "Buy CURVE" : "Sell CURVE";
  renderForms();
}

// ---------- Rendering the state ----------

function renderState() {
  if (!snapshot) return;
  const { line, supply, reserve, decimals } = snapshot;
  $("t-price").textContent = formatAmount(price(line, supply), CSPR_DECIMALS);
  $("t-price-sub").textContent = `CSPR, up from ${formatAmount(line.basePrice, CSPR_DECIMALS)} at the start`;
  $("t-supply").textContent = formatAmount(supply, decimals, 2);
  $("t-reserve").textContent = formatAmount(reserve, CSPR_DECIMALS, 2);
  $("p-base").textContent = formatAmount(line.basePrice, CSPR_DECIMALS);
  $("p-slope").textContent = formatAmount(line.slope, CSPR_DECIMALS);

  if (!account) {
    $("t-mine").textContent = "—";
    $("t-mine-sub").textContent = "Connect a wallet to see it";
  } else if (mine === null) {
    $("t-mine").textContent = "?";
    $("t-mine-sub").textContent = "Could not read it";
  } else {
    $("t-mine").textContent = formatAmount(mine, decimals, 2);
    $("t-mine-sub").textContent =
      mine === 0n ? "CURVE. Buy some to start" : `CURVE, worth ${cspr(proceeds(line, supply, mine), 2)} if sold now`;
  }
  $("cspr-balance").textContent = myCspr === null ? "—" : cspr(myCspr, 2);
  $("step-connect").classList.toggle("done", account !== null);
  $("step-cspr").classList.toggle("done", myCspr !== null && myCspr > 0n);
  $("step-trade").classList.toggle("done", mine !== null && mine > 0n);
  $("f-tokens-hint").textContent =
    mine === null ? "The contract burns them and pays you in CSPR." : `You hold ${tokens(mine)}.`;
  $("f-cspr-hint").textContent =
    myCspr === null ? "The contract mints as many CURVE as this buys." : `You have ${cspr(myCspr, 2)}.`;
  drawTable();
  renderForms();
}

async function refreshAll() {
  refreshState();
  try {
    snapshot = await loadSnapshot();
    if (account) {
      const me = account.address;
      const [held, balance] = await Promise.all([amount("token.balances", [me]), csprBalance(me)]);
      if (account?.address === me) {
        mine = held;
        myCspr = balance;
      }
    } else {
      mine = null;
      myCspr = null;
    }
  } catch (error) {
    showTx(`Could not read the contract: ${errorText(error)}`, { error: true });
  }
  renderState();
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

/** Runs a transaction with the buttons disabled, then reloads the state. */
async function withBusy(action: () => Promise<void>) {
  if (busy) return;
  busy = true;
  renderForms();
  connectBtn.disabled = true;
  try {
    await action();
  } finally {
    busy = false;
    connectBtn.disabled = false;
    await refreshAll();
  }
}

function showError(box: HTMLElement, text: string) {
  box.textContent = text;
  box.hidden = !text;
}

async function buy() {
  showError(buyError, "");
  if (!account) return;
  await refreshAll();
  const quote = buyQuote();
  if (typeof quote === "string") return showError(buyError, quote);
  if (myCspr !== null && myCspr < quote.paid + quote.gas) {
    return showError(buyError, `You have ${cspr(myCspr)}: not enough for ${cspr(quote.paid)} and the fee.`);
  }
  await withBusy(async () => {
    const done = await send(`Buying ${tokens(quote.tokens)} for ${cspr(quote.paid)}`, quote.gas, () =>
      curve.buy(U256.fromBigInt(quote.min), U512.fromBigInt(quote.paid)),
    );
    if (done) fCspr.value = "";
  });
}

async function sell() {
  showError(sellError, "");
  if (!account) return;
  await refreshAll();
  const quote = sellQuote();
  if (typeof quote === "string") return showError(sellError, quote);
  if (myCspr !== null && myCspr < GAS.sell) {
    return showError(sellError, `You have ${cspr(myCspr)}: not enough for the fee.`);
  }
  await withBusy(async () => {
    const done = await send(`Selling ${tokens(quote.tokens)} for ${cspr(quote.proceeds)}`, GAS.sell, () =>
      curve.sell(U256.fromBigInt(quote.tokens), U512.fromBigInt(quote.min)),
    );
    if (done) fTokens.value = "";
  });
}

// ---------- Wallet ----------

async function onAccount(info: AccountInfo) {
  account = { publicKey: info.publicKey, address: key(info.address) };
  mine = null;
  myCspr = null;
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

function fact(name: string, value: string) {
  const dt = document.createElement("dt");
  const dd = document.createElement("dd");
  dt.textContent = name;
  dd.textContent = value;
  dd.className = "mono";
  $("facts").append(dt, dd);
}

// ---------- Start ----------

async function run() {
  await Promise.all([init(), initStorage(RPC_URL)]);

  const contracts = new Contracts(deployedContracts);
  client = new OdraWasmClient(RPC_URL, SPECULATIVE_RPC_URL, CHAIN_NAME);
  curveAddress = key(contracts.get("Curve").address);
  curve = new CurveWasmClient(client, new Address(curveAddress));
  storage = await ContractStorage.open(curveSchema, curveAddress);

  $("contract").textContent = `Curve contract: ${curveAddress}.`;
  // A visitor sees the curve straight away, without a wallet.
  await refreshAll();
  if (snapshot) {
    fact("Token", `${snapshot.symbol}, ${snapshot.decimals} decimals`);
    fact("Package hash", curveAddress);
    fact("Base price", `${formatAmount(snapshot.line.basePrice, CSPR_DECIMALS, 9)} CSPR`);
    fact("Slope", `${formatAmount(snapshot.line.slope, CSPR_DECIMALS, 9)} CSPR per token`);
  }

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
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
    button.addEventListener("click", () => selectTab(button.dataset.tab as "buy" | "sell"));
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-cspr]")) {
    button.addEventListener("click", () => {
      fCspr.value = button.dataset.cspr!;
      renderForms();
    });
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-share]")) {
    button.addEventListener("click", () => {
      if (mine === null || !snapshot) return;
      const share = (mine * BigInt(button.dataset.share!)) / 100n;
      fTokens.value = formatAmount(share, snapshot.decimals, snapshot.decimals).replace(/,/g, "");
      renderForms();
    });
  }
  fCspr.addEventListener("input", renderForms);
  fTokens.addEventListener("input", renderForms);
  buyForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void buy();
  });
  sellForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void sell();
  });
  $("tx-close").addEventListener("click", () => (txBox.hidden = true));

  // Others trade too: follow the curve without asking the user to reload.
  setInterval(() => {
    if (!busy) void refreshAll();
  }, 30_000);

  // Loaded last: the client listens for the events the script sends once it is ready.
  await loadCsprClick();
  connectBtn.disabled = false;
}

run().catch((error) => {
  console.error(error);
  fatalBox.textContent = `The app could not start: ${errorText(error)}`;
  fatalBox.hidden = false;
});
