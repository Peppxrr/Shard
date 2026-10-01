import type { SettingsSection } from "./SettingsPage";

export interface SettingsSearchResult {
  section: SettingsSection;
  title: string;
  keywords: string;
}

const SETTINGS_SEARCH: SettingsSearchResult[] = [
  { section: "appearance", title: "App theme", keywords: "appearance colors dark light built-in" },
  { section: "appearance", title: "Custom themes", keywords: "appearance themes folder import options" },
  { section: "capture", title: "Capture source", keywords: "mode auto desktop game only screen" },
  { section: "capture", title: "Display", keywords: "monitor screen desktop" },
  { section: "capture", title: "Duration", keywords: "replay history buffer seconds length" },
  { section: "capture", title: "Memory limit", keywords: "replay history buffer ram mb" },
  { section: "video", title: "Recording quality", keywords: "preset low medium high custom resolution width height bitrate mbps" },
  { section: "video", title: "Frame rate", keywords: "fps 30 60 120 motion" },
  { section: "video", title: "Encoder", keywords: "encoding compression gpu cpu h264 hevc av1 nvenc x264 preset" },
  { section: "export", title: "File size limit", keywords: "sharing defaults target mb size" },
  { section: "export", title: "Resolution", keywords: "sharing original source 1080p 720p 480p 360p" },
  { section: "export", title: "Encoder", keywords: "encoding sharing gpu cpu h264" },
  { section: "audio", title: "Recording audio", keywords: "desktop speakers microphone application device volume gain boost sources" },
  { section: "audio", title: "Clip saved sound", keywords: "notification cue preview volume custom file" },
  { section: "hotkeys", title: "Keyboard shortcuts", keywords: "key binding accelerator save clip length recording" },
  { section: "storage", title: "Clip location", keywords: "folder path directory change default" },
  { section: "storage", title: "Storage limit", keywords: "automatic cleanup space disk gb delete oldest favorites" },
  { section: "storage", title: "Include edited clips", keywords: "automatic cleanup editor exports delete" },
  { section: "storage", title: "Import", keywords: "medal folder library" },
  { section: "app", title: "Clip notifications", keywords: "notification style overlay windows off popup" },
  { section: "app", title: "Start with Windows", keywords: "startup sign in login" },
  { section: "app", title: "Keep running when closed", keywords: "background system tray minimize" },
  { section: "app", title: "Hardware acceleration", keywords: "performance gpu restart" },
  { section: "app", title: "Developer console", keywords: "advanced diagnostics logs troubleshooting" },
  { section: "app", title: "Updates", keywords: "version download install check update" },
];

export function searchSettings(query: string, shortcutLabels: string): SettingsSearchResult[] {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return SETTINGS_SEARCH.filter(result => {
    const text = `${result.section} ${result.title} ${result.keywords} ${result.section === "hotkeys" ? shortcutLabels : ""}`.toLocaleLowerCase();
    return terms.every(term => text.includes(term));
  });
}
