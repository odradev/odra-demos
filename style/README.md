# Style

The look shared by the web apps of every project in this repository: the Odra web style.

- `odra.css`: the tokens and components.
- `public/assets/`: the logo for the header band and the favicon.

These files are copies. The source is the `odra-style-guide` repository, whose `index.html` shows
every component with an example. Do not edit them here: change the guide, then run

```bash
style/sync.sh            # the guide is expected next to this repository, in ../odra-style-guide
style/sync.sh <path>     # or say where it is
```

## Using it in a project

In the project's `web/vite.config.ts`, serve this directory's `public/` and allow reading above
the app:

```ts
export default defineConfig({
  publicDir: "../../style/public",
  server: { fs: { allow: ["../.."] } },
});
```

In `web/src/main.ts`, import the style before the app's own stylesheet:

```ts
import "../../../style/odra.css";
import "./style.css";
```

Start `index.html` from `vesting/web/index.html`: the header band, the toolbar, the headline block.
An app's own `style.css` holds only what is particular to that app. A component another app could
use belongs in the guide.
