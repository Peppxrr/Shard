// Original upstream assets, pinned versions and hashes in assets/icons/upstream/sources.json.
import asset0 from "../assets/icons/upstream/feather-aperture.svg?raw";
import asset1 from "../assets/icons/upstream/feather-arrow-left.svg?raw";
import asset2 from "../assets/icons/upstream/feather-bell.svg?raw";
import asset3 from "../assets/icons/upstream/feather-bell-off.svg?raw";
import asset4 from "../assets/icons/upstream/feather-check.svg?raw";
import asset5 from "../assets/icons/upstream/feather-chevron-down.svg?raw";
import asset6 from "../assets/icons/upstream/feather-chevron-right.svg?raw";
import asset7 from "../assets/icons/upstream/feather-circle.svg?raw";
import asset8 from "../assets/icons/upstream/feather-clock.svg?raw";
import asset9 from "../assets/icons/upstream/feather-copy.svg?raw";
import asset10 from "../assets/icons/upstream/feather-crosshair.svg?raw";
import asset11 from "../assets/icons/upstream/feather-disc.svg?raw";
import asset12 from "../assets/icons/upstream/feather-droplet.svg?raw";
import asset13 from "../assets/icons/upstream/feather-edit-2.svg?raw";
import asset14 from "../assets/icons/upstream/feather-film.svg?raw";
import asset15 from "../assets/icons/upstream/feather-filter.svg?raw";
import asset16 from "../assets/icons/upstream/feather-folder.svg?raw";
import asset17 from "../assets/icons/upstream/feather-hard-drive.svg?raw";
import asset18 from "../assets/icons/upstream/feather-help-circle.svg?raw";
import asset19 from "../assets/icons/upstream/feather-link.svg?raw";
import asset20 from "../assets/icons/upstream/feather-maximize.svg?raw";
import asset21 from "../assets/icons/upstream/feather-mic.svg?raw";
import asset22 from "../assets/icons/upstream/feather-minus.svg?raw";
import asset23 from "../assets/icons/upstream/feather-monitor.svg?raw";
import asset24 from "../assets/icons/upstream/feather-pause.svg?raw";
import asset25 from "../assets/icons/upstream/feather-play.svg?raw";
import asset26 from "../assets/icons/upstream/feather-plus.svg?raw";
import asset27 from "../assets/icons/upstream/feather-power.svg?raw";
import asset28 from "../assets/icons/upstream/feather-refresh-cw.svg?raw";
import asset29 from "../assets/icons/upstream/feather-rotate-ccw.svg?raw";
import asset30 from "../assets/icons/upstream/feather-rotate-cw.svg?raw";
import asset31 from "../assets/icons/upstream/feather-save.svg?raw";
import asset32 from "../assets/icons/upstream/feather-scissors.svg?raw";
import asset33 from "../assets/icons/upstream/feather-search.svg?raw";
import asset34 from "../assets/icons/upstream/feather-settings.svg?raw";
import asset35 from "../assets/icons/upstream/feather-sliders.svg?raw";
import asset36 from "../assets/icons/upstream/feather-square.svg?raw";
import asset37 from "../assets/icons/upstream/feather-star.svg?raw";
import asset38 from "../assets/icons/upstream/feather-target.svg?raw";
import asset39 from "../assets/icons/upstream/feather-terminal.svg?raw";
import asset40 from "../assets/icons/upstream/feather-trash-2.svg?raw";
import asset41 from "../assets/icons/upstream/feather-upload.svg?raw";
import asset42 from "../assets/icons/upstream/feather-video.svg?raw";
import asset43 from "../assets/icons/upstream/feather-volume-2.svg?raw";
import asset44 from "../assets/icons/upstream/feather-volume-x.svg?raw";
import asset45 from "../assets/icons/upstream/feather-x.svg?raw";
import asset46 from "../assets/icons/upstream/feather-zap.svg?raw";
import asset47 from "../assets/icons/upstream/feather-zoom-in.svg?raw";
import asset48 from "../assets/icons/upstream/feather-zoom-out.svg?raw";
import asset49 from "../assets/icons/upstream/lucide-gamepad-2.svg?raw";
import asset50 from "../assets/icons/upstream/lucide-keyboard.svg?raw";
import asset51 from "../assets/icons/upstream/lucide-paintbrush.svg?raw";
import asset52 from "../assets/icons/upstream/lucide-picture-in-picture-2.svg?raw";

const assets: Record<string, string> = {
  aperture: asset0,
  record: asset7,
  stop: asset36,
  play: asset25,
  pause: asset24,
  scissor: asset32,
  scissors: asset32,
  question: asset18,
  settings: asset34,
  gear: asset34,
  export: asset41,
  folder: asset16,
  folderOpen: asset16,
  trash: asset40,
  star: asset37,
  star2: asset37,
  droplet: asset12,
  x: asset45,
  search: asset33,
  filter: asset15,
  sliders: asset35,
  screen: asset23,
  monitor: asset23,
  chevron: asset6,
  chevronDown: asset5,
  check: asset4,
  plus: asset26,
  capture: asset42,
  video: asset42,
  bell: asset2,
  link: asset19,
  power: asset27,
  refresh: asset28,
  volume: asset43,
  speaker: asset43,
  volumeOff: asset44,
  maximize: asset20,
  minimize: asset22,
  maximizeWindow: asset36,
  restore: asset9,
  zoomIn: asset47,
  zoomOut: asset48,
  fit: asset20,
  crosshair: asset10,
  target: asset38,
  back: asset1,
  terminal: asset39,
  save: asset31,
  film: asset14,
  mic: asset21,
  disc: asset11,
  hardDrive: asset17,
  auto: asset46,
  bellOff: asset3,
  edit: asset13,
  clock: asset8,
  undo: asset29,
  redo: asset30,
  key: asset50,
  box: asset49,
  games: asset49,
  gamepad: asset49,
  paintbrush: asset51,
  overlay: asset52,
};

// Keep the original path data. Icon supplies only the outer SVG for sizing,
// theme color and accessible decoration.
export const ICON_MARKUP: Record<string, string> = Object.fromEntries(
  Object.entries(assets).map(([name, svg]) => [name, svg.slice(svg.indexOf(">", svg.indexOf("<svg")) + 1, svg.lastIndexOf("</svg>"))]),
);
