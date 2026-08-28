// ui.tsx — reusable design-system primitives for the Shard UI.
// Pure presentation over functionality; no business logic, no IPC.
// Feather icons used via assets/icons (only those imported here are bundled).
import questionAsset from "../assets/icons/question.svg?raw";
import exportAsset from "../assets/icons/export.svg?raw";
import paintbrushAsset from "../assets/icons/paintbrush.svg?raw";
import keyAsset from "../assets/icons/key.svg?raw";
import volumeAsset from "../assets/icons/volume-2.svg?raw";
import volumeXAsset from "../assets/icons/volume-x.svg?raw";
import saveAsset from "../assets/icons/save.svg?raw";
import videoAsset from "../assets/icons/video.svg?raw";
import filmAsset from "../assets/icons/film.svg?raw";
import boxAsset from "../assets/icons/box.svg?raw";
import settingsAsset from "../assets/icons/settings.svg?raw";
import searchAsset from "../assets/icons/search.svg?raw";
import filterAsset from "../assets/icons/filter.svg?raw";
import refreshAsset from "../assets/icons/refresh-cw.svg?raw";
import trashAsset from "../assets/icons/trash-2.svg?raw";
import plusAsset from "../assets/icons/plus.svg?raw";
import discAsset from "../assets/icons/disc.svg?raw";
import playAsset from "../assets/icons/play.svg?raw";
import pauseAsset from "../assets/icons/pause.svg?raw";
import scissorsAsset from "../assets/icons/scissors.svg?raw";
import checkAsset from "../assets/icons/check.svg?raw";
import xAsset from "../assets/icons/x.svg?raw";
import monitorAsset from "../assets/icons/monitor.svg?raw";
import micAsset from "../assets/icons/mic.svg?raw";
import folderAsset from "../assets/icons/folder.svg?raw";
import apertureAsset from "../assets/icons/aperture.svg?raw";
import slidersAsset from "../assets/icons/sliders.svg?raw";
import bellAsset from "../assets/icons/bell.svg?raw";
import linkAsset from "../assets/icons/link.svg?raw";
import powerAsset from "../assets/icons/power.svg?raw";
import chevronAsset from "../assets/icons/chevron-right.svg?raw";
import maximizeAsset from "../assets/icons/maximize.svg?raw";
import undoAsset from "../assets/icons/rotate-ccw.svg?raw";
import redoAsset from "../assets/icons/rotate-cw.svg?raw";
import zoomInAsset from "../assets/icons/zoom-in.svg?raw";
import zoomOutAsset from "../assets/icons/zoom-out.svg?raw";
import crosshairAsset from "../assets/icons/crosshair.svg?raw";
import targetAsset from "../assets/icons/target.svg?raw";
import hardDriveAsset from "../assets/icons/hard-drive.svg?raw";
import terminalAsset from "../assets/icons/terminal.svg?raw";
import starAsset from "../assets/icons/star.svg?raw";
import dropletAsset from "../assets/icons/droplet.svg?raw";

// Ensure Vite bundles only used icons (reference to avoid tree-shake)
void [
  questionAsset, exportAsset, paintbrushAsset, keyAsset, volumeAsset, volumeXAsset, saveAsset, videoAsset, filmAsset, boxAsset, settingsAsset, searchAsset, filterAsset,
  refreshAsset, trashAsset, plusAsset, discAsset, playAsset, pauseAsset, scissorsAsset, checkAsset, xAsset, monitorAsset,
  micAsset, folderAsset, apertureAsset, slidersAsset, bellAsset, linkAsset, powerAsset, chevronAsset, maximizeAsset,
  undoAsset, redoAsset, zoomInAsset, zoomOutAsset, crosshairAsset, targetAsset, hardDriveAsset, terminalAsset, starAsset, dropletAsset,
];

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { THEME_CHANGE_EVENT } from "../themeManager";

/* ---------------------------------------------------------------------------
 * Icon — curated 24-grid stroke glyphs, currentColor, 16px default.
 * ------------------------------------------------------------------------- */
function readThemeIconUrl(token: string): string | null {
  if (typeof document === "undefined") return null;
  const value = getComputedStyle(document.documentElement).getPropertyValue(`--icon-${token}`).trim();
  const match = value.match(/^url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)$/i);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "").trim() || null : null;
}

function useThemeIconUrl(token: string): string | null {
  const [url, setUrl] = useState<string | null>(() => readThemeIconUrl(token));
  useLayoutEffect(() => {
    const refresh = () => setUrl(readThemeIconUrl(token));
    refresh();
    window.addEventListener(THEME_CHANGE_EVENT, refresh);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, refresh);
  }, [token]);
  return url;
}

const GLYPH: Record<string, ReactNode> = {
  // Feather-based, content-sized via parent <svg viewBox 0 0 24 24>
  aperture: <><circle cx="12" cy="12" r="10" /><line x1="14.31" y1="8" x2="20.05" y2="17.94" /><line x1="9.69" y1="8" x2="21.17" y2="8" /><line x1="7.38" y1="12" x2="13.12" y2="2.06" /><line x1="9.69" y1="16" x2="3.95" y2="6.06" /><line x1="14.31" y1="16" x2="2.83" y2="16" /><line x1="16.62" y1="12" x2="10.88" y2="21.94" /></>,
  record: <><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="3" /></>,
  stop: <><rect x="6" y="6" width="12" height="12" rx="2.2" fill="currentColor" stroke="none" /></>,
  play: <><polygon points="5 3 19 12 5 21 5 3" /></>,
  pause: <><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></>,
  scissor: <><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><line x1="20" y1="4" x2="8.12" y2="15.88" /><line x1="14.47" y1="14.48" x2="20" y2="20" /><line x1="8.12" y1="8.12" x2="12" y2="12" /></>,
  // keep short alias
  question: <g transform="scale(1.5)"><path fill="currentColor" stroke="none" d="M5.255 5.786a.237.237 0 0 0 .241.247h.825c.138 0 .248-.113.266-.25.09-.656.54-1.134 1.342-1.134.686 0 1.314.343 1.314 1.168 0 .635-.374.927-.965 1.371-.673.489-1.206 1.06-1.168 1.987l.003.217a.25.25 0 0 0 .25.246h.811a.25.25 0 0 0 .25-.25v-.105c0-.718.273-.927 1.01-1.486.609-.463 1.244-.977 1.244-2.056 0-1.511-1.276-2.241-2.673-2.241-1.267 0-2.655.59-2.75 2.286m1.557 5.763c0 .533.425.927 1.01.927.609 0 1.028-.394 1.028-.927 0-.552-.42-.94-1.029-.94-.584 0-1.009.388-1.009.94" /></g>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></>,
  export: <g transform="scale(0.09375)"><path fill="currentColor" stroke="none" d="M216,112v96a16,16,0,0,1-16,16H56a16,16,0,0,1-16-16V112A16,16,0,0,1,56,96H80a8,8,0,0,1,0,16H56v96H200V112H176a8,8,0,0,1,0-16h24A16,16,0,0,1,216,112ZM93.66,69.66,120,43.31V136a8,8,0,0,0,16,0V43.31l26.34,26.35a8,8,0,0,0,11.32-11.32l-40-40a8,8,0,0,0-11.32,0l-40,40A8,8,0,0,0,93.66,69.66Z" /></g>,
  paintbrush: <><path d="m14.622 17.897-10.68-2.913" /><path d="M18.376 2.622a1 1 0 1 1 3.002 3.002L17.36 9.643a.5.5 0 0 0 0 .707l.944.944a2.41 2.41 0 0 1 0 3.408l-.944.944a.5.5 0 0 1-.707 0L8.354 7.348a.5.5 0 0 1 0-.707l.944-.944a2.41 2.41 0 0 1 3.408 0l.944.944a.5.5 0 0 0 .707 0z" /><path d="M9 8c-1.804 2.71-3.97 3.46-6.583 3.948a.507.507 0 0 0-.302.819l7.32 8.883a1 1 0 0 0 1.185.204C12.735 20.405 16 16.792 16 15" /></>,
  scissors: <><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><line x1="20" y1="4" x2="8.12" y2="15.88" /><line x1="14.47" y1="14.48" x2="20" y2="20" /><line x1="8.12" y1="8.12" x2="12" y2="12" /></>,
  folder: <><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></>,
  folderOpen: <><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></>,
  trash: <><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></>,
  star: <><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></>,
  droplet: <><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" /></>,
    x: <><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></>,
  search: <><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></>,
  filter: <><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" /></>,
  sliders: <><line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" /><line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" /><line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" /><line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" /></>,
  gear: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></>,
  gamepad: <><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 1 2 0l7-4A2 2 0 0 0 21 16z" /><polyline points="3.27 6.96 12 12.01 20.73 6.96" /><line x1="12" y1="22.08" x2="12" y2="12" /></>,
  screen: <><rect x="2" y="3" width="20" height="14" rx="2" ry="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></>,
  monitor: <><rect x="2" y="3" width="20" height="14" rx="2" ry="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></>,
  games: <><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 1 2 0l7-4A2 2 0 0 0 21 16z" /><polyline points="3.27 6.96 12 12.01 20.73 6.96" /><line x1="12" y1="22.08" x2="12" y2="12" /></>,
  box: <g transform="scale(0.046875)"><path fill="none" stroke="currentColor" strokeMiterlimit="10" strokeWidth="32" d="M467.51 248.83c-18.4-83.18-45.69-136.24-89.43-149.17A91.5 91.5 0 0 0 352 96c-26.89 0-48.11 16-96 16s-69.15-16-96-16a99.09 99.09 0 0 0-27.2 3.66C89 112.59 61.94 165.7 43.33 248.83c-19 84.91-15.56 152 21.58 164.88 26 9 49.25-9.61 71.27-37 25-31.2 55.79-40.8 119.82-40.8s93.62 9.6 118.66 40.8c22 27.41 46.11 45.79 71.42 37.16 41.02-14.01 40.44-79.13 21.43-165.04z" /><circle fill="currentColor" stroke="none" cx="292" cy="224" r="20" /><path fill="currentColor" stroke="none" d="M336 288a20 20 0 1 1 20-19.95A20 20 0 0 1 336 288z" /><circle fill="currentColor" stroke="none" cx="336" cy="180" r="20" /><circle fill="currentColor" stroke="none" cx="380" cy="224" r="20" /><path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="32" d="M160 176v96m48-48h-96" /></g>,
  chevron: <><polyline points="9 18 15 12 9 6" /></>,
  check: <><polyline points="20 6 9 17 4 12" /></>,
  plus: <><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></>,
  capture: <><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" /></>,
  video: <><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" /></>,
  bell: <><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></>,
  link: <><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.72-1.71" /></>,
  power: <><path d="M18.36 6.64a9 9 0 1 1-12.73 0" /><line x1="12" y1="2" x2="12" y2="12" /></>,
  refresh: <><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.55 4.36A9 9 0 0 0 20.49 15" /></>,
  volume: <><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" /></>,
  volumeOff: <><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" /></>,
  speaker: <><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" /></>,
  maximize: <><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" /></>,
  minimize: <line x1="5" y1="12" x2="19" y2="12" />,
  maximizeWindow: <rect x="5" y="5" width="14" height="14" rx="1" />,
  restore: <><path d="M8 8V5h11v11h-3" /><rect x="5" y="8" width="11" height="11" rx="1" /></>,
  undo: <><polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /></>,
  redo: <><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></>,
  zoomIn: <><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="11" y1="8" x2="11" y2="14" /><line x1="8" y1="11" x2="14" y2="11" /></>,
  zoomOut: <><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="8" y1="11" x2="14" y2="11" /></>,
  fit: <><circle cx="12" cy="12" r="10" /><line x1="22" y1="12" x2="18" y2="12" /><line x1="6" y1="12" x2="2" y2="12" /><line x1="12" y1="6" x2="12" y2="2" /><line x1="12" y1="22" x2="12" y2="18" /></>,
  crosshair: <><circle cx="12" cy="12" r="10" /><line x1="22" y1="12" x2="18" y2="12" /><line x1="6" y1="12" x2="2" y2="12" /><line x1="12" y1="6" x2="12" y2="2" /><line x1="12" y1="22" x2="12" y2="18" /></>,
  target: <><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" /></>,
  back: <><line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" /></>,
  terminal: <><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></>,
  // Feather direct aliases
  key: <g transform="translate(0 1.3333) scale(0.0416667)"><path fill="currentColor" stroke="none" d="M64 112c-8.8 0-16 7.2-16 16l0 256c0 8.8 7.2 16 16 16l448 0c8.8 0 16-7.2 16-16l0-256c0-8.8-7.2-16-16-16L64 112zM0 128C0 92.7 28.7 64 64 64l448 0c35.3 0 64 28.7 64 64l0 256c0 35.3-28.7 64-64 64L64 448c-35.3 0-64-28.7-64-64L0 128zM176 320l224 0c8.8 0 16 7.2 16 16l0 16c0 8.8-7.2 16-16 16l-224 0c-8.8 0-16-7.2-16-16l0-16c0-8.8 7.2-16 16-16zm-72-72c0-8.8 7.2-16 16-16l16 0c8.8 0 16 7.2 16 16l0 16c0 8.8-7.2 16-16 16l-16 0c-8.8 0-16-7.2-16-16l0-16zm16-96l16 0c8.8 0 16 7.2 16 16l0 16c0 8.8-7.2 16-16 16l-16 0c-8.8 0-16-7.2-16-16l0-16c0-8.8 7.2-16 16-16zm64 96c0-8.8 7.2-16 16-16l16 0c8.8 0 16 7.2 16 16l0 16c0 8.8-7.2 16-16 16l-16 0c-8.8 0-16-7.2-16-16l0-16zm16-96l16 0c8.8 0 16 7.2 16 16l0 16c0 8.8-7.2 16-16 16l-16 0c-8.8 0-16-7.2-16-16l0-16c0-8.8 7.2-16 16-16zm64 96c0-8.8 7.2-16 16-16l16 0c8.8 0 16 7.2 16 16l0 16c0 8.8-7.2 16-16 16l-16 0c-8.8 0-16-7.2-16-16l0-16zm16-96l16 0c8.8 0 16 7.2 16 16l0 16c0 8.8-7.2 16-16 16l-16 0c-8.8 0-16-7.2-16-16l0-16c0-8.8 7.2-16 16-16zm64 96c0-8.8 7.2-16 16-16l16 0c8.8 0 16 7.2 16 16l0 16c0 8.8-7.2 16-16 16l-16 0c-8.8 0-16-7.2-16-16l0-16zm16-96l16 0c8.8 0 16 7.2 16 16l0 16c0 8.8-7.2 16-16 16l-16 0c-8.8 0-16-7.2-16-16l0-16c0-8.8 7.2-16 16-16zm64 96c0-8.8 7.2-16 16-16l16 0c8.8 0 16 7.2 16 16l0 16c0 8.8-7.2 16-16 16l-16 0c-8.8 0-16-7.2-16-16l0-16zm16-96l16 0c8.8 0 16 7.2 16 16l0 16c0 8.8-7.2 16-16 16l-16 0c-8.8 0-16-7.2-16-16l0-16c0-8.8 7.2-16 16-16z" /></g>,
  save: <><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><polyline points="17 21 17 13 7 13 7 21" /><polyline points="7 3 7 8 15 8" /></>,
  film: <><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" /><line x1="7" y1="2" x2="7" y2="22" /><line x1="17" y1="2" x2="17" y2="22" /><line x1="2" y1="12" x2="22" y2="12" /><line x1="2" y1="7" x2="7" y2="7" /><line x1="2" y1="17" x2="7" y2="17" /><line x1="17" y1="17" x2="22" y2="17" /><line x1="17" y1="7" x2="22" y2="7" /></>,
  mic: <><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" /></>,
  disc: <><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="3" /></>,
  hardDrive: <><line x1="22" y1="12" x2="2" y2="12" /><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-5.45-6.89A2 2 0 0 0 16 4H8a2 2 0 0 0-1.55.89z" /><line x1="6" y1="16" x2="6" y2="16" /><line x1="10" y1="16" x2="10" y2="16" /></>,
  star2: <><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></>,
};

export function Icon({ name, size = 16, className }: { name: keyof typeof GLYPH | string; size?: number; className?: string }) {
  const token = String(name)
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-z0-9-_]/gi, "-")
    .toLowerCase();
  const customUrl = useThemeIconUrl(token);
  const glyph = GLYPH[name] ?? GLYPH.aperture;
  return (
    <svg className={className} data-icon={token} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {customUrl
        ? <image href={customUrl} x="0" y="0" width="24" height="24" preserveAspectRatio="xMidYMid meet" />
        : glyph}
    </svg>
  );
}

/* ---------------------------------------------------------------------------
 * Button
 * ------------------------------------------------------------------------- */
type ButtonVariant = "default" | "primary" | "ghost" | "soft" | "danger";
type Size = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: Size;
  icon?: ReactNode;
  iconRight?: ReactNode;
  block?: boolean;
  loading?: boolean;
}
export function Button({ variant = "default", size = "md", icon, iconRight, block, loading, className, children, disabled, type, ...rest }: ButtonProps) {
  const cls = ["btn", variant !== "default" && `btn--${variant}`, size !== "md" && `btn--${size}`, block && "btn--block", className]
    .filter(Boolean).join(" ");
  return (
    <button className={cls} type={type ?? "button"} disabled={disabled || loading} {...rest}>
      {loading && <span className="spin" style={{ width: 14, height: 14 }} />}
      {icon}
      {children}
      {iconRight}
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "ghost" | "danger";
  size?: Size;
  active?: boolean;
  label?: string; // sets both title + aria-label
}
export function IconButton({ variant = "ghost", size = "md", active, label, className, children, type, ...rest }: IconButtonProps) {
  const cls = ["btn", "btn--icon", variant !== "ghost" && `btn--${variant}`, size !== "md" && `btn--${size}`, className]
    .filter(Boolean).join(" ");
  return (
    <button className={cls} type={type ?? "button"} aria-pressed={active} aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}

/* ---------------------------------------------------------------------------
 * Toggle / Checkbox / Slider
 * ------------------------------------------------------------------------- */
export function Toggle({ checked, onChange, disabled, id }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; id?: string }) {
  return (
    <span className="toggle">
      <input type="checkbox" id={id} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle__track"><span className="toggle__thumb" /></span>
    </span>
  );
}

export function Checkbox({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/* ---------------------------------------------------------------------------
 * Field wrapper
 * ------------------------------------------------------------------------- */
interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  inline?: boolean;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}
export function Field({ label, hint, inline, htmlFor, className, children }: FieldProps) {
  return (
    <div className={["field", inline && "field--inline", className].filter(Boolean).join(" ")}>
      {label && <label className="field__label" htmlFor={htmlFor}>{label}</label>}
      {children}
      {hint && <div className="field__hint">{hint}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Segmented control
 * ------------------------------------------------------------------------- */
export function Segmented<T extends string>({ value, onChange, options, block }: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode }[];
  block?: boolean;
}) {
  return (
    <div className={["seg", block && "seg--block"].filter(Boolean).join(" ")}>
      {options.map((o) => (
        <button key={o.value} type="button" className="seg__item" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Card / Section
 * ------------------------------------------------------------------------- */
interface CardProps {
  title?: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  foot?: ReactNode;
  className?: string;
  flat?: boolean;
  hover?: boolean;
}
export function Card({ title, sub, icon, actions, children, foot, className, flat, hover }: CardProps) {
  return (
    <section className={["card", flat && "card--flat", hover && "card--hover", className].filter(Boolean).join(" ")}>
      {title && (
        <header className="card__head">
          <div>
            <div className="card__title">{icon}{title}</div>
            {sub && <div className="card__sub" style={{ marginTop: 2 }}>{sub}</div>}
          </div>
          {actions && <div style={{ display: "flex", gap: "var(--sp-2)" }}>{actions}</div>}
        </header>
      )}
      {children && <div className="card__body">{children}</div>}
      {foot && <footer className="card__foot">{foot}</footer>}
    </section>
  );
}

export function SectionTitle({ children, hint, actions }: { children: ReactNode; hint?: ReactNode; actions?: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: "var(--sp-3)", marginBottom: "var(--sp-4)" }}>
      <div>
        <h3 className="section-title">{children}</h3>
        {hint && <p className="section-sub" style={{ marginBottom: 0 }}>{hint}</p>}
      </div>
      {actions}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Modal
 * ------------------------------------------------------------------------- */
interface ModalProps {
  open: boolean;
  onClose?: () => void;
  title?: ReactNode;
  sub?: ReactNode;
  size?: "sm" | "md" | "lg" | "full";
  children: ReactNode;
  foot?: ReactNode;
  closeOnBackdrop?: boolean;
}
export function Modal({ open, onClose, title, sub, size = "md", children, foot, closeOnBackdrop = true }: ModalProps) {
  useEffect(() => {
    if (!open || !onClose) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className={`modal modal--${size}`} onMouseDown={closeOnBackdrop && onClose ? onClose : undefined}>
      <div className="modal__panel" onMouseDown={(e) => e.stopPropagation()}>
        {(title || onClose) && (
          <header className="modal__head">
            <div>
              {title && <div className="modal__title">{title}</div>}
              {sub && <div className="modal__sub">{sub}</div>}
            </div>
            {onClose && <IconButton className="x" label="Close" onClick={onClose} children={<Icon name="x" size={18} />} />}
          </header>
        )}
        <div className="modal__body">{children}</div>
        {foot && <footer className="modal__foot">{foot}</footer>}
      </div>
    </div>
  );
}

interface ConfirmProps {
  open: boolean;
  title?: ReactNode;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}
export function Confirm({ open, title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", destructive, onConfirm, onCancel }: ConfirmProps) {
  return (
    <Modal open={open} onClose={onCancel} size="sm" title={title}
      foot={<>
        <span className="spacer" />
        <Button onClick={onCancel}>{cancelLabel}</Button>
        <Button variant={destructive ? "danger" : "primary"} onClick={onConfirm}>{confirmLabel}</Button>
      </>}>
      <p className="dim" style={{ lineHeight: 1.6 }}>{message}</p>
    </Modal>
  );
}

/* ---------------------------------------------------------------------------
 * Toasts
 * ------------------------------------------------------------------------- */
export interface ToastItem {
  id: number;
  message: string;
  kind?: "info" | "error" | "ok";
}
export function Toasts({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={["toast", t.kind && `toast--${t.kind}`].filter(Boolean).join(" ")}>
          <span className="toast__ico">{t.kind === "error" ? "⚠" : t.kind === "ok" ? "✓" : "•"}</span>
          <span className="toast__msg">{t.message}</span>
          <IconButton size="sm" className="toast__x" label="Dismiss" onClick={() => onDismiss(t.id)} children={<Icon name="x" size={14} />} />
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Empty / Spinner / Tip
 * ------------------------------------------------------------------------- */
export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty__art">{icon}</div>}
      <div className="empty__title">{title}</div>
      {children && <div className="empty__text">{children}</div>}
      {action}
    </div>
  );
}

export function Spinner({ size = 18 }: { size?: number }) {
  return <span className="spin" style={{ width: size, height: size }} />;
}

export function Tip({ tip, children }: { tip: string; children: ReactNode }) {
  return <span data-tip={tip}>{children}</span>;
}

export function StatusDot({ state = "idle" }: { state?: "live" | "rec" | "idle" }) {
  return <span className={`dot dot--${state}`} />;
}

/* ---------------------------------------------------------------------------
 * Popover / ContextMenu — viewport-aware positioning
 * ------------------------------------------------------------------------- */
export function ContextMenu({
  x,
  y,
  onClose,
  children,
  className,
}: {
  x: number;
  y: number;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x;
    let top = y;
    // Flip horizontally if overflow right
    if (left + rect.width + margin > vw) left = Math.max(margin, vw - rect.width - margin);
    if (left < margin) left = margin;
    // Flip vertically if overflow bottom — try above cursor first
    if (top + rect.height + margin > vh) {
      const above = y - rect.height - 8;
      if (above >= margin) top = above;
      else top = Math.max(margin, vh - rect.height - margin);
    }
    if (top < margin) top = margin;
    setPos({ left, top });
  }, [x, y]);

  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      className={className ?? "editor-context"}
      style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 200 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Shard Select — replaces native <select> with styled popover
 * ------------------------------------------------------------------------- */
export interface SelectOption<T extends string> {
  value: T;
  label: string;
}
export function ShardSelect<T extends string>({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  className,
  style,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SelectOption<T>[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.max(rect.width, 180);
    let left = rect.left;
    if (left + width + margin > vw) left = Math.max(margin, vw - width - margin);
    const spaceBelow = vh - rect.bottom - margin;
    const spaceAbove = rect.top - margin;
    const wantBelow = Math.min(280, options.length * 36 + 8);
    let top: number;
    let maxHeight: number;
    if (spaceBelow >= Math.min(wantBelow, 200) || spaceBelow >= spaceAbove) {
      top = rect.bottom + 4;
      maxHeight = Math.min(wantBelow, spaceBelow);
    } else {
      maxHeight = Math.min(wantBelow, spaceAbove);
      top = rect.top - maxHeight - 4;
    }
    setPos({ left, top, width, maxHeight });
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("pointerdown", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const selected = options.find((o) => o.value === value);
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={["shard-select", className].filter(Boolean).join(" ")}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={style}
        onPointerDown={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
          if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="shard-select__value">{selected?.label ?? placeholder ?? "Select"}</span>
        <span className="shard-select__chev"><Icon name="chevron" size={14} /></span>
      </button>
      {open && pos && (
        <div
          role="listbox"
          className="shard-select__menu"
          style={{ position: "fixed", left: pos.left, top: pos.top, width: pos.width, maxHeight: pos.maxHeight, zIndex: 210 }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {options.map((o) => (
            <button
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className={["shard-select__option", o.value === value && "is-selected"].filter(Boolean).join(" ")}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
