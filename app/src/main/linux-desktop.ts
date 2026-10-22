// linux-desktop.ts — Linux desktop integration written to the user's XDG
// config: the autostart entry, the opt-in OBS_VKCAPTURE session environment,
// and the KWin window rule that places the clip overlay (Wayland clients
// cannot position or raise their own windows).
import { app } from "electron";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function xdgConfigHome(): string {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
}

// Writes only when the content differs; removes the file when disabled.
async function syncConfigFile(file: string, content: string | null): Promise<void> {
  if (content === null) {
    await fs.rm(file, { force: true });
    return;
  }
  if (await fs.readFile(file, "utf8").catch(() => "") === content) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

// XDG autostart entry. An AppImage must start through its image file, not the
// temporary mount that process.execPath points into.
export async function applyLinuxAutostart(enabled: boolean): Promise<void> {
  const command = [process.env.APPIMAGE || process.execPath, ...(app.isPackaged ? [] : [app.getAppPath()])];
  // Desktop Entry Exec quoting, then the string-value escape of backslashes; % is a field code.
  const exec = command.map(arg => `"${arg.replace(/["`$\\]/g, "\\$&")}"`.replace(/\\/g, "\\\\").replace(/%/g, "%%")).join(" ");
  await syncConfigFile(path.join(xdgConfigHome(), "autostart", "shard.desktop"), enabled
    ? `[Desktop Entry]\nType=Application\nName=Shard\nExec=${exec}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`
    : null);
}

// systemd reads environment.d at login, so games launched from the next
// session load obs-vkcapture's Vulkan layer (installed per user by the core).
export async function applyVkcaptureEnvironment(enabled: boolean): Promise<void> {
  await syncConfigFile(path.join(xdgConfigHome(), "environment.d", "90-shard-vkcapture.conf"), enabled
    ? "# Written by Shard (Settings > Capture): game capture for Vulkan and Proton games.\nOBS_VKCAPTURE=1\n"
    : null);
}

export const OVERLAY_TITLE = "Shard clip overlay";
const OVERLAY_RULE = "shard-clip-overlay";
let overlayRulePosition: string | null = null; // position ensured during this run
let overlayRuleFailed = false;

export function isKdeSession(): boolean {
  return process.platform === "linux" && /(^|:)KDE(:|$)/i.test(process.env.XDG_CURRENT_DESKTOP ?? "");
}

// Keeps Shard's own rule in ~/.config/kwinrulesrc current: matched by the exact
// overlay title, an on-screen display (above fullscreen windows) at the given
// logical position, borderless, unfocusable and outside taskbar/pager/switcher.
// Other rules are never touched; KWin reloads only when something changed.
export async function ensureKdeOverlayRule(x: number, y: number): Promise<void> {
  const position = `${Math.round(x)},${Math.round(y)}`;
  if (overlayRuleFailed || overlayRulePosition === position) return;
  const desired: Record<string, string> = {
    Description: OVERLAY_TITLE, title: OVERLAY_TITLE, titlematch: "1",
    type: "16", typerule: "2", above: "true", aboverule: "2", position, positionrule: "2",
    noborder: "true", noborderrule: "2", skiptaskbar: "true", skiptaskbarrule: "2",
    skippager: "true", skippagerrule: "2", skipswitcher: "true", skipswitcherrule: "2",
    acceptfocus: "false", acceptfocusrule: "2",
  };
  const groups = parseKConfig(await fs.readFile(path.join(xdgConfigHome(), "kwinrulesrc"), "utf8").catch(() => ""));
  const rule = groups.get(OVERLAY_RULE) ?? {};
  const writes = Object.entries(desired).filter(([key, value]) => rule[key] !== value).map(([key, value]) => [OVERLAY_RULE, key, value]);
  const rules = (groups.get("General")?.rules ?? "").split(",").filter(Boolean);
  if (!rules.includes(OVERLAY_RULE)) {
    rules.push(OVERLAY_RULE);
    writes.push(["General", "rules", rules.join(",")], ["General", "count", String(rules.length)]);
  }
  try {
    for (const [group, key, value] of writes)
      await execFileAsync("kwriteconfig6", ["--file", "kwinrulesrc", "--group", group, "--key", key, value], { timeout: 5000 });
    if (writes.length)
      await execFileAsync("gdbus", ["call", "--session", "--dest", "org.kde.KWin", "--object-path", "/KWin", "--method", "org.kde.KWin.reconfigure"], { timeout: 5000 });
  } catch (error) {
    overlayRuleFailed = true; // kwriteconfig6/gdbus missing: keep Electron's own placement
    throw error;
  }
  overlayRulePosition = position;
}

// Plain [Group] / key=value reader; enough for comparing Shard's own values.
function parseKConfig(text: string): Map<string, Record<string, string>> {
  const groups = new Map<string, Record<string, string>>();
  let current: Record<string, string> | null = null;
  for (const line of text.split(/\r?\n/)) {
    const group = /^\[(.*)\]\s*$/.exec(line);
    if (group) {
      current = groups.get(group[1]) ?? {};
      groups.set(group[1], current);
    } else if (current) {
      const separator = line.indexOf("=");
      if (separator > 0) current[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
  }
  return groups;
}
