// Reads contract state straight from a node's storage with odra-storage-reader.
//
// Nothing is executed and nothing is signed: the reader says where a value is stored, the node
// returns it over JSON-RPC, and the reader decodes it with the types of the contract's schema.
// The app reads two networks: the testnet, where the registry lives, and the mainnet, for the
// CSPR.name names of accounts (see names.ts).
import initReader, { StorageReader } from "attestations-storage-reader";

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

/** Loads the reader's wasm module. Call once, before any read. */
export const initStorage = () => initReader().then(() => undefined);

interface Stored {
  stored_value: { CLValue?: unknown };
}

/** A Casper node, reached over JSON-RPC. */
export class Node {
  private stateRoot: { hash: Promise<string>; at: number } | null = null;

  /** `url` is the address of the node; its JSON-RPC endpoint is `<url>/rpc`. */
  constructor(private readonly url: string) {}

  async rpc<T>(method: string, params: object): Promise<T> {
    // A node that is down fails the request itself (the browser reports only "Failed to fetch") or
    // answers with an error status. Either way the reader needs to hear that it is the node.
    const unavailable = "The Casper node this page reads from is not answering. Try again in a few minutes.";
    let response: Response;
    try {
      response = await fetch(`${this.url}/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
    } catch {
      throw new Error(unavailable);
    }
    if (!response.ok) throw new Error(`${unavailable} (HTTP ${response.status})`);
    const body = await response.json();
    if (body.error) throw new RpcError(body.error.message, body.error.code);
    return body.result;
  }

  /** Makes the next read ask the node for its latest state. Call after a transaction. */
  refresh(): void {
    this.stateRoot = null;
  }

  latestStateRoot(): Promise<string> {
    if (!this.stateRoot || Date.now() - this.stateRoot.at > STATE_ROOT_TTL_MS) {
      const hash = this.rpc<{ state_root_hash: string }>("chain_get_state_root_hash", {}).then(
        (result) => result.state_root_hash,
      );
      hash.catch(() => (this.stateRoot = null));
      this.stateRoot = { hash, at: Date.now() };
    }
    return this.stateRoot.hash;
  }
}

/** The storage of one deployed contract. */
export class ContractStorage {
  private constructor(
    private readonly node: Node,
    private readonly reader: StorageReader,
    /** The hash of the current contract version of the package: the one that holds the storage. */
    private readonly contractHash: string,
  ) {}

  /** Opens the storage of the contract package `packageHash`, described by `schema`. */
  static async open(node: Node, schema: object, packageHash: string): Promise<ContractStorage> {
    const reader = new StorageReader(JSON.stringify(schema));
    const pkg = await node.rpc<Stored>("query_global_state", { key: packageHash, path: [] });
    return new ContractStorage(node, reader, reader.currentContractHash(pkg.stored_value));
  }

  /**
   * Reads the value at `path`, a dotted path of field names of the contract (`token.balances`).
   * `keys` are the keys of the mappings and lists on the path, in the odra-cli text format
   * (`account-hash-…`, `5`, `owner:spender`). Returns the value as odra-cli prints it, or `null`
   * if it was never written.
   */
  async read(path: string, keys: string[] = []): Promise<string | null> {
    const location: Location = this.reader.locate(path, keys);
    try {
      const result =
        location.kind === "named_key"
          ? await this.node.rpc<Stored>("query_global_state", {
              key: this.contractHash,
              path: [location.name],
            })
          : await this.node.rpc<Stored>("state_get_dictionary_item", {
              state_root_hash: await this.node.latestStateRoot(),
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

/** Turns a key as odra-cli prints it (`Key::Account(…)`, `Key::Hash(…)`) into a formatted key. */
export function formattedKey(printed: string): string {
  const match = /Key::(Account|Hash)\(([0-9a-f]{64})\)/.exec(printed);
  if (!match) throw new Error(`Unexpected key: ${printed}`);
  return `${match[1] === "Account" ? "account-hash" : "hash"}-${match[2]}`;
}
