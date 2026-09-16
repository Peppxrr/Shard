# Shard Themes

Create custom CSS themes for Shard. Themes are **CSS only** — no JavaScript is evaluated.

## Directory

Custom themes live in the user-data themes folder:

```text
%APPDATA%/Shard/Themes/
```

Resolve the path via **Appearance → Open Themes Folder** or via IPC `themes:getDir`.

`%APPDATA%/Shard` is obtained via Electron `app.getPath("userData")` — never hard-code a username.

### Layout

```text
Themes/
├── my-theme/
│   ├── theme.css        ← required
│   ├── background.png         ← local asset (example)
│   ├── icon.svg         ← optional local asset
│   └── font.woff2       ← optional local font
├── catppuccin/
│   └── theme.css
└── custom.css           ← optional personal overrides (loads last)
```

## Required file

Each theme folder must contain `theme.css`. Missing or unreadable themes are skipped and the app falls back to **Default**.

Folder names may contain spaces or mixed case. Shard exposes a normalized theme id
(`Chainsmoker Cat` becomes `chainsmoker-cat`) while retaining the real folder path
for `theme.css`, images, icons, and fonts.

## Metadata (optional)

Add a leading CSS comment:

```css
/**
 * @name Catppuccin Mocha
 * @author Example
 * @version 1.0.0
 * @description Catppuccin-inspired Shard theme
 */
```

Parsed fields: `name`, `author`, `version`, `description`. Missing metadata falls back to the folder name.

## Using Shard tokens

The base stylesheet (`styles.css`) defines design tokens — override them in `:root`:

```css
:root {
  --bg-0: #0d0d12;
  --bg-1: #13131a;
  --bg-2: #191923;
  --fg: #f3f3f5;
  --fg-2: #b8b8c0;
  --accent: #a970ff;
  --accent-2: #c49aff;
  --accent-soft: rgba(169, 112, 255, 0.16);
  --accent-softer: rgba(169, 112, 255, 0.08);
  --accent-grad: linear-gradient(135deg, #8a5cff 0%, #c084ff 100%);
  --r-md: 8px;
  --r-lg: 12px;
}
```

Full token list: `--bg-0…--bg-4`, `--stroke…--stroke-3`, `--fg…--fg-4`, `--accent…`, `--r-*`, `--sp-*`, `--font`, `--mono`, `--shadow-*`. See `styles.css` header **THEME API**.

## Overriding classes

Beyond tokens, themes may use any normal CSS selector:

```css
.card {
  border-radius: 4px;
  backdrop-filter: blur(14px);
}
.app__bar {
  height: 46px;
}
.settings__nav {
  width: 240px;
}
```

Treat major public class names as stable theme API:

```text
.app, .app__bar, .app__main,
.nav, .nav__item,
.card, .card__head, .card__body,
.settings, .settings__nav, .settings__content,
.capture, .capture__hero, .library, .games, .editor, .timeline,
.btn, .btn--primary, .chip, .badge, .modal, .toasts,
.window-controls, .window-control, .window-control--close

Class names may evolve between major Shard versions — avoid deep coupling to internal/private selectors.

## Local assets

Relative URLs in `theme.css` are resolved against the theme folder:

```css
body {
  background-image: url("./background.webp");
}
@font-face {
  font-family: "ThemeFont";
  src: url("./font.woff2") format("woff2");
}
:root {
  --font-ui: "ThemeFont", sans-serif;
  --font-mono: "ThemeFont", monospace;
}
.app {
  background:
    linear-gradient(rgba(8, 6, 18, 0.78), rgba(8, 6, 18, 0.82)),
    url("./background.png") center / cover fixed;
}
```

During injection the renderer rewrites `url("./file")` → `file:///C:/Users/…/Themes/<id>/file` so images and fonts load from disk in both dev and packaged builds. Keep assets next to `theme.css`.

Built-in themes may also ship local assets under `app/src/renderer/themes/<id>/` (e.g. `background.webp`); their `url("./background.webp")` is handled by Vite's asset pipeline and correctly packaged for production.

## Fonts and icons

Use `--font-ui` for normal interface text and `--font-mono` for paths, key
bindings, and numeric readouts. The older `--font` and `--mono` tokens remain
the default values behind those semantic tokens.

Any Shard `Icon` can be replaced with a local or remote image by defining
`--icon-<name>`. Relative files are resolved and cache-busted with the rest of
the theme:

```css
:root {
  --icon-capture: url("./icons/capture.svg");
  --icon-settings: url("./icons/settings.png");
  --icon-volume-off: url("./icons/muted.webp");
}
```

Icon names are exposed as `data-icon` on the rendered SVG (for example,
`data-icon="capture"`). Camel-case component names are converted to kebab-case.
Removing an icon token restores Shard's built-in glyph on the next theme reload.

The custom Windows title bar uses `--icon-minimize`, `--icon-maximize-window`,
`--icon-restore`, and `--icon-x`. Its button surfaces can be styled through
`.window-control` and `.window-control--close`.

## Remote assets

Remote URLs are **not blocked**:

```css
background-image: url("https://example.com/wallpaper.webp");
@import url("https://fonts.googleapis.com/css2?family=Inter");
```

> **Warning:** Custom themes may load images, fonts, or other resources from the internet. Only install themes you trust.

Built-in Shard themes use local resources only.

## @import and @font-face

Normal CSS features work: variables, selectors, pseudo-elements, animations, gradients, backdrop-filter, `@font-face`, `@import`, etc.

## Theme order

```text
1. styles.css (base Shard)
2. selected theme (theme.css)
3. Themes/custom.css  (optional, personal overrides — loads last)
```

`Themes/custom.css`, if present, is injected after the selected theme so a few personal tweaks don’t require a full theme folder.

## Reloading

Use **Appearance → Reload Themes** to rescan the themes folder and reapply the selected theme without restarting. Creating or editing a theme folder takes effect after reload.

## Applying & persistence

The renderer injects a `<style id="shard-theme">` element **after** the base stylesheet so the cascade overrides naturally. The selected theme id is stored in:

- `localStorage` (`shard:theme`) for early paint before `settings.json` loads
- `%APPDATA%/Shard/settings.json` → `appearance.theme` for durable persistence

The DOM exposes the theme via:

```html
<html data-theme="oled">
<body data-theme="oled">
```

Target it in CSS if needed:

```css
[data-theme="oled"] .card { border-color: #222; }
```

If the selected theme is deleted or fails to load, Shard falls back to **Default** without crashing.

## Security

- Themes are CSS only — JavaScript in theme files is never evaluated.
- Themes cannot obtain Node privileges; filesystem access is via Electron IPC (`window.shardThemes`).
- `nodeIntegration` remains `false`, `contextIsolation` remains `true`.
- Filesystem reads are limited to the themes directory; path traversal is sanitized.

## Example theme

```css
/**
 * @name Example Theme
 * @author Example
 * @version 1.0.0
 * @description Example Shard custom theme
 */

:root {
  --bg-0: #0d0d12;
  --bg-1: #13131a;
  --bg-2: #191923;
  --fg: #f3f3f5;
  --fg-2: #b8b8c0;
  --accent: #a970ff;
  --accent-2: #c49aff;
  --r-md: 8px;
  --r-lg: 12px;
}

.card {
  backdrop-filter: blur(14px);
}

.app {
  background:
    linear-gradient(rgba(8, 8, 12, 0.82), rgba(8, 8, 12, 0.82)),
    url("./background.webp") center / cover fixed;
}
```

## Goob theme (custom example)

`Goob` is an example **custom** theme (user-installed to `%APPDATA%/Shard/Themes/my-theme/`, not bundled with the app) that demonstrates:

- local background image (`background.png`, 3840×2160)
- purple accent palette (`#8a5cff → #c084ff` gradients, preserving original gradient structure)
- radial + linear layering for readable overlays
- local icon asset (`icon.svg` from the feather icon pack)

See `%APPDATA%/Shard/Themes/my-theme/theme.css` for the full source. To try it, place the folder as described above and reload themes.
