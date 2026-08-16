import { useEffect, useState } from "react";
import type { CustomFolderInfo, GameInfo, LauncherInfo, Settings } from "../../shared/contracts";
import { Button, Card, Checkbox, EmptyState, Field, Icon, IconButton, Toggle } from "./ui";

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
}

const SOURCE_LABEL: Record<GameInfo["source"], string> = {
  discovered: "Discovered",
  user: "Custom",
};

const LIST_PAGE = 10;

// Games page: game detection settings, launcher discovery, the layered game
// registry (discovered / custom), custom game folders, and ignored executables.
export function GamesPage({ settings, onChange }: Props) {
  const [games, setGames] = useState<GameInfo[]>([]);
  const [launchers, setLaunchers] = useState<LauncherInfo[]>([]);
  const [ignored, setIgnored] = useState<string[]>([]);
  const [folders, setFolders] = useState<CustomFolderInfo[]>([]);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState("");
  const [exes, setExes] = useState("");
  const [ignoreExe, setIgnoreExe] = useState("");
  const [folderName, setFolderName] = useState("");
  const [folderPath, setFolderPath] = useState("");
  const [folderEmulator, setFolderEmulator] = useState(false);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);

  const refresh = async () => {
    const [g, l, ig, f] = await Promise.all([
      window.clipforge.invoke("game.listGames"),
      window.clipforge.invoke("game.listLaunchers"),
      window.clipforge.invoke("game.listIgnored"),
      window.clipforge.invoke("game.listCustomFolders"),
    ]);
    setGames(g as GameInfo[]);
    setLaunchers(l as LauncherInfo[]);
    setIgnored(ig as string[]);
    setFolders(f as CustomFolderInfo[]);
    setExpanded(false);
  };
  useEffect(() => { refresh().catch(() => {}); }, []);

  const patch = (p: Partial<Settings["game"]>) => onChange({ ...settings, game: { ...settings.game, ...p } });

  const addGame = async () => {
    const exeList = exes.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!name.trim() || !exeList.length) return;
    setBusy(true);
    await window.clipforge.invoke("game.addUserGame", { name: name.trim(), executables: exeList });
    setName(""); setExes("");
    await refresh();
    setBusy(false);
  };

  const removeGame = async (id: string, source: GameInfo["source"]) => {
    await window.clipforge.invoke(source === "user" ? "game.removeUserGame" : "game.removeDiscovered", { id });
    await refresh();
  };

  const toggleLauncher = async (type: string, enabled: boolean) => {
    patch({ launchers: { ...settings.game.launchers, [type]: enabled } });
    await window.clipforge.invoke("game.setLauncherEnabled", { type, enabled });
    await refresh();
  };

  const rescan = async () => {
    setScanning(true);
    await window.clipforge.invoke("game.refreshDiscovery");
    await refresh();
    setScanning(false);
  };

  const addIgnore = async () => {
    const exe = ignoreExe.trim().toLowerCase();
    if (!exe) return;
    await window.clipforge.invoke("game.ignoreExe", { exe });
    setIgnoreExe("");
    await refresh();
  };
  const removeIgnore = async (exe: string) => {
    await window.clipforge.invoke("game.unignoreExe", { exe });
    await refresh();
  };

  const addFolder = async () => {
    if (!folderName.trim() || !folderPath.trim()) return;
    setBusy(true);
    await window.clipforge.invoke("game.addCustomFolder", {
      name: folderName.trim(),
      path: folderPath.trim(),
      emulator: folderEmulator,
    });
    setFolderName(""); setFolderPath(""); setFolderEmulator(false);
    await rescan();
    setBusy(false);
  };
  const removeFolder = async (id: string) => {
    await window.clipforge.invoke("game.removeCustomFolder", { id });
    await refresh();
  };

  const q = search.trim().toLowerCase();
  const visible = games.filter((g) => !q || g.name.toLowerCase().includes(q) || g.executables.some((e) => e.includes(q)));
  const shown = expanded ? visible : visible.slice(0, LIST_PAGE);
  const hidden = visible.length - shown.length;

  return (
    <div className="page games">
      <div className="page__head">
        <h2 className="page__title"><Icon name="games" size={18} /> Games</h2>
        <p className="dim page__sub">Shard detects games from running processes (never the focused window) and tags clips with the active game session.</p>
      </div>

      <Card title="Detection" icon={<Icon name="search" size={16} />}>
        <div className="games__toggles">
          <label className="games__toggle">
            <Toggle checked={settings.game.autoRecord} onChange={(v) => patch({ autoRecord: v })} />
            <div>
              <div className="games__toggle-label">Auto-record while a game is running</div>
              <div className="dim">Starts recording when a game session starts and stops after the grace period once the game closes — even if you alt-tab or minimize.</div>
            </div>
          </label>
          <label className="games__toggle">
            <Toggle checked={settings.game.verboseDetection} onChange={(v) => patch({ verboseDetection: v })} />
            <div>
              <div className="games__toggle-label">Verbose detection logging</div>
              <div className="dim">Logs every scoring decision (reasons, deltas, verdict) to the core console — useful for debugging "why was that detected?".</div>
            </div>
          </label>
          <Field label="Grace after game closes (seconds)" hint="Keeps recording for this many seconds after the game exits, so you don't lose the tail.">
            <input className="input" type="number" min={0} max={300} value={settings.game.graceSeconds}
              onChange={(e) => patch({ graceSeconds: Number(e.target.value) })}
              style={{ maxWidth: 120 }} />
          </Field>
        </div>
      </Card>

      <Card title="Launcher discovery" icon={<Icon name="folderOpen" size={16} />}
        sub="Installed games are discovered from launcher metadata — no disk-wide scans"
        actions={
          <Button size="sm" icon={<Icon name="refresh" size={14} />} loading={scanning} onClick={rescan}>Rescan now</Button>
        }>
        <div className="games__launchers">
          {launchers.map((l) => (
            <div key={l.type} className="games__launcher">
              <Toggle checked={settings.game.launchers[l.type] ?? l.enabled}
                onChange={(v) => toggleLauncher(l.type, v)} />
              <div className="games__launcher-name">
                <span>{l.label}</span>
                <span className="dim mono">{l.installed ? `${l.gameCount} game${l.gameCount === 1 ? "" : "s"}` : "not installed"}</span>
              </div>
            </div>
          ))}
        </div>
        <p className="dim page__note">
          Discovery runs at startup and hourly; “Rescan now” refreshes immediately. Launcher toggles are saved with the
          <strong> Save</strong> button in the top bar.
        </p>
      </Card>

      <Card title="Game folders" icon={<Icon name="folder" size={16} />}
        sub="Point Shard at a folder of games — itch.io indie installs, emulator libraries (Cemu, Dolphin, …), anything launcherless">
        <div className="games__add">
          <input className="input" placeholder="Name, e.g. My Emulators" value={folderName}
            onChange={(e) => setFolderName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addFolder()} style={{ flex: "1 1 160px" }} />
          <input className="input" placeholder="Folder path, e.g. C:\\Emulators" value={folderPath}
            onChange={(e) => setFolderPath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addFolder()} style={{ flex: "2 1 260px" }} />
          <label className="games__toggle" title="Emulators open a separate game window; Shard captures that window instead of the emulator UI.">
            <Checkbox checked={folderEmulator} onChange={setFolderEmulator} label="Emulator folder" />
          </label>
          <Button variant="primary" icon={<Icon name="plus" size={15} />} disabled={!folderName.trim() || !folderPath.trim() || busy} onClick={addFolder}>Add folder</Button>
        </div>
        {folders.length === 0 ? (
          <EmptyState icon={<Icon name="folder" size={24} />} title="No game folders yet">
            Add a folder of games and Shard will discover each executable as a game. Mark emulator folders so captures follow the actual game window.
          </EmptyState>
        ) : (
          <ul className="games__list">
            {folders.map((f) => (
              <li key={f.id} className="games__row">
                <Icon name="folder" size={15} />
                <span className="games__name" title={f.name}>{f.name}</span>
                {f.emulator && <span className="games__source games__source--user">emulator</span>}
                <span className="games__exe mono" title={f.path}>{f.path}</span>
                <IconButton size="sm" label="Remove folder" variant="danger" onClick={() => removeFolder(f.id)}>
                  <Icon name="trash" size={14} />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Games" icon={<Icon name="gamepad" size={16} />}
        sub={`${games.length} game${games.length === 1 ? "" : "s"} known (discovered from launchers and custom)`}
        actions={
          <input className="input" placeholder="Search…" value={search}
            onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 160 }} />
        }>
        <div className="games__add">
          <input className="input" placeholder="Name, e.g. My Game" value={name}
            onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addGame()} style={{ flex: "1 1 180px" }} />
          <input className="input" placeholder="Exes, comma-separated: game.exe, launcher.exe" value={exes}
            onChange={(e) => setExes(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addGame()} style={{ flex: "2 1 280px" }} />
          <Button variant="primary" icon={<Icon name="plus" size={15} />} disabled={!name.trim() || !exes.trim() || busy} onClick={addGame}>Add game</Button>
        </div>

        {shown.length === 0 ? (
          <EmptyState icon={<Icon name="gamepad" size={26} />} title={search ? "No matches" : "No games yet"}>
            {search ? "Nothing matches that search." : "Add a game by name and executable, or let discovery find your library."}
          </EmptyState>
        ) : (
          <>
            <ul className="games__list games__list--scroll">
              {shown.map((g) => (
                <li key={g.id} className="games__row">
                  <Icon name="gamepad" size={15} />
                  <span className="games__name" title={g.name}>{g.name}</span>
                  <span className={`games__source games__source--${g.source}`}>{SOURCE_LABEL[g.source]}</span>
                  {g.emulator && <span className="games__source games__source--user">emulator</span>}
                  <span className="games__exe mono" title={g.executables.join(", ")}>{g.executables.join(", ")}</span>
                  {(g.source === "user" || g.source === "discovered") && (
                    <IconButton size="sm" label="Remove game" variant="danger" onClick={() => removeGame(g.id, g.source)}>
                      <Icon name="trash" size={14} />
                    </IconButton>
                  )}
                </li>
              ))}
            </ul>
            {hidden > 0 && (
              <Button size="sm" variant="soft" block className="games__expand"
                onClick={() => setExpanded(true)}>
                Show all {visible.length} games ({hidden} more)
              </Button>
            )}
            {expanded && hidden === 0 && visible.length > LIST_PAGE && (
              <Button size="sm" variant="soft" block className="games__expand"
                onClick={() => setExpanded(false)}>
                Show fewer
              </Button>
            )}
          </>
        )}
        <p className="dim page__note">
          Hover a long name or executable list for the full value. Removing a custom or discovered game only forgets it —
          it does not delete anything on disk. Detection settings save with the <strong>Save</strong> button in the top bar.
        </p>
      </Card>

      <Card title="Ignored executables" icon={<Icon name="x" size={16} />}
        sub="Processes that should never be treated as games">
        <div className="games__add">
          <input className="input" placeholder="exe, e.g. somehelper.exe" value={ignoreExe}
            onChange={(e) => setIgnoreExe(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addIgnore()} style={{ flex: "1 1 220px" }} />
          <Button size="sm" icon={<Icon name="plus" size={14} />} disabled={!ignoreExe.trim()} onClick={addIgnore}>Ignore</Button>
        </div>
        {ignored.length === 0 ? (
          <EmptyState icon={<Icon name="x" size={24} />} title="Nothing ignored">
            Add an executable here to exclude it from game detection (e.g. a utility that looks game-like).
          </EmptyState>
        ) : (
          <ul className="games__list">
            {ignored.map((exe) => (
              <li key={exe} className="games__row">
                <Icon name="x" size={14} />
                <span className="games__exe mono">{exe}</span>
                <IconButton size="sm" label="Unignore" onClick={() => removeIgnore(exe)}>
                  <Icon name="check" size={14} />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
