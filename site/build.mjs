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
const REPOSITORY = "https://github.com/odradev/odra-demos";
const EXPLORER = "https://testnet.cspr.live";

const projects = JSON.parse(readFileSync(join(root, "site/projects.json"), "utf8")).sort(
  (a, b) => a.order - b.order,
);

// The generated client compiles in whatever WASM_CLIENT_SK holds (a key for simulated reads, which
// these apps do not make). A key set in the shell must never end up in a published bundle.
const env = { ...process.env };
delete env.WASM_CLIENT_SK;

function run(command, cwd) {
  console.log(`\n$ ${command}   (${cwd.slice(root.length) || "."})`);
  execSync(command, { cwd, stdio: "inherit", env });
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

// The picture of a card is the diagram of the app's headline block, without its labels: at this
// size they would not be readable, and the name beside it says what it is. site/icons/<slug>.svg,
// when it exists, is used instead; it is drawn with the classes of the diagram.
function icon(project) {
  // A diagram that says little without its labels is replaced by a drawing in site/icons/.
  const own = join(root, "site/icons", `${project.slug}.svg`);
  if (existsSync(own)) return readFileSync(own, "utf8").replace(/\s*\n\s*/g, " ").trim();
  const html = readFileSync(join(root, project.slug, "web/index.html"), "utf8");
  const svg = html.match(/<figure class="diagram[^"]*">\s*(<svg[\s\S]*?<\/svg>)/)?.[1];
  if (!svg) throw new Error(`${project.slug}/web/index.html has no diagram in its headline block.`);
  const shapes = svg
    .replace(/<title[\s\S]*?<\/title>/g, "")
    .replace(/<text[\s\S]*?<\/text>/g, "")
    .replace(/^<svg[^>]*?(viewBox="[^"]*")[^>]*>/, '<svg $1 aria-hidden="true">')
    .replace(/\s*\n\s*/g, " ");
  if (!/<(path|rect|circle|line)/.test(shapes)) {
    throw new Error(`${project.slug}: the diagram is empty in index.html; give it shapes to show before the app draws.`);
  }
  return shapes;
}

// Newest first (highest `order`): a returning reader looks for what was added.
const cards = [...projects]
  .reverse()
  .map(
    (project) => `<section class="card app">
          <div class="head">
            <div>
              <h2>${escape(project.name)}</h2>
              <p class="claim">${escape(project.claim)}</p>
            </div>
            <div class="icon">${icon(project)}</div>
          </div>
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
