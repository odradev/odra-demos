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
- Keep a growing list of ids per account as `Mapping<Address, List<u64>>`, not as a `Vec` in a
  `Mapping`: the `Vec` is rewritten whole on every push (6.9 CSPR for one call after 500 entries,
  against 1.64 CSPR with a `List`). The older demos still use the `Vec`.
- CEP-18 `transfer_from` reverts with `CannotTargetSelfUser` when owner and recipient are the
  same account. A contract that pays one party from another's allowance has to decide what happens
  when one account plays both parts, or the one-key demo cannot run.
- An event with 8 or more fields makes clippy warn about the constructor `#[odra::event]`
  generates; an allow on the struct does not reach it. Put
  `#![allow(clippy::too_many_arguments)]` at the top of the module.
- `cargo odra new` adds `AGENTS.md`, `CLAUDE.md` and `CHANGELOG.md` to a project. Delete them;
  the demos do not keep them.

## Networks

- Measure and experiment on a local NCTL node: gas per call, how many items fit in a transaction,
  scenarios run again with other parameters. Testnet CSPR is not free to get back.
- Use the testnet for the final deploy of a project and one demo run that proves it works. Reuse
  a contract that is already deployed (the `TestToken` of `vesting`) instead of deploying a copy:
  put its package hash in `resources/casper-test-contracts.toml` before running `deploy`.
- NCTL's limits and costs can differ from the testnet's. Say where a number was measured.
- What a transaction costs: the network charges the gas limit and refunds three quarters of what
  was not used, so a loose limit costs real CSPR. A failed transaction is charged its whole limit.
  Deploying one contract took about 310 CSPR net with a 400 CSPR limit (about 285 consumed).
- Set a deploy limit from a measurement, not a guess: run the deploy on CasperVM
  (`ODRA_BACKEND=casper`) and read `env.gas_report()`; it matched the testnet within about 1%.
  Measure the wasm files that will be deployed: `cargo odra build` and `cargo odra test -b casper`
  can produce files of different sizes.
- Agents working in parallel share one key, so a balance before and after says nothing about one
  project. Take costs per transaction from `info_get_transaction` (`cost` minus `refund`). They
  share the scratchpad directory too: each agent keeps its files in a subdirectory of its own.
- To measure: end a test with `println!("{}", env.gas_report())` and run
  `cargo odra test -b casper -s <test> -- --nocapture` after `cargo odra build` (`-s` keeps the
  built wasm). Deploy gas grows with the wasm: 281 CSPR for the smallest contract here, 383 CSPR
  for the 359 KB bonding curve (U512 arithmetic adds about 60 KB), so 400 CSPR is not a safe
  limit for every contract.
- CasperVM overstates payable calls, which go through the proxy session that carries the CSPR:
  7.40 CSPR measured against 4.73 on the testnet for the sale's `buy`, 6.60 against 3.92 for the
  curve's. Deploys and calls that attach nothing match to the mote. Take the limit of a payable
  call from the testnet demo run.
- A contract that sends CSPR out pays about 2.5 to 3 CSPR for it, so the usual 2.5 CSPR limit is
  too low for a withdrawal.
- A second test token is deployed on the testnet for demos that need two: `TestDollar` (TUSD,
  6 decimals), `hash-329d7b1f578c945dbd603ed7b7f2a3a0351024c82e4c5b2304fab94c58b30b13`, recorded
  in `swap/resources/casper-test-contracts.toml`.
- In the host-only `demo` module `env.advance_block_time` sleeps on a live network and moves the
  clock on CasperVM, so one scenario can wait out a deadline in both.
- Keep the demo scenario in a host-only module (`#[cfg(not(target_arch = "wasm32"))] pub mod demo`)
  that both the CLI and a CasperVM test call, so the sequence sent to the testnet is the proven one.
- To reuse a contract that is already deployed, load it with `container.contract_ref` in the deploy
  script: unlike `load_or_deploy` it fails instead of deploying a copy when the entry is missing.
- Errors of every contract called in one transaction share one number space. A contract that
  calls another gives its own errors a range of their own (the governor starts at 200).

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
  or `null` for a value that was never written. An `Option` prints as its inner value or `None`,
  a map as `k:v, k:v`.
- An item of a `List` inside a `Mapping` is read with the keys `[account, "<index>"]`. The length
  cannot be read: read in batches and stop at the first `null`.
- To learn the id of an item a transaction just created, read the last entry of the account's own
  list afterwards. A count read before the call can be taken by someone else's transaction.
- Odra's CEP-95 module keeps its data in dictionaries with standard names, so one schema reads
  the owner and metadata of an NFT from any CEP-95 contract (`token.owners`).
- Only stored values can be read. Compute anything a view entry point derives (a vested amount
  from a schedule and the time) in the app, with the same formula as the contract, and design the
  storage so the app can read what it shows: keep lists of ids per account rather than values that
  need a call to assemble.
- The generated wasm client is for sending transactions only. Generate it without
  `WASM_CLIENT_SK`: run `env -u WASM_CLIENT_SK cargo odra generate-client`, because a key that is
  set in the shell is compiled into the client's wasm. `site/build.mjs` unsets it for its builds.
- Browsers cannot call public nodes (no CORS). Use `https://testnet-rpc.odra.dev` or
  `https://mainnet-rpc.odra.dev`.
- A view of odra-cli runs locally with the time of the last block, so its result can differ from
  what the next transaction sees. Do not size a transaction from a time-dependent view.
- Build order: `cargo odra build` (writes the schemas), `cargo odra generate-client`, then in
  `web/`: `npm run reader`, `npm install`, `npm run build`.

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
`_site/`, which the `Pages` workflow publishes to GitHub Pages on every push to `main`. It is
served at https://odra.dev/odra-demos/.

- The page is a plain list of demos. It does not say that a project is added every day, and
  shows no day numbers.
- A new project with a web app gets an entry in `site/projects.json`: `order` (the next number;
  the highest is listed first), directory name, name,
  the one-line claim of its headline block, a two-sentence summary and the package hash of its
  contract on the testnet. Nothing else has to change: the page and the workflow follow the list.
- Apps are served from a subdirectory (`/<project>/`), so every path in an app is relative
  (`base: "./"` in `vite.config.ts`, `./assets/...` in `index.html`) and nothing is fetched from
  the root of the host.
- Each app links back to the list twice with `<a href="../">`: the logo in the header band and
  "All the demos" in the footer.
- CSPR.click accepts an app id only from the domains registered for it. The apps use the id
  registered for odra.dev when served from there and `csprclick-template` on localhost; copy the
  `clickSDKOptions` block of `vesting/web/index.html` as it is. With the wrong id the SDK fails
  at start (`e.menu_items is undefined`) and the wallet cannot connect.
- Agents working in parallel must not check their pages in the user's Chrome: they share its tabs
  and navigate each other's away. Use a headless browser with a profile of its own
  (`chromium-browser --headless=new --user-data-dir=<own scratch directory>`).
- Check the result as Pages will serve it: `node site/build.mjs`, serve the parent of `_site/`
  so the site sits under a path, and open an app through the list.

## Generated wasm client pitfalls

- A call consumes the `Address` and `U256` objects passed to it. Keep addresses as strings and
  create a fresh object for each call.
- `Address.value` prints `entity-account-…` or `contract-package-…`, which `new Address()` cannot
  parse. Convert to `account-hash-…` or `hash-…` first (`key()` in `vesting/web/src/main.ts`).
  `Address::to_formatted_string` in Rust prints the same unreadable form; use
  `Key::from(address).to_formatted_string()` for text a page or a person will paste back.

## Checks before calling a project done

```bash
cargo odra test && cargo odra test -b casper
cargo clippy --all-targets && cargo fmt --check
cd web && npm run build
```

Then add the project to `site/projects.json`, to the table in `README.md`, and run
`node site/build.mjs --no-apps` to see it in the list.
