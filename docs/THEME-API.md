# Theme API 1 reference

This is the supported styling contract. Entries are additive within API 1; removing or changing the meaning of one requires a new theme API version and migration guidance. CSS selectors not listed here are internal and may change between Shard releases. The contract does not promise a particular DOM depth, child order, or tag name.

## Root attributes

| Selector | Meaning |
| --- | --- |
| `html[data-shard-theme-api="1"]` | Supported theme API version |
| `html[data-theme="<id>"]`, `body[data-theme="<id>"]` | Theme actually applied, including fallback |
| `html[data-theme-<option>="<value>"]` | Declared boolean/select option; removed when switching themes |

## Pages

`[data-shard-page="capture"]`, `library`, `games`, `settings`, `editor`, and `console` identify their page containers. An editor can coexist with its underlying page; scope by the page element rather than assuming a single global active page.

- Capture: `data-shard-state="idle|capturing|recording"`, `data-saving="true|false"`.
- Settings: `data-shard-section="appearance|capture|video|export|audio|hotkeys|storage|app"`.
- Editor: `data-playing="true|false"`.

## Components

Use `[data-shard-component="<value>"]` with these values:

| Value | State / behavior |
| --- | --- |
| `app` | Application shell |
| `navigation` | Main navigation; items have `data-shard-nav="capture|library|games|settings"` and active `aria-current="page"` |
| `card` | Shared panel |
| `button` | `data-variant="default|primary|ghost|soft|danger"`, `data-loading="true|false"`, native `:disabled` |
| `icon-button` | Native disabled state, `aria-pressed` where applicable |
| `toggle` | `data-checked="true|false"`; nested checkbox carries disabled state |
| `select` | Button with `aria-expanded="true|false"`, native disabled state |
| `select-menu` | Dropdown listbox; options use `aria-selected` |
| `context-menu` | Player/editor context menu |
| `modal` | Dialog overlay; `data-shard-modal="clip-viewer"` identifies the clip preview dialog |
| `toast` | `data-shard-state="info|ok|error"` |
| `empty` | Empty-state content |
| `theme-picker` | Theme selection/options area |
| `capture-hero` | Capture status panel |
| `capture-button` | Save-clip button; `data-shard-state="ready|saving"` |
| `record-button` | `data-shard-state="idle|recording"` |
| `clip` | `data-favorite="true|false"`, `data-source="clip|recording|edited"` |
| `library-filters` | Source filter group; child filter buttons expose `data-source="all|clip|recording|edited"` and `aria-pressed` |
| `clip-viewer` | Video and details layout inside the preview dialog; `data-source="clip|recording|edited"` |
| `game` | Running entry: `data-running="true|false"`; excluded entry: `data-excluded="true"` |
| `player` | `data-playing`, `data-fullscreen`, `data-controls-visible`, each `"true|false"`; `data-shard-state="loading|ready|error"` |
| `clip-rename` | `data-shard-state="idle|editing|saving"`; inline file rename form shared by viewer and editor |
| `medal-import` | `data-shard-state="idle|importing|complete"`; folder selection and import results |
| `developer-console` | `data-shard-state="loading|ready|error"`, `data-stream-state="live|paused"`, `data-action-state="idle|clearing|copying|exporting"`; diagnostic log viewer |
| `timeline` | Editor timeline |
| `timeline-segment` | `data-selected="true|false"` |
| `audio-track` | `data-selected`, `data-muted`, `data-included`, each `"true"` or `"false"` |

Some specialized buttons use a specific component value such as `capture-button` in place of `button`; `.btn` continues to match every shared button. Use native/ARIA state selectors for hover, focus, selection, and disabled controls rather than inferring those states from colors.

Dropdowns and context menus use native popovers in Chromium's top layer. Their DOM ancestry and inherited variables are preserved, so page-scoped selectors still apply. Ancestor `backdrop-filter`, `filter`, transforms, and overflow clipping do not change their viewport placement. Style their surfaces, fonts, borders, and options; leave positioning and popover visibility to Shard. They close when their surrounding page scrolls or the window resizes; scrolling inside the menu keeps it open.

`theme-picker` is the layout wrapper around several cards, including the gaps between them. To decorate individual panels without a rectangular background showing behind rounded corners, scope a background to `[data-shard-component="theme-picker"] [data-shard-component="card"]`. Navigation containers likewise have their own surface: if a theme gives one a background or border, also give that container a radius. The radius of a child button does not round its parent.

## Slots

`[data-shard-slot="<value>"]` identifies a region inside a component:

- Shell: `titlebar`, `content`, `statusbar`, `status-tools`, `console-launcher`.
- Cards: `card-header`, `card-body`, `card-footer`.
- Settings: `settings-navigation`, `settings-content`.
- Capture: `capture-actions`.
- Library: `library-header`, `library-heading`, `library-header-actions`, `library-summary`, `library-navigation`, `library-source-filter`, `library-filter-count`, `toolbar`, `library-search`, `library-results`, `clip-grid`.
- Clip cards: `clip-thumbnail`, `clip-image`, `clip-placeholder`, `clip-play`, `clip-source`, `clip-duration`, `clip-details`, `clip-heading`, `clip-title`, `clip-filename`, `clip-date`, `clip-size`, `clip-actions`, `clip-delete-confirmation`, `clip-error`.
- Dialogs: `modal-panel`, `modal-header`, `modal-heading`, `modal-title`, `modal-subtitle`, `modal-body`, `modal-footer`.
- Clip viewer: `viewer-media`, `viewer-details`, `viewer-heading`, `viewer-metadata`, `viewer-date`, `viewer-duration`, `viewer-size`, `viewer-resolution`, `viewer-framerate`, `viewer-actions`, `viewer-file`, `viewer-filename`, `viewer-error`.
- Games, editor, and timeline: `toolbar`, `editor-rename`.
- Player: `player-stage`, `player-video`, `player-feedback`, `player-loading`, `player-status`, `player-controls`, `player-seek`, `player-transport`, `player-time`, `player-volume`, `player-speed`, `player-error`.
- Renaming: `rename-form`, `rename-input`, `rename-actions`, `rename-error`.
- Medal import: `import-description`, `import-options`, `import-progress`, `import-result`, `import-error`, `import-actions`.
- Developer console: `console-shell`, `console-header`, `console-identity`, `console-heading`, `console-live-state`, `console-controls`, `console-filters`, `console-search`, `console-actions`, `console-workspace`, `console-overflow`, `console-feedback`, `console-results`, `console-list`, `console-empty`, `console-pagination`, `console-row`, `console-time`, `console-source`, `console-severity`, `console-message`, `console-footer`, `console-counts`, `console-paging`, `console-keyboard-help`.

Slots are intentionally reusable; scope a toolbar to its page/component. Modal placement is controlled by Shard, so do not assume all dialogs descend from a particular page.

The clip viewer's outer overlay uses `[data-shard-component="modal"][data-shard-modal="clip-viewer"]`; its video/details layout uses `[data-shard-component="clip-viewer"]`. Use the former for dialog placement, panel, and header styling, and the latter for media, metadata, and actions. The same viewer opens from Library and Capture. Clip cards keep `.clip`, `.clip__thumb`, and `.clip__meta`, but the thumbnail and title are now keyboard-accessible buttons; reset button-specific styling through the corresponding slots if needed.

The Medal import dialog uses `[data-shard-component="modal"][data-shard-modal="medal-import"]`. Rename and import controls use the shared button/input tokens. Playback speed uses the existing select and select-menu components inside `player-speed`; its value affects preview playback only.

The developer-console root exposes `data-shard-state="loading|ready|error"` for history loading, `data-stream-state="live|paused"` for the live feed, and `data-action-state="idle|clearing|copying|exporting"` for the current asynchronous action. The `console-actions` slot also exposes that action state as `data-shard-state`. Console rows expose `data-severity="debug|info|warn|error"` and `data-source="core|core.stdout|core.stderr|app|rpc|event|updates"`. Source identifies where a line came from; severity describes its content. In particular, `core.stderr` is not itself an error or warning. Use status tokens for severity emphasis and preserve selectable log text. The live view retains bounded history; its overflow notice and pagination remain independent of the full-session export.

Fullscreen player controls animate out of view after inactivity. Style their colors and surfaces through the slots/tokens, while preserving Shard's visibility, transforms, focus behavior, and media geometry. Keyboard-focused controls remain visible. Loading, errors, and optional metadata slots are rendered only when relevant.

## Design tokens

Define tokens on `:root`. Values inherit unless explicitly overridden by a component. The table is exhaustive for supported base tokens; variables beginning `--_` are private. Generated `--theme-*` variables belong to your manifest.

| Family | Supported names |
| --- | --- |
| Surfaces | `--bg-0`, `--bg-1`, `--bg-2`, `--bg-3`, `--bg-4` |
| Borders | `--stroke`, `--stroke-2`, `--stroke-3` |
| Text | `--fg`, `--fg-2`, `--fg-3`, `--fg-4` |
| Accent | `--accent`, `--accent-2`, `--accent-ink`, `--accent-soft`, `--accent-softer`, `--accent-grad`, `--accent-grad-soft` |
| Status | `--rec`, `--rec-soft`, `--ok`, `--ok-soft`, `--warn`, `--warn-soft`, `--danger`, `--danger-soft` |
| Radii | `--r-xs`, `--r-sm`, `--r-md`, `--r-lg`, `--r-xl`, `--r-pill` |
| Spacing | `--sp-1`, `--sp-2`, `--sp-3`, `--sp-4`, `--sp-5`, `--sp-6`, `--sp-8`, `--sp-10` |
| Fonts | `--font-ui`, `--font-mono`; legacy aliases `--font`, `--mono` |
| Font sizes | `--fs-10`, `--fs-11`, `--fs-12`, `--fs-13`, `--fs-14`, `--fs-15`, `--fs-17`, `--fs-20`, `--fs-26` |
| Controls | `--control-height`, `--control-radius`, `--focus` |
| Layout | `--page-width`, `--page-gutter` |
| Elevation | `--shadow-1`, `--shadow-2`, `--shadow-3` |
| Transitions | `--t`, `--t-fast` (duration plus timing function) |
| Overlays | `--overlay-bg`, `--media-badge-bg`, `--media-badge-fg` |
| Player | `--player-bg`, `--player-controls-bg`, `--player-overlay-bg`, `--player-overlay-fg` |
| Timeline | `--timeline-bg`, `--timeline-label-bg`, `--timeline-ruler-bg`, `--timeline-track-bg`, `--timeline-cut`, `--timeline-selection`, `--timeline-handle`, `--timeline-playhead` |
| Waveform | `--waveform`, `--waveform-muted` (canvas colors repaint on theme/option changes) |
| Icons | `--icon-<name>`; see below |

`--bg-0` is the deepest background and higher numbers are raised surfaces. `--fg` is primary text, with decreasing emphasis through `--fg-4`. `--accent-ink` is text on solid accent buttons. `--accent-grad` and `--accent-grad-soft` accept CSS background images. Token changes do not alter video pixels; the actual video canvas stays black outside the image. Fixed media-coordinate geometry and some internal decoration intentionally are not tokenized.

`--player-overlay-bg` accepts a CSS background, including a gradient, for fullscreen controls. `--player-overlay-fg` controls their foreground and derives from `--media-badge-fg` by default. Keep both readable over light and dark video frames. Media thumbnails, loading indicators, and playback feedback use the existing media badge tokens.

## Icons

`[data-icon="<name>"]` selects a decorative SVG. An image override uses `--icon-<name>: url(...)`. Supported names:

`aperture`, `scissor`, `play`, `pause`, `stop`, `record`, `scissors`, `settings`, `gear`, `export`, `folder`, `folder-open`, `trash`, `star`, `star2`, `droplet`, `x`, `search`, `filter`, `sliders`, `screen`, `monitor`, `chevron`, `chevron-down`, `check`, `plus`, `capture`, `video`, `bell`, `link`, `power`, `refresh`, `volume`, `speaker`, `volume-off`, `maximize`, `minimize`, `maximize-window`, `restore`, `zoom-in`, `zoom-out`, `fit`, `crosshair`, `target`, `back`, `terminal`, `save`, `film`, `mic`, `disc`, `hard-drive`, `auto`, `bell-off`, `edit`, `clock`, `undo`, `redo`, `key`, `box`, `games`, `gamepad`, `paintbrush`, `overlay`, `question`.

## Legacy class contract

These classes remain supported alongside the semantic hooks:

```text
.app .app__bar .app__main .app__status
.nav .nav__item
.card .card__head .card__title .card__body .card__foot
.settings .settings__nav .settings__nav-item .settings__content
.capture .capture__hero .capture__title .capture__subject
.library .grid .clip .clip__thumb .clip__meta
.games .games__row .editor .timeline
.btn .btn--primary .btn--ghost .chip .badge
.modal .toasts .toast
.window-controls .window-control .window-control--close
.empty .toolbar .search .meter .seg .toggle .input .select
```

`.editor` is now an explicit alias on the editor workspace. `.select` targets native selects; the custom select button has the `select` component hook. This list intentionally has no “etc.” promise. For layouts, keep titlebar drag regions and window buttons accessible; use responsive rules as shown in Afterglow.
