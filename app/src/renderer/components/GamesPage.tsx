import { useEffect, useState } from "react";
import type { GameInfo, Settings } from "../../shared/contracts";
import { Button, Card, EmptyState, Field, Icon, IconButton, Toggle } from "./ui";
import { ProcessPickerButton } from "./ProcessSelect";

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
}

const SOURCE_LABEL: Record<GameInfo["source"], string> = {
  discovered: "Detected",
  user: "Custom",
};


// Games page: live-qualified/user games, detection settings, and explicit
// executable overrides. Launcher product hints remain internal.
export function GamesPage({ settings, onChange }: Props) {
  const [games, setGames] = useState<GameInfo[]>([]);
  const [ignored, setIgnored] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [name, setName] = useState("");
  const [exes, setExes] = useState("");
  const [ignoreExe, setIgnoreExe] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const [g, ig] = await Promise.all([
      window.shard.invoke("game.listGames"),
      window.shard.invoke("game.listIgnored"),
    ]);
    setGames(g as GameInfo[]);
    setIgnored(ig as string[]);
  };
  useEffect(() => { refresh().catch(() => {}); }, []);

  const patch = (p: Partial<Settings["game"]>) => onChange({ ...settings, game: { ...settings.game, ...p } });

  const addGame = async () => {
    const exeList = exes.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!name.trim() || !exeList.length) return;
    setBusy(true);
    await window.shard.invoke("game.addUserGame", { name: name.trim(), executables: exeList });
    setName(""); setExes("");
    await refresh();
    setBusy(false);
  };

  const removeGame = async (id: string, source: GameInfo["source"]) => {
    const target = games.find((g) => g.id === id);
    await window.shard.invoke(source === "user" ? "game.removeUserGame" : "game.removeDiscovered", { id });
    if (target && target.executables && target.executables.length) {
      for (const exe of target.executables) {
        const normalized = exe.trim().toLowerCase();
        if (!normalized) continue;
        try { await window.shard.invoke("game.ignoreExe", { exe: normalized }); } catch {}
      }
    }
    await refresh();
  };


  const addIgnore = async () => {
    const exe = ignoreExe.trim().toLowerCase();
    if (!exe) return;
    await window.shard.invoke("game.ignoreExe", { exe });
    setIgnoreExe("");
    await refresh();
  };
  const removeIgnore = async (exe: string) => {
    await window.shard.invoke("game.unignoreExe", { exe });
    await refresh();
  };


  const q = search.trim().toLowerCase();
  const gamesForDisplay = games;
  const visible = gamesForDisplay.filter((g) => !q || g.name.toLowerCase().includes(q) || g.executables.some((e) => e.includes(q)));

  return (
    <div className="page games">
      <div className="page__head">
        <h2 className="page__title"><Icon name="box" size={18} /> Games</h2>
        <p className="dim page__sub">Shard qualifies games from live process, window, runtime, and launcher-product evidence, then tags clips with the active session.</p>
      </div>

      <Card title="Detection" icon={<Icon name="power" size={16} />}>
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


      <Card title="Games" icon={<Icon name="box" size={16} />}
        sub={`${gamesForDisplay.length} live-qualified or manually added game${gamesForDisplay.length === 1 ? "" : "s"}`}
        actions={
          <input className="input" placeholder="Search…" value={search}
            onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 160 }} />
        }>
        <div className="games__add">
          <input className="input" placeholder="Name, e.g. My Game" value={name}
            onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addGame()} style={{ flex: "1 1 180px" }} />
          <div style={{ display: "flex", gap: 8, flex: "2 1 280px", minWidth: 0 }}>
            <input className="input" placeholder="Exes, comma-separated: game.exe, launcher.exe" value={exes}
              onChange={(e) => setExes(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addGame()} style={{ flex: "1 1 auto", minWidth: 0 }} />
            <ProcessPickerButton
              label="Browse"
              onPick={(exe) => {
                const current = exes.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
                if (current.includes(exe.toLowerCase())) return;
                const next = current.length ? current.join(", ") + ", " + exe.toLowerCase() : exe.toLowerCase();
                setExes(next);
                if (!name.trim()) {
                  const base = exe.replace(/\.exe$/i, "");
                  setName(base.charAt(0).toUpperCase() + base.slice(1));
                }
              }}
            />
          </div>
          <Button variant="primary" icon={<Icon name="plus" size={15} />} disabled={!name.trim() || !exes.trim() || busy} onClick={addGame}>Add game</Button>
        </div>

        {visible.length === 0 ? (
          <EmptyState icon={<Icon name="box" size={26} />} title={search ? "No matches" : "No games yet"}>
            {search ? "Nothing matches that search." : "Add a game manually, or launch one and let live detection qualify it."}
          </EmptyState>
        ) : (
            <ul className="games__list games__list--scroll">
              {visible.map((g) => (
                <li key={g.id} className="games__row">
                  <Icon name="box" size={15} />
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
        )}
        <p className="dim page__note">
          Hover a long name or executable list for the full value. Removing a game forgets its learned mapping; it does
          not delete anything on disk. Detection settings save with the <strong>Save</strong> button in the top bar.
        </p>
      </Card>

      <Card title="Ignored executables" icon={<Icon name="x" size={16} />}
        sub="Processes that should never be treated as games">
        <div className="games__add">
          <div style={{ display: "flex", gap: 8, flex: "1 1 220px", minWidth: 0 }}>
            <input className="input" placeholder="exe, e.g. somehelper.exe" value={ignoreExe}
              onChange={(e) => setIgnoreExe(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addIgnore()} style={{ flex: "1 1 auto", minWidth: 0 }} />
            <ProcessPickerButton label="Browse" onPick={(exe) => setIgnoreExe(exe.toLowerCase())} />
          </div>
          <Button icon={<Icon name="plus" size={15} />} disabled={!ignoreExe.trim()} onClick={addIgnore}>Ignore</Button>
        </div>
        {ignored.length === 0 ? (
          <EmptyState icon={<Icon name="x" size={24} />} title="Nothing ignored">
            Add an executable here to exclude it from game detection (e.g. a utility that looks game-like).
          </EmptyState>
        ) : (
          <ul className="games__list games__list--scroll">
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
