// Builds the site that lists every app and holds them all: _site/ at the repository root.
//
//   node site/build.mjs              build every app (web/dist) and assemble _site/
//   node site/build.mjs --packages   first build the wasm packages each app depends on
//                                    (cargo odra generate-client, npm run reader): needed on a
//                                    fresh checkout, as in CI
//   node site/build.mjs --no-apps    assemble _site/ from the web/dist directories as they are
//
// _site/index.html is site/index.html with a card per entry of site/projects.json; each app goes
// to _site/<slug>/. The apps use relative paths, so the site works from any directory of a host.
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "_site");
const flags = new Set(process.argv.slice(2));
const REPOSITORY = "https://github.com/odradev/casperspam";
const EXPLORER = "https://testnet.cspr.live";

const projects = JSON.parse(readFileSync(join(root, "site/projects.json"), "utf8")).sort(
  (a, b) => a.order - b.order,
);

function run(command, cwd) {
  console.log(`\n$ ${command}   (${cwd.slice(root.length) || "."})`);
  execSync(command, { cwd, stdio: "inherit" });
}

const escape = (text) =>
  String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ---------- The apps ----------

for (const project of projects) {
  const dir = join(root, project.slug);
  const web = join(dir, "web");
  if (flags.has("--packages")) {
    run("cargo odra generate-client", dir);
    run("npm run reader", web);
  }
  if (!flags.has("--no-apps")) {
    run("npm ci", web);
    run("npm run build", web);
  }
  if (!existsSync(join(web, "dist/index.html"))) {
    throw new Error(`${project.slug}/web/dist is missing: build the app first.`);
  }
}

// ---------- The site ----------

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const project of projects) {
  cpSync(join(root, project.slug, "web/dist"), join(out, project.slug), { recursive: true });
}
cpSync(join(root, "style/odra.css"), join(out, "odra.css"));
cpSync(join(root, "style/public/assets"), join(out, "assets"), { recursive: true });
cpSync(join(root, "site/site.css"), join(out, "site.css"));
// GitHub Pages runs Jekyll unless told not to; the site is plain files.
writeFileSync(join(out, ".nojekyll"), "");

// Newest first (highest `order`): a returning reader looks for what was added.
const cards = [...projects]
  .reverse()
  .map(
    (project) => `<section class="card app">
          <h2>${escape(project.name)}</h2>
          <p class="claim">${escape(project.claim)}</p>
          <p class="summary">${escape(project.summary)}</p>
          <div class="actions">
            <a class="button primary" href="./${escape(project.slug)}/">Open the app</a>
            <a href="${REPOSITORY}/tree/main/${escape(project.slug)}">Source</a>
            <a href="${EXPLORER}/contract-package/${escape(project.contract.replace(/^hash-/, ""))}">Contract</a>
          </div>
        </section>`,
  )
  .join("\n        ");

const page = readFileSync(join(root, "site/index.html"), "utf8")
  .replaceAll("{{repository}}", REPOSITORY)
  .replaceAll("{{count}}", String(projects.length))
  .replaceAll("{{count-label}}", projects.length === 1 ? "demo" : "demos")
  .replace("{{cards}}", cards);
writeFileSync(join(out, "index.html"), page);

console.log(`\nBuilt _site/ with ${projects.length} apps: ${projects.map((p) => p.slug).join(", ")}`);
