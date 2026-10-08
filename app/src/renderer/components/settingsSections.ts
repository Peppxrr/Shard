// Settings navigation shared by the app shell and the lazily loaded Settings page.
export const SETTINGS_SECTIONS = [
  { id: "appearance", label: "Appearance", icon: "paintbrush" },
  { id: "capture", label: "Capture", icon: "video" },
  { id: "video", label: "Video", icon: "monitor" },
  { id: "export", label: "Export", icon: "export" },
  { id: "audio", label: "Audio", icon: "volume" },
  { id: "hotkeys", label: "Hotkeys", icon: "key" },
  { id: "storage", label: "Storage", icon: "hardDrive" },
  { id: "app", label: "App", icon: "power" },
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];

export function getSavedSettingsSection(): SettingsSection {
  try {
    const saved = localStorage.getItem("shard:settingsTab");
    if (saved && (SETTINGS_SECTIONS as readonly { id: string }[]).some((section) => section.id === saved)) return saved as SettingsSection;
  } catch {}
  return "appearance";
}
