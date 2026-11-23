// Reads contract state straight from the node's storage with odra-storage-reader.
//
// Nothing is executed and nothing is signed: the reader says where a value is stored, the node
// returns it over JSON-RPC, and the reader decodes it with the types of the contract's schema.
import initReader, { StorageReader } from "multisend-storage-reader";

/** Where a value is stored, as `StorageReader.locate` returns it. */
type Location =
  | { kind: "dictionary"; dictionaryName: string; dictionaryItemKey: string }
  | { kind: "named_key"; name: string };

/** The node's answer for a value that was never written. */
const QUERY_FAILED = -32003;
/** How long a state root hash is reused, so the reads of one refresh see one state. */
const STATE_ROOT_TTL_MS = 2_000;

class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

let rpcUrl = "";
let stateRoot: { hash: Promise<string>; at: number } | null = null;

/** Loads the reader's wasm module and sets the node to read from. Call once, before any read. */
export async function initStorage(nodeUrl: string): Promise<void> {
  rpcUrl = `${nodeUrl}/rpc`;
  await initReader();
}

/** Makes the next read ask the node for its latest state. Call after a transaction. */
export function refreshState(): void {
  stateRoot = null;
}

async function rpc<T>(method: string, params: object): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`The node answered ${response.status}.`);
  const body = await response.json();
  if (body.error) throw new RpcError(body.error.message, body.error.code);
  return body.result;
}

function latestStateRoot(): Promise<string> {
  if (!stateRoot || Date.now() - stateRoot.at > STATE_ROOT_TTL_MS) {
    const hash = rpc<{ state_root_hash: string }>("chain_get_state_root_hash", {}).then(
      (result) => result.state_root_hash,
    );
    stateRoot = { hash, at: Date.now() };
  }
  return stateRoot.hash;
}

interface Stored {
  stored_value: { CLValue?: unknown };
}

/** The storage of one deployed contract. */
export class ContractStorage {
  private constructor(
    private readonly reader: StorageReader,
    /** The hash of the current contract version of the package: the one that holds the storage. */
    private readonly contractHash: string,
  ) {}

  /** Opens the storage of the contract package `packageHash`, described by `schema`. */
  static async open(schema: object, packageHash: string): Promise<ContractStorage> {
    const reader = new StorageReader(JSON.stringify(schema));
    const pkg = await rpc<Stored>("query_global_state", { key: packageHash, path: [] });
    return new ContractStorage(reader, reader.currentContractHash(pkg.stored_value));
  }

  /**
   * Reads the value at `path`, a dotted path of field names of the contract (`token.balances`).
   * `keys` are the keys of the mappings on the path, in the odra-cli text format
   * (`account-hash-…`, `5`, `owner:spender`). Returns the value as odra-cli prints it, or `null`
   * if it was never written.
   */
  async read(path: string, keys: string[] = []): Promise<string | null> {
    const location: Location = this.reader.locate(path, keys);
    try {
      const result =
        location.kind === "named_key"
          ? await rpc<Stored>("query_global_state", { key: this.contractHash, path: [location.name] })
          : await rpc<Stored>("state_get_dictionary_item", {
              state_root_hash: await latestStateRoot(),
              dictionary_identifier: {
                ContractNamedKey: {
                  key: this.contractHash,
                  dictionary_name: location.dictionaryName,
                  dictionary_item_key: location.dictionaryItemKey,
                },
              },
            });
      return this.reader.decode(result.stored_value.CLValue, location);
    } catch (error) {
      if (error instanceof RpcError && error.code === QUERY_FAILED) return null;
      throw error;
    }
  }
}

/** The CSPR balance of an account, in motes. An account that does not exist yet has none. */
export async function csprBalance(accountHash: string): Promise<bigint> {
  try {
    const result = await rpc<{ balance: string }>("query_balance", {
      purse_identifier: { main_purse_under_account_hash: accountHash },
    });
    return BigInt(result.balance);
  } catch (error) {
    if (error instanceof RpcError) return 0n;
    throw error;
  }
}

/** Turns a key as odra-cli prints it (`Key::Account(…)`, `Key::Hash(…)`) into a formatted key. */
export function formattedKey(printed: string): string {
  const match = /^Key::(Account|Hash)\(([0-9a-f]{64})\)$/.exec(printed);
  if (!match) throw new Error(`Unexpected key: ${printed}`);
  return `${match[1] === "Account" ? "account-hash" : "hash"}-${match[2]}`;
}
