# odra-demos

Demos of Odra smart contracts for Casper, each in its own directory with a web app. `vesting/` is the
reference for how a project is laid out; copy its structure for a new one.

## Project layout

- Each project is a standalone Odra project scaffolded with `cargo odra new`, never a member of a
  shared workspace.
- Each project has `.cargo/config.toml` with `target-dir = "../target"`, so all projects share one
  target directory. The setting has to be in the project, not in the repository root: cargo-odra
  joins the value to the project directory.
- Crate names must be unique across projects: the wasm files land in the shared target directory.
- Keep every project on the same Odra source, so dependencies compile once. Today that is the
  `release/2.11.0` branch (`cargo odra new -s release/2.11.0`): the wasm client of the published
  2.10 sends transactions the testnet rejects.

## Contracts

- Entry points that change state return nothing. `cargo odra generate-client` rejects a mutable
  entry point with a return value; put the value in an event instead.

## Networks

- Measure and experiment on a local NCTL node: gas per call, how many items fit in a transaction,
  scenarios run again with other parameters. Testnet CSPR is not free to get back.
- Use the testnet for the final deploy of a project and one demo run that proves it works. Reuse
  a contract that is already deployed (the `TestToken` of `vesting`) instead of deploying a copy:
  put its package hash in `resources/casper-test-contracts.toml` before running `deploy`.
- NCTL's limits and costs can differ from the testnet's. Say where a number was measured.

## Web apps: read state with odra-storage-reader

A web app reads contract state straight from the node's storage with `odra-storage-reader`. Do not
read by calling view entry points on the generated wasm client: those calls go through
`speculative_exec`, which needs a funded reader key compiled into the page (`WASM_CLIENT_SK`) and
a node that serves speculative execution.

- Copy `vesting/storage_reader/` (a crate that re-exports `odra-storage-reader`, built to wasm with
  `npm run reader`) and `vesting/web/src/storage.ts` (`ContractStorage.open(schema, packageHash)`,
  then `read(path, keys)`).
- The reader needs the contract's schema, `resources/casper_contract_schemas/<contract>_schema.json`,
  which `cargo odra build` writes. Import it in the app; do not copy it.
- `read` takes a dotted path of storage field names (`token.balances`) and one key per mapping on
  the path, in the odra-cli text format (`account-hash-…`, `5`, `owner:spender`). It returns the
  value as odra-cli prints it (a struct is a JSON object of strings, a key is `Key::Account(…)`),
  or `null` for a value that was never written.
- Only stored values can be read. Compute anything a view entry point derives (a vested amount
  from a schedule and the time) in the app, with the same formula as the contract, and design the
  storage so the app can read what it shows: keep lists of ids per account rather than values that
  need a call to assemble.
- The generated wasm client is for sending transactions only. Generate it without
  `WASM_CLIENT_SK`.
- Browsers cannot call public nodes (no CORS). Use `https://testnet-rpc.odra.dev` or
  `https://mainnet-rpc.odra.dev`.

## Web apps: use the Odra style

Every web app in this repository looks the same: the Odra web style, shared from `style/`.
`style/README.md` says how to wire it into a project; `vesting/web` is the example to copy.

- Import `style/odra.css` and build the page from its components: header band, toolbar, headline
  block, cards, tiles, steps, forms, buttons, tabs, items with chips and progress bars, notices and
  the toast. The `odra-style-guide` repository shows each one with an example (`index.html`).
- Do not copy `odra.css` or the logo into a project, and do not edit them in `style/`. They are
  copies of the guide; `style/sync.sh` refreshes them.
- A project's own `web/src/style.css` holds only what is particular to that app. When a page needs
  a component the guide does not have, add it to the guide (stylesheet and an example on its
  page), run `style/sync.sh`, then use it. Tell the user the guide changed: it is another
  repository.
- The rules of the guide apply: light only; the brand blue in the header band, wherever data is
  drawn (lines, progress, finished steps) and, darkened for contrast, on the one primary button of
  a view and the chosen option of a set; every other control neutral; warm neutrals, hairline
  borders, no shadows; the figure a reader came for first, in tabular numbers.
- Every page starts by saying what it is for, in plain words, before any form: the headline block
  with a diagram or a figure, then how to try it in steps.
- Name things for the reader, not after the contract: "claim" and "recipient", not "release" and
  "beneficiary". Buttons say what they do, with the amount.

## The site

`site/` is the page that lists every app; `site/build.mjs` assembles it and all the apps into
`_site/`, which the `Pages` workflow publishes to GitHub Pages on every push to `main`.

- The page is a plain list of demos. It does not say that a project is added every day, and
  shows no day numbers.
- A new project with a web app gets an entry in `site/projects.json`: `order` (the next number;
  the highest is listed first), directory name, name,
  the one-line claim of its headline block, a two-sentence summary and the package hash of its
  contract on the testnet. Nothing else has to change: the page and the workflow follow the list.
- Apps are served from a subdirectory (`/<project>/`), so every path in an app is relative
  (`base: "./"` in `vite.config.ts`, `./assets/...` in `index.html`) and nothing is fetched from
  the root of the host.
- Each app's footer links back to the list with `<a href="../">`.
- Check the result as Pages will serve it: `node site/build.mjs`, serve the parent of `_site/`
  so the site sits under a path, and open an app through the list.

## Generated wasm client pitfalls

- A call consumes the `Address` and `U256` objects passed to it. Keep addresses as strings and
  create a fresh object for each call.
- `Address.value` prints `entity-account-…` or `contract-package-…`, which `new Address()` cannot
  parse. Convert to `account-hash-…` or `hash-…` first (`key()` in `vesting/web/src/main.ts`).

## Checks before calling a project done

```bash
cargo odra test && cargo odra test -b casper
cargo clippy --all-targets && cargo fmt --check
cd web && npm run build
```

Then add the project to `site/projects.json`, to the table in `README.md`, and run
`node site/build.mjs --no-apps` to see it in the list.
