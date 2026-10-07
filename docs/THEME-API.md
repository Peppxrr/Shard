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
| `card` | Shared panel; optional `data-shard-span="full"` spans the Settings section grid |
| `utility-rail` | Secondary information grouped with dividers and quiet, unbordered panels; Capture summary and Games options |
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
| `library-filters` | Library tab group; child filter buttons expose `data-source="all|clip|recording|edited|favorites"` and `aria-pressed`. Favorites includes protected clips from every source. |
| `clip-viewer` | Video and details layout inside the preview dialog; `data-source="clip|recording|edited"` |
| `game` | Running entry: `data-running="true|false"`; excluded entry: `data-excluded="true"` |
| `player` | `data-playing`, `data-fullscreen`, `data-controls-visible`, each `"true|false"`; `data-shard-state="loading|ready|error"` |
| `clip-rename` | `data-shard-state="idle|editing|saving"`; inline file rename form shared by viewer and editor |
| `medal-import` | `data-shard-state="idle|importing|complete"`; folder selection and import results |
| `developer-console` | `data-shard-state="loading|ready|error"`, `data-stream-state="live|paused"`, `data-action-state="idle|clearing|copying|exporting"`; diagnostic log viewer |
| `timeline` | Editor timeline; `data-audio="linked|separate|none"` (whether audio follows the video clips) and `data-audio-view="collapsed|expanded"` (absent without audio). Collapsed (the default) draws one mixed waveform inside each video clip, plus bands on empty video time where separated audio plays; expanding shows one row per separated audio track. Collapsing never moves or relinks clips. |
| `timeline-segment` | A video clip on the timeline: `data-selected="true|false"`. Its `.timeline-segment__handle` edges trim it; dragging its body moves it. |
| `audio-clip` | A clip on a separated audio row: `data-selected="true|false"`; inherits `--track-color` and uses the same edge handles as `timeline-segment` |
| `audio-track` | Separated audio row: `data-selected`, `data-muted`, `data-included`, each `"true"` or `"false"`; sets `--track-color` to its `--waveform-N` palette entry |
| `mixer-track` | Editor inspector audio stream: `data-muted`, `data-included`, each `"true"` or `"false"`; sets `--track-color` like `audio-track` |

Some specialized buttons use a specific component value such as `capture-button` in place of `button`; `.btn` continues to match every shared button. Use native/ARIA state selectors for hover, focus, selection, and disabled controls rather than inferring those states from colors.

Dropdowns and context menus use native popovers in Chromium's top layer. Their DOM ancestry and inherited variables are preserved, so page-scoped selectors still apply. Ancestor `backdrop-filter`, `filter`, transforms, and overflow clipping do not change their viewport placement. Style their surfaces, fonts, borders, and options; leave positioning and popover visibility to Shard. They close when their surrounding page scrolls or the window resizes; scrolling inside the menu keeps it open.

`theme-picker` is the layout wrapper around several cards, including the gaps between them. To decorate individual panels without a rectangular background showing behind rounded corners, scope a background to `[data-shard-component="theme-picker"] [data-shard-component="card"]`. Navigation containers likewise have their own surface: if a theme gives one a background or border, also give that container a radius. The radius of a child button does not round its parent.

## Slots

`[data-shard-slot="<value>"]` identifies a region inside a component:

- Shell: `titlebar`, `titlebar-drag` (the flexible, full-height empty area between navigation and titlebar actions; preserve its native drag behavior), `content`, `statusbar`, `status-tools`, `console-launcher`, `window-controls` (minimize/maximize/close; a fixed overlay at the top right of the window, above pages, dialogs, and the editor, `--titlebar-h` tall).
- Cards: `card-header`, `card-body`, `card-footer`.
- Settings: `settings-navigation`, `settings-content`, `settings-search` (navigation search input), `settings-navigation-divider` (separator between search and categories), `settings-search-results` (scrollable matching destinations in a top-layer popup), `settings-section-layout` (responsive arrangement of independent panels), `storage-import` (Import section in Storage).
- Appearance: `theme-search` (custom-theme filter), `custom-theme-list` (scrollable list showing up to five entries at a time).
- Capture: `capture-primary` (compact status and clip controls), `capture-actions`, `capture-summary` (supporting hotkey, encoding, and storage panels), `capture-recent` (clip grid without an enclosing card).
- Storage: `data-shard-component="storage-summary"` in Capture and Storage settings shows clip usage against the cleanup limit and bytes kept separately (`storage-usage`) above the meter. `data-shard-state="loading|within-target|disabled|cleaning|recent|minimum|needs-review|busy"` identifies cleanup state. The summary and statusbar meters continuously blend from `--accent` toward `--warn` as usage rises to 75%, then toward `--danger` at 90% or above. `storage-notice` explains an over-limit state or previews unsaved cleanup settings; in `needs-review` it contains a danger **Clean up now** button that opens a confirmation dialog. `storage-cleanup-toggle` is the on/off switch in the Automatic cleanup card header. These use the existing meter, button, toggle, spacing, foreground, background, border, and radius tokens.
- Library: `library-header`, `library-heading`, `library-header-actions`, `library-summary`, `library-navigation`, `library-source-filter`, `library-filter-count`, `toolbar`, `library-search`, `library-results`, `clip-grid`.
- Clip cards: `clip-thumbnail`, `clip-image`, `clip-placeholder`, `clip-play`, `clip-source`, `clip-duration`, `clip-details`, `clip-heading`, `clip-title`, `clip-filename`, `clip-date`, `clip-size`, `clip-actions`, `clip-delete-confirmation`, `clip-error`.
- Dialogs: `modal-panel`, `modal-header`, `modal-heading`, `modal-title`, `modal-subtitle`, `modal-body`, `modal-footer`.
- Clip viewer: `viewer-media`, `viewer-details`, `viewer-heading`, `viewer-metadata`, `viewer-date`, `viewer-duration`, `viewer-size`, `viewer-resolution`, `viewer-framerate`, `viewer-actions`, `viewer-file`, `viewer-filename`, `viewer-error`.
- Games, editor, and timeline: `toolbar`, `games-status` (compact detection status), `games-workspace` (game list beside supporting options on wide windows), `games-options` (secondary recording and detection settings), `editor-rename`, `timeline-audio-mix` (the collapsed mixed-waveform band inside each video clip), `timeline-audio-only` (collapsed separated audio playing over empty video time: a dashed "Audio only" block holding its own `timeline-audio-mix` band), `timeline-snap-guide` (the line drawn where a dragged clip edge snapped).
- Editor layout: the header (`toolbar`) is the titlebar while the editor is open; its export button becomes **Cancel export** while encoding. `editor-body` arranges `editor-stage` (the player) beside `editor-inspector`, with the timeline below a `timeline-resize` separator; `editor-body` exposes `data-timeline-size="auto|custom"` and `--editor-timeline-h` once the user resizes. Inspector panels: `editor-output` (output length, resolution, frame rate), `editor-selection`, `editor-mixer` (one `mixer-track` component per audio stream with `data-muted` and `data-included`), and `editor-shortcuts`. A finished export opens `editor-export`, a centred dialog with a close button in its top-right corner, **Open** (returns to the library and opens the export in the clip viewer), show-in-folder, and delete; failures show the error with the close button only.
- Player: `player-stage`, `player-video`, `player-feedback`, `player-loading`, `player-status`, `player-controls`, `player-seek`, `player-transport`, `player-time`, `player-volume`, `player-speed`, `player-error`. In the editor stage the player uses a single-row transport, so `player-seek` sits inside `player-transport` between the time and volume. While the editor playhead is in empty timeline time, `player-video` has `data-blank="true"` and renders black. During an editor export the playhead, `player-seek`, and picture follow the encoder silently, and `player-status` shows the phase and percentage.
- Renaming: `rename-form`, `rename-input`, `rename-actions`, `rename-error`.
- Medal import: `import-description`, `import-options`, `import-progress`, `import-result`, `import-error`, `import-actions`.
- Developer console: `console-shell`, `console-header`, `console-identity`, `console-heading`, `console-live-state`, `console-controls`, `console-filters`, `console-search`, `console-actions`, `console-workspace`, `console-overflow`, `console-feedback`, `console-results`, `console-list`, `console-empty`, `console-pagination`, `console-row`, `console-time`, `console-source`, `console-severity`, `console-message`, `console-footer`, `console-counts`, `console-paging`, `console-keyboard-help`.
- Frame pacing: `data-shard-component="perf-hint"` on the Capture page is an inline yellow dropped-frame indicator after the capture metadata, with details in its native tooltip. It appears while recording drops frames, with `data-shard-state="gpu_starved|render_stall|encoder_overloaded"`. Clip cards show `clip-lag` (same `data-shard-state` values) when the capture lost frames; the editor's video track draws one `timeline-lag` region per lossy span, also with the cause as `data-shard-state`. These use the `--warn`/`--warn-soft` tokens. Settings → App has `data-shard-component="recording-priority"` with `data-shard-state="loading|unsupported|busy|off|active|inactive"` and slots `priority-warning` (inline CPU usage note within the description), `priority-status`, `priority-message`, plus `diagnostics-export` for the Export diagnostics row. Recording performance uses the shared settings spacing, separator, and text tokens.

Slots are intentionally reusable; scope a toolbar to its page/component. Modal placement is controlled by Shard, so do not assume all dialogs descend from a particular page.

The clip viewer's outer overlay uses `[data-shard-component="modal"][data-shard-modal="clip-viewer"]`; its video/details layout uses `[data-shard-component="clip-viewer"]`. Use the former for dialog placement, panel, and header styling, and the latter for media, metadata, and actions. The same viewer opens from Library and Capture. Clip cards keep `.clip`, `.clip__thumb`, and `.clip__meta`, but the thumbnail and title are now keyboard-accessible buttons; reset button-specific styling through the corresponding slots if needed.

Medal import is embedded in Settings → Storage under `storage-import`, with its existing `medal-import` component and description/options/progress/result/error slots. The former `medal-import` modal and `import-actions` slot are no longer rendered. `library-results` wraps the grid or empty state; the active tab label is shown only in the library navigation. Rename and import controls use the shared button/input tokens. Playback speed uses the existing select and select-menu components inside `player-speed`; its value affects preview playback only.

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
| Layout | `--page-width`, `--page-gutter`, `--page-padding-block`, `--settings-content-width`, `--titlebar-h` (titlebar and editor header height); `--window-controls-w` is the reserved window-button width (read-only, `0px` without custom window controls) |
| Elevation | `--shadow-1`, `--shadow-2`, `--shadow-3` |
| Transitions | `--t`, `--t-fast` (duration plus timing function) |
| Overlays | `--overlay-bg`, `--media-badge-bg`, `--media-badge-fg` |
| Player | `--player-bg`, `--player-controls-bg`, `--player-overlay-bg`, `--player-overlay-fg` |
| Timeline | `--timeline-bg`, `--timeline-label-bg`, `--timeline-ruler-bg`, `--timeline-track-bg` (clip body base), `--timeline-cut` (empty track time, which exports as black video / silence), `--timeline-selection`, `--timeline-handle`, `--timeline-playhead`, `--timeline-snap` (snap guide) |
| Waveform | `--waveform` (linked mix), `--waveform-1` … `--waveform-6` (per-track palette when audio is separated, cycling by audio stream), `--waveform-muted`; canvas colors repaint on theme/option changes |
| Icons | `--icon-<name>`; see below |

`--bg-0` is the deepest background and higher numbers are raised surfaces. `--fg` is primary text, with decreasing emphasis through `--fg-4`. `--accent-ink` is text on solid accent buttons. `--accent-grad` and `--accent-grad-soft` accept CSS background images. Token changes do not alter video pixels; the actual video canvas stays black outside the image. Fixed media-coordinate geometry and some internal decoration intentionally are not tokenized.

`--player-overlay-bg` accepts a CSS background, including a gradient, for fullscreen controls. `--player-overlay-fg` controls their foreground and derives from `--media-badge-fg` by default. Keep both readable over light and dark video frames. Media thumbnails, loading indicators, and playback feedback use the existing media badge tokens.

Overview pages use a broad workspace centered within wide windows, with left-aligned content and fluid horizontal gutters. `--page-width` caps that workspace (Capture and Games, 1800px including padding by default). Library retains full available width so its clip grid can gain columns. `--page-gutter` also aligns the titlebar and statusbar; `--page-padding-block` sets page vertical padding and the sticky Settings navigation inset.

Settings navigation aligns with the left page gutter and uses compact desktop category labels, icons, and targets. Its search field sits above Appearance, separated from the categories by a token-colored divider, and matches the navigation targets. Matching settings appear in a compact top-layer popup beside the field, with internal scrolling; narrow windows can place it below the field. Search keeps the current settings content mounted and moves focus to the chosen destination. The main column is capped by `--settings-content-width` (1080px by default) and centered in the window from 1440px; smaller desktops reclaim the spare right column. Sections stack vertically at every width; `settings-section-layout` identifies that flow. Children marked `data-shard-span="full"` span the section layout, which currently has one column. Horizontal choices and import options adapt inside their sections. Form rows are bounded by the main column, and text hints retain readability limits. Card internals respond to their own panel width. Below 700px window width, Settings navigation wraps above the content. Unused space beyond the comfortable column is intentional.

Custom themes have a header search field that filters names, authors, descriptions, and IDs. The list measures its first five entries to bound its height even when text wraps; remaining entries scroll internally. Open themes folder and Reload themes share a footer row with equal control dimensions. Built-in themes, selection, and theme options retain their existing behavior.

From 1200px window width, Capture places a quiet information rail beside its compact primary capture area and unframed Recent grid. The rendered grid column count sets the recent-clip capacity to two rows and updates on resize; spare tracks remain when fewer clips exist. Status and clip controls share one surface; `capture-hero` remains the status component inside it. From 1280px, Games places recording/detection options beside its list; its detection status is a small utility strip. At smaller widths supporting sections return beneath the primary content. `utility-rail` groups existing card components using spacing and dividers rather than large enclosing panels. Library card dates and file sizes share a compact line, with sizes aligned right and recent relative ages available on the date tooltip. Dialogs and editors keep their existing focused widths and viewport geometry. Existing page, component, and Settings slots are preserved; themes should avoid assuming DOM depth inside these regions.

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
