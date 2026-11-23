# Odra demos

Smart contracts for [Casper](https://casper.network) written in [Odra](https://odra.dev), each with a web app to try on the testnet: **[odra.dev/odra-demos](https://odra.dev/odra-demos/)**.

Each demo is something the Casper ecosystem was missing: a token tool, a DeFi building block, a governance or identity primitive. Each one is a single contract with tests, small enough to read in one sitting and to reuse in your own project.

## Projects

| Project | What it does |
|---------|--------------|
| [Token vesting](vesting/) | Locks CEP-18 tokens for a beneficiary and releases them over time, with a cliff and optional revoking. Comes with a web app. |
| [Multisend](multisend/) | Sends CSPR or a CEP-18 token to many recipients in one transaction, signed once: all of them or none. Comes with a web app. |
| [Payment streaming](streaming/) | Pays a recipient continuously from a deposit of CEP-18 tokens; the recipient withdraws what has accrued, the sender can stop the stream. Comes with a web app. |
| [Liquidity locker](locker/) | Locks CEP-18 tokens until a date that can only move later, and shows anyone what is locked for a token. Comes with a web app. |
| [Timelock](timelock/) | Holds admin rights over other contracts and executes each operation only after a public delay. Comes with a web app. |

## Layout

Every project lives in its own directory and is a standalone Odra project:

```
<project>/
├── .cargo/config.toml   points the build at the shared target directory
├── src/                 contract and tests
├── Odra.toml            contract registration
└── README.md            what it does, entry points, how to use it
```

All projects build into one `target/` directory at the repository root, so dependencies compile once and are reused by every project. Each project sets this in its `.cargo/config.toml`:

```toml
[build]
target-dir = "../target"
```

A project with a web app keeps it in `web/`. All web apps share one look, the Odra web style, kept in
[`style/`](style/).

## The site

[`site/`](site/) is the page that lists every app. `node site/build.mjs` builds all the apps and
assembles them with that page into `_site/`; the `Pages` workflow does the same on every push to
`main` and publishes the result to GitHub Pages. The list comes from `site/projects.json`.

## Running a project

You need Rust and [cargo-odra](https://github.com/odradev/cargo-odra):

```bash
cargo install cargo-odra --locked
```

Then, inside a project directory:

```bash
cargo odra test            # run tests on OdraVM
cargo odra test -b casper  # build wasm and run tests on CasperVM
cargo odra build           # build wasm only
```

## Status

These contracts are examples. They are not audited. Review and test them yourself before putting real funds behind them.
