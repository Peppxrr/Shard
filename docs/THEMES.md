# Make a Shard theme

Shard Theme API **1** supports colors, typography, icons, local assets, page layouts, editor surfaces, and user-configurable options. Themes contain CSS and optional JSON; they do not run JavaScript or add app actions.

## Try the example

[Afterglow](../examples/themes/afterglow) is a complete theme you can copy and edit. It demonstrates a side navigation layout, local SVG artwork and a replacement capture icon, editor colors, page-specific rules, and six configurable options.

1. Open **Settings → Appearance → Open themes folder** in Shard.
2. Copy the entire `examples/themes/afterglow` folder into that folder.
3. Select **Afterglow**, then **Save changes**. Theme options apply and save automatically.
4. Edit its CSS or JSON in a text editor. Shard reloads saved files automatically; **Reload themes** is available if filesystem notifications are unavailable.

The folder is normally `%APPDATA%\Shard\Themes`. Use the button to find the actual location for your build/profile. No installer or restart is needed. Remove a theme's folder to uninstall it. A loaded theme can remain visible until you switch away; the next launch falls back to Default if it is unavailable.

## Start with one file

Drop `my-theme.css` directly into the Themes folder, or create `Themes/my-theme/theme.css`:

```css
/**
 * @name My theme
 * @author Your name
 * @version 1.0.0
 * @description A calm green workspace.
 */
:root {
  --accent: #85dcc4;
  --accent-2: #e2c28d;
  --accent-ink: #0a1b1a;
  --accent-soft: color-mix(in srgb, var(--accent) 17%, transparent);
  --accent-softer: color-mix(in srgb, var(--accent) 8%, transparent);
  --accent-grad: linear-gradient(115deg, var(--accent), var(--accent-2));
}
[data-shard-component="card"] { border-radius: 6px; }
```

New CSS files and theme folders appear in Appearance automatically after a short 250 ms debounce. Select a new theme once to use it; adding a file does not change your current selection. Edits to the active theme, imported CSS, assets, and `custom.css` reload automatically without clicking Reload.

Standalone `.css` files resolve assets relative to the Themes folder and use the filename without `.css` as their ID. `custom.css` is reserved for personal overrides and does not appear as a selectable theme. Use a folder for themes with a manifest/options. A folder takes precedence over a same-ID standalone file.

CSS-only themes from earlier Shard versions still work. Leading comment metadata is optional. Theme IDs come from folder names: `My Theme` becomes `my-theme`. Use a unique lowercase folder name. `default`, `oled`, and `midnight` are reserved. If two folders normalize to the same ID, the exact normalized folder name wins, otherwise alphabetical order wins; rename the other folder to make both selectable.

## Add a manifest and options

An optional `theme.json` provides metadata, an ordered list of stylesheets, a minimum Shard version, and controls shown in Appearance:

```json
{
  "schema": 1,
  "name": "My theme",
  "author": "Your name",
  "version": "1.0.0",
  "description": "A calm green workspace.",
  "minShardVersion": "0.1.5",
  "styles": ["theme.css", "pages/library.css"],
  "settings": {
    "accent": { "type": "color", "name": "Accent", "default": "#85dcc4" },
    "compact": { "type": "boolean", "name": "Compact spacing", "default": false },
    "text-size": { "type": "range", "name": "Text size", "min": 13, "max": 18, "step": 1, "unit": "px", "default": 14 },
    "corners": {
      "type": "select", "name": "Card corners", "default": "soft",
      "choices": [{ "value": "soft", "label": "Soft" }, { "value": "square", "label": "Square" }]
    }
  }
}
```

`schema` is required when a manifest exists. Other top-level fields are optional. Metadata in the manifest overrides the CSS comment; the folder still determines the ID. Omit `styles` to load `theme.css`; when supplied, it replaces the default list. Paths are relative to the theme folder, must end in `.css`, and cannot leave that folder. Up to 16 entry sheets and 32 options are supported. Each text file has a 2 MB limit.

Every listed stylesheet loads in order. There is no page-name loading convention: scope page rules explicitly with `[data-shard-page="library"]`, etc. This also works when the editor or a modal is open over another page. Nested local `@import` works, following normal CSS placement rules (imports precede ordinary rules).

The [JSON schema](theme.schema.json) provides editor completion and structural validation. The example references it relative to this repository. If editing a copied theme outside the repository, copy the schema beside it and change `$schema` to `./theme.schema.json`, or omit `$schema`; it is an editor hint, not required by Shard.

### Option types

Keys must start with a lowercase letter and contain only lowercase letters, digits, and hyphens (48 characters maximum). Use names such as `text-size`, not `fontSize`. Every option requires `type`, `name`, and `default`; `description` is optional.

| Type | Declaration | Output |
| --- | --- | --- |
| `color` | Six-digit hex default, e.g. `#85dcc4` | `--theme-accent: #85dcc4` |
| `boolean` | `true` or `false` | `--theme-compact: 1` or `0`, and `data-theme-compact="true"` or `"false"` on `<html>` |
| `range` | Numeric `min`, `max`, `default`; optional positive `step` (default 1) and `unit` | `--theme-text-size: 14px` |
| `select` | 1–20 unique `{value,label}` choices; default must match one | `--theme-corners: soft` and `data-theme-corners="soft"` on `<html>` |

Range units: empty string, `px`, `rem`, `%`, or `ms`. Saved numbers are clamped and snapped to the step. Select values follow the same identifier rule as keys. Invalid saved values use the declared default. Options removed from a manifest stop emitting variables and attributes.

Use the generated values in CSS:

```css
:root {
  --accent: var(--theme-accent, #85dcc4);
  --fs-14: var(--theme-text-size, 14px);
}
:root[data-theme-compact="true"] { --sp-5: 14px; --control-height: 32px; }
:root[data-theme-corners="square"] { --r-lg: 3px; }
```

These variables are inputs, not automatic changes to Shard's design tokens. Map them to the tokens or selectors you want. There are no arbitrary text/code options. Option values are saved per theme ID in `theme-options.json` beside `settings.json`. **Reset options** restores this theme's defaults without changing other themes. Theme selection uses the normal **Save changes / Discard** flow; option edits save immediately, including while previewing a theme.

## Assets, fonts, and icons

```text
my-theme/
  theme.json       optional
  theme.css
  pages/library.css
  assets/background.webp
  assets/capture.svg
  fonts/interface.woff2
```

Paths inside each stylesheet resolve relative to that stylesheet (not always the theme root):

```css
/* theme.css */
@font-face {
  font-family: "My interface";
  src: url("./fonts/interface.woff2") format("woff2");
  font-display: swap;
}
:root {
  --font-ui: "My interface", "Segoe UI", sans-serif;
  --font-mono: "Cascadia Code", Consolas, monospace;
  --icon-capture: url("./assets/capture.svg");
}
[data-shard-component="capture-hero"] {
  background: linear-gradient(90deg, var(--bg-1), transparent),
    url("./assets/background.webp") center / cover;
}
```

Shard serves local resources through its restricted `shard-theme:` handler in both dev and installed builds. You do not need to construct these URLs. Resource revisions change after saves, including edits to images, fonts, and imported CSS. Files stay inside the Themes directory, including after resolving links/junctions. Supported resource types are CSS, SVG, PNG, JPEG, WebP, GIF, AVIF, ICO, WOFF/WOFF2, TTF, and OTF (50 MB per asset). Prefer portable relative paths; absolute `file:` URLs are not portable and may be blocked by Chromium in dev mode.

Icons use `--icon-<name>: url(...)`, where the name is the SVG's `data-icon` attribute. For example: `capture`, `settings`, `volume-off`, `hard-drive`, `minimize`, `maximize-window`, `restore`, `x`. Image icons retain their own colors; an SVG loaded as an image does not inherit the app's `currentColor`. To recolor the normal stroke icons, style `[data-icon] { color: var(--accent); stroke-width: 1.6; }` without replacing the image. Remove an icon variable to restore the original glyph.

HTTP(S) URLs, data URLs, remote `@import`, and ordinary CSS features remain available. Remote resources can contact other servers and delay loading. Ship local resources when possible and include their licenses. Themes cannot call capture APIs, access Node, inject React components, or execute JS. CSS can hide controls and remote resources can make network requests, so install themes from authors you trust.

## Cascade and compatibility

1. Shard base stylesheet.
2. The selected built-in stylesheet, or manifest entry sheets in declaration order.
3. Generated `--theme-*` option values.
4. Optional `Themes/custom.css`, for personal overrides.

Normal CSS specificity and `!important` still apply. This is not a forced cascade-layer system; existing themes keep their selector behavior. `custom.css` resolves assets relative to `Themes/`. Imported CSS is subject to normal browser import rules. Avoid overriding generated `--theme-*` inputs unless you deliberately want to ignore an option.

The [Theme API reference](THEME-API.md) is the exact supported surface. New themes should use semantic `data-shard-*` hooks; listed legacy classes remain supported. Internal selectors are usable but can change in any release. Theme API version 1 is exposed as `data-shard-theme-api="1"` on `<html>`. The manifest's `schema` version is independent of the Shard release number; `minShardVersion` uses a numeric `major.minor.patch` version.

Missing/unsupported manifests and unreadable sheets appear with a reason in Appearance. During live editing, failed loads preserve the last working CSS. On startup, a theme that cannot load falls back to Default. Browser CSS syntax errors are handled by Chromium: invalid declarations may be ignored rather than rejecting the entire file. A stylesheet timeout is reported after eight seconds. Fix the file and save again, or switch to a built-in theme. If a theme hides the controls entirely, close Shard and rename its folder (and `custom.css`, if needed), then reopen it.

## Authoring and sharing checklist

- Check Capture, Library, Games, Settings, the player/editor, and dialogs at narrow and wide window sizes.
- Keep focus indicators, readable labels, disabled states, recording indicators, and window controls visible. Check long labels and the largest text-size option.
- Avoid changing timeline geometry, trimming hit targets, or video sizing: these correspond to media coordinates. Use editor color tokens and surface styling instead.
- Respect `prefers-reduced-motion`. Avoid large animated filters or continuously moving backgrounds while capturing a game.
- Test switching away/back, option reset, and a full restart after saving the selection. Check both default values and changed options.
- Share only your theme folder and asset licenses. Do not include personal settings, `theme-options.json`, captured clips, or cache files.

Contributors can run `npm --prefix app run verify -- themes`. The theme suite covers manifests, legacy discovery, collisions, options, URL resolution, asset boundaries, hot reload, and renderer switch/failure handling. Changes to editor behavior also use the `editor` scope.
