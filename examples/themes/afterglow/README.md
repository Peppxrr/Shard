# Afterglow

An editable example for Shard Theme API 1 (Shard 0.1.5 or newer).

Copy this entire folder into the folder opened by **Settings → Appearance → Open themes folder**. Select **Afterglow** and **Save changes**. Options save immediately: accent color, text size, navigation position, spacing, corners, and constellation artwork. Side navigation becomes a top bar below 1000 px so narrow windows remain usable.

- `theme.json`: metadata, ordered stylesheets, and option declarations.
- `theme.css`: tokens, typography, icon override, and optional side navigation.
- `pages.css`: page/state hooks for Capture, Library, Settings, Games, and the editor.
- `assets/`: original static SVG artwork; no external resources or bundled fonts.

The capture glyph uses fixed SVG colors; the accent option recolors interface controls, not the pixels inside the glyph. Edit `assets/orbit.svg` to change its colors. Text-size changes avoid changing timeline/media coordinates.

[Authoring guide](../../../docs/THEMES.md) · [API reference](../../../docs/THEME-API.md)

The relative `$schema` path in `theme.json` supplies editor completion within the repository. Outside the repository, omit it or copy `docs/theme.schema.json` beside the theme and use `./theme.schema.json`.

Code and original SVG artwork: GPL-2.0, like Shard. No third-party asset attribution is required for this example.
