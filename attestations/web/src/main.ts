import "../../../style/odra.css";
import "./style.css";
import init, {
  AccountInfo,
  Address,
  AttestationRegistryErrors,
  AttestationRegistryWasmClient,
  Contracts,
  CsprClickCallbacks,
  OdraWasmClient,
  setGas,
  TransactionResult,
  TransactionStatus,
} from "attestations-wasm-client";
import registrySchema from "../../resources/casper_contract_schemas/attestation_registry_schema.json";
import deployedContracts from "./contracts.json";
import { looksLikeName, nameOf, resolveName } from "./names";
import { ContractStorage, formattedKey, initStorage, Node } from "./storage";

// ---------- Configuration ----------

// A proxy of the Odra team: public nodes do not accept requests from a browser.
const RPC_URL = "https://testnet-rpc.odra.dev";
// The client wants a node for simulated calls too. The app makes none: it reads storage instead.
const SPECULATIVE_RPC_URL = "https://testnet-speculative-rpc.odra.dev";
const CHAIN_NAME = "casper-test";
const EXPLORER = "https://testnet.cspr.live";
const CSPR_CLICK_SCRIPT = "https://cdn.cspr.click/ui/v1.10.1/csprclick-client-1.10.1.js";

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
/** The longest name of a schema and the longest note, in bytes: the limits of the contract. */
const MAX_NAME_BYTES = 64;
const MAX_DATA_BYTES = 128;
/**
 * How far the clock of this computer may be from the chain's. The contract rejects an expiry
 * that is not after the block time; a transaction sent too close to it could fail, and a failed
 * one is charged its whole fee.
 */
const CLOCK_MARGIN = MINUTE;
/** How many ids of a list are read at once. */
const BATCH = 10;

/**
 * Payment limits in motes. Measured on CasperVM and NCTL in November 2026: register_schema 0.91
 * CSPR, attest 1.64 to 1.74 whatever the number of statements before, revoke 0.50. 2.5 CSPR is
 * the smallest limit worth setting for a contract call; the network refunds three quarters of
 * what a transaction leaves unused.
 */
const GAS = {
  register: 2_500_000_000n,
  attest: 2_500_000_000n,
  revoke: 2_500_000_000n,
};

const ERRORS: Record<number, string> = {
  [AttestationRegistryErrors.EmptyName]: "The schema needs a name.",
  [AttestationRegistryErrors.NameTooLong]: `The name is longer than ${MAX_NAME_BYTES} bytes.`,
  [AttestationRegistryErrors.DataTooLong]: `The note is longer than ${MAX_DATA_BYTES} bytes.`,
  [AttestationRegistryErrors.ExpiryInPast]: "The expiry had passed by the time the network got the transaction.",
  [AttestationRegistryErrors.SchemaNotFound]: "There is no schema with this number.",
  [AttestationRegistryErrors.AttestationNotFound]: "There is no statement with this number.",
  [AttestationRegistryErrors.NotIssuer]: "Only the issuer of the schema can do this.",
  [AttestationRegistryErrors.NotRevocable]: "Statements under this schema cannot be revoked.",
  [AttestationRegistryErrors.AlreadyRevoked]: "The statement was revoked already.",
};

// ---------- Types ----------

interface Schema {
  id: number;
  issuer: string;
  name: string;
  revocable: boolean;
  attestations: number;
}

interface Attestation {
  id: number;
  schemaId: number;
  issuer: string;
  subject: string;
  data: string;
  issuedAt: number;
  /** Block time in milliseconds, or `null` for never. */
  expires: number | null;
  revoked: boolean;
  revokedAt: number;
}

/** Whether a statement holds, worked out in the page by the rule of `is_valid`. */
type Status =
  | { kind: "valid" }
  | { kind: "expired" }
  | { kind: "revoked" }
  | { kind: "replaced"; by: number };

/** A statement with what the page needs to show it. */
interface Shown {
  attestation: Attestation;
  schema: Schema;
  status: Status;
}

type Tab = "about" | "issued" | "schemas";

// ---------- State ----------

let client: OdraWasmClient;
let registry: AttestationRegistryWasmClient;
let registryAddress: string;
let node: Node;
let storage: ContractStorage;
let account: { publicKey: string; address: string } | null = null;
let busy = false;
let tab: Tab = "about";
/** The account the lookup shows, as a formatted key; `null` before the first lookup. */
let lookedUp: string | null = null;
/** The schemas of the connected account, oldest first. */
let mySchemas: Schema[] = [];
/** The schema the attest form attests under. */
let chosenSchema: number | null = null;
/** The subject typed in the attest form, once it is read: a formatted key, or `null`. */
let subject: string | null = null;
/** Increases with every read, so that a slow read does not paint over a newer one. */
let lookupRead = 0;
let mineRead = 0;
let subjectRead = 0;

const schemas = new Map<number, Promise<Schema | null>>();
const currents = new Map<string, Promise<number | null>>();

// ---------- DOM ----------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const connectBtn = $<HTMLButtonElement>("connect");
const accountBox = $("account");
const accountKey = $("account-key");
const fatalBox = $("fatal");
const lookupForm = $<HTMLFormElement>("lookup");
const lAccount = $<HTMLInputElement>("l-account");
const lookupHint = $("lookup-hint");
const foundTitle = $("found-title");
const foundAsof = $("found-asof");
const foundTiles = $("found-tiles");
const foundEl = $("found");
const schemaForm = $<HTMLFormElement>("schema");
const sName = $<HTMLInputElement>("s-name");
const sNameHint = $("s-name-hint");
const sRevocable = $<HTMLInputElement>("s-revocable");
const schemaError = $("schema-error");
const schemaSubmit = $<HTMLButtonElement>("schema-submit");
const attestForm = $<HTMLFormElement>("attest");
const aSchemas = $("a-schemas");
const aSchemasEmpty = $("a-schemas-empty");
const aSubject = $<HTMLInputElement>("a-subject");
const aSubjectInfo = $("a-subject-info");
const aData = $<HTMLInputElement>("a-data");
const aExpires = $<HTMLInputElement>("a-expires");
const attestSummary = $("attest-summary");
const attestError = $("attest-error");
const attestSubmit = $<HTMLButtonElement>("attest-submit");
const mineEl = $("mine");
const txBox = $("tx");
const txText = $("tx-text");
const txLink = $<HTMLAnchorElement>("tx-link");

// ---------- Formatting ----------

const short = (value: string) => {
  const body = value.replace(/^(account-hash-|hash-)/, "");
  return body.length > 14 ? `${body.slice(0, 6)}…${body.slice(-6)}` : body;
};

const bytes = (text: string) => new TextEncoder().encode(text).length;

/**
 * Reads an address from a public key (`01…`, `02…`) or a formatted key (`account-hash-…`,
 * `hash-…`) and returns it as a formatted key. Throws if the text is neither.
 *
 * Addresses are kept as strings: a call of the client consumes the `Address` objects passed to
 * it, so each call gets a fresh one (`address(text)`).
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

/** Reads what was typed as an account: an address or a CSPR.name name. `null` if it is neither. */
async function readAccount(text: string): Promise<string | null> {
  const typed = text.trim();
  if (!typed) return null;
  if (looksLikeName(typed)) {
    try {
      return await resolveName(typed);
    } catch {
      return null;
    }
  }
  try {
    return parseAddress(typed);
  } catch {
    return null;
  }
}

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

/**
 * An account as a reader sees it: "you", or its CSPR.name name once that is read from the
 * mainnet, or a shortened address. The full address is in the tooltip.
 */
function who(formatted: string, className = "mono"): HTMLElement {
  const span = element("span", className, account?.address === formatted ? "you" : short(formatted));
  span.title = formatted;
  if (account?.address !== formatted) {
    void nameOf(formatted).then((name) => {
      if (!name) return;
      span.textContent = name;
      span.classList.remove("mono");
      span.title = `${formatted} (name read from the mainnet)`;
    });
  }
  return span;
}

// ---------- Reading the chain ----------

// State is read from the node's storage (see storage.ts). The generated client is used only to
// send transactions.

/** Forgets what was read, so the next reads see the latest state. Call after a transaction. */
function refreshState() {
  node.refresh();
  schemas.clear();
  currents.clear();
}

function readSchema(id: number): Promise<Schema | null> {
  let found = schemas.get(id);
  if (!found) {
    found = storage.read("schemas", [String(id)]).then((stored) => {
      if (stored === null) return null;
      // A struct is printed as a JSON object whose values are all strings.
      const schema: Record<string, string> = JSON.parse(stored);
      return {
        id,
        issuer: formattedKey(schema.issuer),
        name: schema.name,
        revocable: schema.revocable === "true",
        attestations: Number(schema.attestations),
      };
    });
    found.catch(() => schemas.delete(id));
    schemas.set(id, found);
  }
  return found;
}

async function readAttestation(id: number): Promise<Attestation | null> {
  const stored = await storage.read("attestations", [String(id)]);
  if (stored === null) return null;
  const attestation: Record<string, string> = JSON.parse(stored);
  return {
    id,
    schemaId: Number(attestation.schema_id),
    issuer: formattedKey(attestation.issuer),
    subject: formattedKey(attestation.subject),
    data: attestation.data,
    issuedAt: Number(attestation.issued_at),
    // An `Option` is printed as its value, or `None`.
    expires: attestation.expires === "None" ? null : Number(attestation.expires),
    revoked: attestation.revoked === "true",
    revokedAt: Number(attestation.revoked_at),
  };
}

/** The id of the statement `is_valid` checks for a schema and a subject, or `null`. */
function readCurrent(schemaId: number, subject: string): Promise<number | null> {
  const id = `${schemaId}:${subject}`;
  let found = currents.get(id);
  if (!found) {
    found = storage.read("current", [id]).then((stored) => (stored === null ? null : Number(stored)));
    found.catch(() => currents.delete(id));
    currents.set(id, found);
  }
  return found;
}

/**
 * The ids stored in the list `field` of an account (`by_subject`, `by_issuer`,
 * `schemas_by_issuer`). The length of a list kept per account is not readable, so the items are
 * read a batch at a time until one is missing.
 */
async function readIds(field: string, owner: string): Promise<number[]> {
  const ids: number[] = [];
  for (;;) {
    const from = ids.length;
    const batch = await Promise.all(
      Array.from({ length: BATCH }, (_, i) => storage.read(field, [owner, String(from + i)])),
    );
    for (const stored of batch) {
      if (stored === null) return ids;
      ids.push(Number(stored));
    }
  }
}

/** Whether a statement holds now. The rule of the contract's `is_valid`, on this computer's clock. */
function statusOf(attestation: Attestation, current: number | null): Status {
  if (attestation.revoked) return { kind: "revoked" };
  if (current !== null && current !== attestation.id) return { kind: "replaced", by: current };
  if (attestation.expires !== null && Date.now() >= attestation.expires) return { kind: "expired" };
  return { kind: "valid" };
}

/** Reads the statements with the given ids, newest first, with their schemas and status. */
async function readShown(ids: number[]): Promise<Shown[]> {
  const shown = await Promise.all(
    [...ids].reverse().map(async (id) => {
      const attestation = await readAttestation(id);
      if (!attestation) return null;
      const [schema, current] = await Promise.all([
        readSchema(attestation.schemaId),
        readCurrent(attestation.schemaId, attestation.subject),
      ]);
      if (!schema) return null;
      return { attestation, schema, status: statusOf(attestation, current) };
    }),
  );
  return shown.filter((item): item is Shown => item !== null);
}

// ---------- Showing statements ----------

function chip(status: Status, attestation: Attestation): HTMLElement {
  switch (status.kind) {
    case "valid":
      return element(
        "span",
        "chip good",
        attestation.expires === null ? "Valid" : `Valid until ${formatDate(attestation.expires)}`,
      );
    case "expired":
      return element("span", "chip", `Expired ${formatDate(attestation.expires!)}`);
    case "revoked":
      return element("span", "chip warn", `Revoked ${formatDate(attestation.revokedAt)}`);
    case "replaced":
      return element("span", "chip", `Replaced by #${status.by}`);
  }
}

/** One statement. `side` says whose list it is in, which decides who is named in its line. */
function renderAttestation({ attestation, schema, status }: Shown, side: "subject" | "issuer"): HTMLElement {
  const card = element("article", "item");

  const head = element("div", "head");
  const heading = element("div");
  const from = element("div", "from", `#${attestation.id} · `);
  if (side === "subject") from.append("by ", who(attestation.issuer));
  else from.append("about ", who(attestation.subject));
  heading.append(element("div", "title", schema.name), from);
  head.append(heading, chip(status, attestation));
  const parts: HTMLElement[] = [head];

  if (attestation.data) parts.push(element("p", "note", attestation.data));

  const canRevoke =
    account?.address === attestation.issuer && schema.revocable && !attestation.revoked;
  if (canRevoke) {
    const actions = element("div", "actions");
    const button = element("button", "small", "Revoke");
    button.disabled = busy;
    button.addEventListener("click", () => void revoke(attestation, schema));
    actions.append(button);
    parts.push(actions);
  }

  const details = element("details");
  const facts = element("dl", "facts");
  const fact = (name: string, value: string, mono = true) =>
    facts.append(element("dt", "", name), element("dd", mono ? "mono" : "", value));
  fact("Schema", `#${schema.id}${schema.revocable ? ", revocable" : ", not revocable"}`, false);
  fact("Issuer", attestation.issuer);
  fact("About", attestation.subject);
  fact("Made", formatDate(attestation.issuedAt), false);
  fact("Expires", attestation.expires === null ? "Never" : formatDate(attestation.expires), false);
  if (attestation.revoked) fact("Revoked", formatDate(attestation.revokedAt), false);
  details.append(element("summary", "", "Details"), facts);
  parts.push(details);

  card.append(...parts);
  return card;
}

function renderSchema(schema: Schema): HTMLElement {
  const card = element("article", "item");
  const head = element("div", "head");
  const heading = element("div");
  heading.append(
    element("div", "title", schema.name),
    element("div", "from", `Schema #${schema.id} · ${plural(schema.attestations, "statement")} made`),
  );
  head.append(heading, element("span", "chip", schema.revocable ? "Revocable" : "Not revocable"));
  const actions = element("div", "actions");
  const button = element("button", "small", "Attest under it");
  button.addEventListener("click", () => {
    chooseSchema(schema.id);
    attestForm.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  actions.append(button);
  card.append(head, actions);
  return card;
}

// ---------- Looking an account up ----------

async function lookup(target: string) {
  const read = ++lookupRead;
  lookedUp = target;
  foundTitle.textContent = "Statements about ";
  foundTitle.append(who(target, ""));
  foundAsof.textContent = "Reading…";
  foundTiles.hidden = true;
  foundEl.replaceChildren();
  let shown: Shown[];
  try {
    shown = await readShown(await readIds("by_subject", target));
  } catch (error) {
    if (read !== lookupRead) return;
    foundAsof.textContent = errorText(error);
    return;
  }
  if (read !== lookupRead) return;

  const count = (kind: Status["kind"]) => shown.filter((item) => item.status.kind === kind).length;
  foundAsof.textContent =
    shown.length === 0
      ? "Nobody has attested anything about this account yet."
      : `${plural(shown.length, "statement")}, newest first. Status as of ${formatDate(Date.now())}.`;
  foundTiles.hidden = shown.length === 0;
  const tile = (name: string, value: number, sub: string) => {
    const node = element("div", "tile");
    node.append(element("div", "label", name), element("div", "value", String(value)), element("div", "sub", sub));
    return node;
  };
  foundTiles.replaceChildren(
    tile("Valid now", count("valid"), "an app or contract would say yes"),
    tile("Expired", count("expired"), "past their end date"),
    tile("Revoked or replaced", count("revoked") + count("replaced"), "taken back, or said again"),
  );
  foundEl.replaceChildren(...shown.map((item) => renderAttestation(item, "subject")));
}

async function submitLookup() {
  const typed = lAccount.value.trim();
  if (!typed) return;
  lookupHint.textContent = looksLikeName(typed) ? "Looking the name up on the mainnet…" : "";
  const target = await readAccount(typed);
  if (!target) {
    lookupHint.textContent = looksLikeName(typed)
      ? "No account was found for this name."
      : "Not an account: paste a public key, an account-hash-… or a name.cspr.";
    return;
  }
  lookupHint.textContent = looksLikeName(typed) ? `${typed} is ${target}.` : "";
  history.replaceState(null, "", `#account=${target}`);
  await lookup(target);
}

// ---------- Yours ----------

async function refreshMine() {
  const read = ++mineRead;
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
    button.classList.toggle("active", button.dataset.tab === tab);
  }
  if (!account) {
    mySchemas = [];
    renderSchemaOptions();
    mineEl.replaceChildren(element("p", "empty", "Connect a wallet to see your statements."));
    return;
  }
  const me = account.address;
  try {
    const schemaIds = await readIds("schemas_by_issuer", me);
    const found = await Promise.all(schemaIds.map(readSchema));
    if (read !== mineRead) return;
    mySchemas = found.filter((schema): schema is Schema => schema !== null);
    renderSchemaOptions();
    $("step-schema").classList.toggle("done", mySchemas.length > 0);

    if (tab === "schemas") {
      mineEl.replaceChildren(
        ...(mySchemas.length === 0
          ? [element("p", "empty", "You have not registered a schema. Register one on the left.")]
          : [...mySchemas].reverse().map(renderSchema)),
      );
      return;
    }
    const shown = await readShown(await readIds(tab === "about" ? "by_subject" : "by_issuer", me));
    if (read !== mineRead) return;
    if (tab === "about") {
      $("step-attest").classList.toggle(
        "done",
        shown.some((item) => item.attestation.issuer === me),
      );
    }
    mineEl.replaceChildren(
      ...(shown.length === 0
        ? [
            element(
              "p",
              "empty",
              tab === "about"
                ? "Nobody has attested anything about you yet. Attest about yourself on the left."
                : "You have not attested anything yet.",
            ),
          ]
        : shown.map((item) => renderAttestation(item, tab === "about" ? "subject" : "issuer"))),
    );
  } catch (error) {
    if (read === mineRead) mineEl.replaceChildren(element("p", "notice", errorText(error)));
  }
}

// ---------- Registering a schema ----------

function showSchemaError(text: string) {
  schemaError.textContent = text;
  schemaError.hidden = !text;
}

function schemaBlocker(): string {
  const name = sName.value.trim();
  if (!name) return "Name the kind of statement.";
  if (bytes(name) > MAX_NAME_BYTES) return `The name is ${bytes(name)} bytes; the limit is ${MAX_NAME_BYTES}.`;
  return "";
}

function renderSchemaForm() {
  const stop = schemaBlocker();
  const name = sName.value.trim();
  sNameHint.textContent = name
    ? `${bytes(name)} of ${MAX_NAME_BYTES} bytes. Everyone sees it.`
    : `Up to ${MAX_NAME_BYTES} bytes. Everyone sees it.`;
  schemaSubmit.textContent = account ? "Register the schema" : "Connect a wallet to register a schema";
  schemaSubmit.disabled = busy || !account || stop !== "";
}

async function registerSchema() {
  showSchemaError("");
  if (!account) return;
  const stop = schemaBlocker();
  if (stop) return showSchemaError(stop);
  const name = sName.value.trim();
  const revocable = sRevocable.checked;
  await withBusy(async () => {
    const before = (await readIds("schemas_by_issuer", account!.address)).length;
    const done = await send(`Registering "${name}"`, GAS.register, () => registry.registerSchema(name, revocable));
    if (!done) return;
    refreshState();
    sName.value = "";
    const ids = await readIds("schemas_by_issuer", account!.address);
    if (ids.length > before) chosenSchema = ids[ids.length - 1];
  });
}

// ---------- Attesting ----------

function showAttestError(text: string) {
  attestError.textContent = text;
  attestError.hidden = !text;
}

function chooseSchema(id: number) {
  chosenSchema = id;
  renderSchemaOptions();
}

function renderSchemaOptions() {
  if (chosenSchema !== null && !mySchemas.some((schema) => schema.id === chosenSchema)) chosenSchema = null;
  if (chosenSchema === null && mySchemas.length > 0) chosenSchema = mySchemas[mySchemas.length - 1].id;
  aSchemas.replaceChildren(
    ...mySchemas.map((schema) => {
      const button = element("button", "small", `#${schema.id} ${schema.name}`);
      button.type = "button";
      button.classList.toggle("active", schema.id === chosenSchema);
      button.addEventListener("click", () => chooseSchema(schema.id));
      return button;
    }),
  );
  aSchemasEmpty.hidden = mySchemas.length > 0;
  aSchemasEmpty.textContent = account
    ? "Register a schema first; yours will be listed here."
    : "Connect a wallet to see your schemas.";
  renderAttestForm();
}

/** The expiry chosen in the form, in milliseconds; `null` for never, NaN if it cannot be read. */
function expiry(): number | null {
  return aExpires.value ? new Date(aExpires.value).getTime() : null;
}

function setExpiry(choice: string) {
  const after: Record<string, number> = { "10m": 10 * MINUTE, "30d": 30 * DAY, "1y": 365 * DAY };
  aExpires.value = choice in after ? localInput(Date.now() + after[choice]) : "";
  markExpiry(choice);
  renderAttestForm();
}

function markExpiry(choice: string) {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-expiry]")) {
    button.classList.toggle("active", button.dataset.expiry === choice);
  }
}

/** Reads the subject typed in the attest form; a name is looked up on the mainnet. */
async function readSubject() {
  const read = ++subjectRead;
  const typed = aSubject.value.trim();
  subject = null;
  aSubjectInfo.textContent = looksLikeName(typed) ? "Looking the name up on the mainnet…" : "";
  renderAttestForm();
  const found = await readAccount(typed);
  if (read !== subjectRead) return;
  subject = found;
  if (looksLikeName(typed)) {
    aSubjectInfo.textContent = found ? `${typed} is ${short(found)}.` : "No account was found for this name.";
  } else if (typed && !found) {
    aSubjectInfo.textContent = "Not an account.";
  } else {
    aSubjectInfo.textContent = "";
  }
  renderAttestForm();
}

function attestBlocker(): string {
  if (!account) return "Connect a wallet to attest.";
  if (chosenSchema === null) return "Register a schema first.";
  if (!aSubject.value.trim()) return "Say whom the statement is about.";
  if (!subject) return "The account is not readable yet: paste a public key, an account-hash-… or a name.cspr.";
  const data = aData.value.trim();
  if (bytes(data) > MAX_DATA_BYTES) return `The note is ${bytes(data)} bytes; the limit is ${MAX_DATA_BYTES}.`;
  const until = expiry();
  if (until !== null && Number.isNaN(until)) return "The expiry is not a date.";
  if (until !== null && until < Date.now() + 2 * CLOCK_MARGIN) return "The expiry must be at least two minutes away.";
  return "";
}

function renderAttestForm() {
  const stop = attestBlocker();
  const schema = mySchemas.find((item) => item.id === chosenSchema);
  if (stop || !schema || !subject) {
    attestSummary.textContent = stop;
    attestSubmit.textContent = "Attest";
  } else {
    const about = subject === account?.address ? "you" : short(subject);
    const until = expiry();
    const holds = until === null ? "for ever" : `until ${formatDate(until)}`;
    const revoke = schema.revocable ? " unless you revoke it first" : "; you cannot revoke it";
    attestSummary.textContent = `The registry records that "${schema.name}" is true of ${about}, ${holds}${revoke}. If you have attested this about ${about} before, the new statement replaces the old one.`;
    attestSubmit.textContent = `Attest about ${about}`;
  }
  attestSubmit.disabled = busy || stop !== "";
}

async function attest() {
  showAttestError("");
  const stop = attestBlocker();
  if (stop) return showAttestError(stop);
  const schemaId = chosenSchema!;
  const target = subject!;
  const data = aData.value.trim();
  const until = expiry();
  await withBusy(async () => {
    const done = await send(
      `Attesting about ${target === account?.address ? "you" : short(target)}`,
      GAS.attest,
      () => registry.attest(BigInt(schemaId), address(target), data, until === null ? undefined : BigInt(until)),
    );
    if (!done) return;
    aData.value = "";
    if (target === account?.address) tab = "about";
    else tab = "issued";
  });
}

async function revoke(attestation: Attestation, schema: Schema) {
  await withBusy(async () => {
    await send(`Revoking "${schema.name}" #${attestation.id}`, GAS.revoke, () =>
      registry.revoke(BigInt(attestation.id)),
    );
  });
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

function repaint() {
  connectBtn.disabled = busy;
  renderSchemaForm();
  renderAttestForm();
}

async function refreshAll() {
  refreshState();
  repaint();
  $("step-connect").classList.toggle("done", account !== null);
  await Promise.all([refreshMine(), lookedUp ? lookup(lookedUp) : Promise.resolve()]);
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

// ---------- Form helpers ----------

function fillExample() {
  sName.value = "Tried the Odra attestations demo";
  sRevocable.checked = true;
  renderSchemaForm();
  if (!account) showSchemaError("Connect a wallet first: the schema will be yours.");
  sName.scrollIntoView({ behavior: "smooth", block: "center" });
}

function fillMe() {
  if (!account) return showAttestError("Connect a wallet first.");
  aSubject.value = account.address;
  void readSubject();
}

/** Opens the lookup of a shared link: `#account=<account-hash-… or hash-…>`. */
function readLink(): string | null {
  const params = new URLSearchParams(location.hash.slice(1));
  const target = params.get("account");
  if (!target) return null;
  try {
    const parsed = parseAddress(target);
    lAccount.value = parsed;
    return parsed;
  } catch {
    return null;
  }
}

// ---------- Wallet ----------

async function onAccount(info: AccountInfo) {
  account = { publicKey: info.publicKey, address: key(info.address) };
  accountKey.textContent = short(info.publicKey);
  accountKey.title = info.publicKey;
  connectBtn.hidden = true;
  accountBox.hidden = false;
  showSchemaError("");
  showAttestError("");
  void readSubject();
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
  await Promise.all([init(), initStorage()]);

  const contracts = new Contracts(deployedContracts);
  client = new OdraWasmClient(RPC_URL, SPECULATIVE_RPC_URL, CHAIN_NAME);
  registryAddress = key(contracts.get("AttestationRegistry").address);
  registry = new AttestationRegistryWasmClient(client, address(registryAddress));
  node = new Node(RPC_URL);
  storage = await ContractStorage.open(node, registrySchema, registryAddress);

  $("contract").textContent = `Registry contract: ${registryAddress}.`;
  setExpiry("30d");
  const linked = readLink();
  if (linked) lookedUp = linked;
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
  $("example").addEventListener("click", fillExample);
  lookupForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitLookup();
  });
  schemaForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void registerSchema();
  });
  sName.addEventListener("input", () => {
    showSchemaError("");
    renderSchemaForm();
  });
  attestForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void attest();
  });
  aSubject.addEventListener("input", () => {
    showAttestError("");
    void readSubject();
  });
  aData.addEventListener("input", () => {
    showAttestError("");
    renderAttestForm();
  });
  $("a-me").addEventListener("click", fillMe);
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-expiry]")) {
    button.addEventListener("click", () => setExpiry(button.dataset.expiry!));
  }
  aExpires.addEventListener("input", () => {
    markExpiry("");
    renderAttestForm();
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
    button.addEventListener("click", () => {
      tab = button.dataset.tab as Tab;
      void refreshMine();
    });
  }
  window.addEventListener("hashchange", () => {
    const target = readLink();
    if (target) void lookup(target);
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
