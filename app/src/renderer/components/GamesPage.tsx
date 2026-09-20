import { useCallback, useEffect, useRef, useState } from "react";
import type { GameInfo, GameSessionInfo, Settings } from "../../shared/contracts";
import { Button, Card, EmptyState, Field, Icon, Modal, Segmented, StatusDot } from "./ui";
import { NumberControl, SettingRow, SwitchRow } from "./SettingControls";
import { ProcessPickerButton } from "./ProcessSelect";

type Props = { settings: Settings; onChange: (settings: Settings) => void };
type View = "games" | "excluded";
type Filter = "all" | "discovered" | "user";

export function GamesPage({ settings, onChange }: Props) {
  const [games, setGames] = useState<GameInfo[]>([]);
  const [ignored, setIgnored] = useState<string[]>([]);
  const [sessions, setSessions] = useState<GameSessionInfo[]>([]);
  const [view, setView] = useState<View>("games");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const [dialog, setDialog] = useState<"add" | "exclude" | null>(null);
  const [name, setName] = useState("");
  const [executables, setExecutables] = useState("");
  const [notice, setNotice] = useState("");
  const request = useRef(0);
  const mutating = useRef(false);
  const refresh = useCallback(async () => {
    const id = ++request.current;
    try {
      const [g, i, s] = await Promise.all([window.shard.invoke("game.listGames"), window.shard.invoke("game.listIgnored"), window.shard.invoke("game.sessions")]);
      if (id !== request.current) return;
      setGames(g as GameInfo[]); setIgnored(i as string[]); setSessions(s as GameSessionInfo[]); setError("");
    } catch { if (id === request.current) setError("Could not update games. Check the core connection and try again."); }
    finally { if (id === request.current) setLoading(false); }
  }, []);
  useEffect(() => {
    void refresh();
    const off = window.shard.onCoreEvent(type => { if (type === "ready" || type === "game.session" || type === "game.changed") void refresh(); });
    return () => { off(); ++request.current; };
  }, [refresh]);
  const patch = (next: Partial<Settings["game"]>) => onChange({ ...settings, game: { ...settings.game, ...next } });
  const run = async (work: () => Promise<void>, success: string) => {
    if (mutating.current) return;
    mutating.current = true; setBusy(true); setFormError(""); setNotice("");
    try { await work(); setDialog(null); await refresh(); setNotice(success); }
    catch (e) {
      await refresh();
      const message = e instanceof Error ? e.message : "Could not save this change. Please try again.";
      if (dialog) setFormError(message); else setError(message);
    } finally { mutating.current = false; setBusy(false); }
  };
  const invoke = async (method: "game.addUserGame" | "game.ignoreExe" | "game.unignoreExe" | "game.removeUserGame" | "game.removeDiscovered", params: Record<string, unknown>) => {
    if (await window.shard.invoke(method, params) === false) throw new Error("The change could not be applied. Refresh and try again.");
  };
  const submit = () => {
    const exes = [...new Set(executables.split(",").map(s => s.trim().toLowerCase()).filter(Boolean))];
    if (!exes.length || (dialog === "add" && !name.trim())) { setFormError("Enter a name and executable for the game."); return; }
    if (exes.some(exe => /[\\/:]/.test(exe) || !exe.endsWith(".exe"))) { setFormError("Use executable filenames, such as game.exe, without a folder path."); return; }
    void run(async () => {
      if (dialog === "add") {
        await invoke("game.addUserGame", { name: name.trim(), executables: exes });
        for (const exe of exes.filter(exe => ignored.includes(exe))) await invoke("game.unignoreExe", { exe });
      } else for (const exe of exes) await invoke("game.ignoreExe", { exe });
    }, dialog === "add" ? `${name.trim()} added to your games.` : "Executable excluded from detection.");
  };
  const excludeGame = (game: GameInfo) => void run(async () => {
    for (const exe of game.executables) await invoke("game.ignoreExe", { exe });
    await invoke(game.source === "user" ? "game.removeUserGame" : "game.removeDiscovered", { id: game.id });
  }, `${game.name} excluded. Restore its executable from Excluded apps to detect it again.`);
  const open = (next: "add" | "exclude") => { setName(""); setExecutables(""); setFormError(""); setDialog(next); };
  const q = query.trim().toLowerCase();
  const excluded = new Set(ignored.map(exe => exe.toLowerCase()));
  const registered = games.filter(g => !g.executables.length || !g.executables.every(exe => excluded.has(exe.toLowerCase())));
  const visible = registered.filter(g => (filter === "all" || g.source === filter) && (!q || g.name.toLowerCase().includes(q) || g.executables.some(exe => exe.toLowerCase().includes(q)))).sort((a, b) => a.name.localeCompare(b.name));
  const visibleIgnored = ignored.filter(exe => exe.toLowerCase().includes(q)).sort();
  const running = sessions.filter(s => !excluded.has(s.exe.toLowerCase()));

  return <div data-shard-page="games" className="page games">
    <header className="page__head games-heading"><div><h1 className="page__title">Games</h1><p className="dim page__sub">Your games, their capture status, and what stays out.</p></div><Button variant="primary" icon={<Icon name="plus" size={15} />} onClick={() => open("add")} disabled={busy}>Add game</Button></header>
    <section className="games-live" aria-label="Running games"><span className="setting-symbol"><Icon name="box" size={23} /></span><div className="games-live__copy"><span className="eyebrow">Running now</span><strong>{running.length ? `${running.length} game${running.length === 1 ? "" : "s"} detected` : "Waiting for a game"}</strong><p>{running.length ? "Sessions stay active when you switch to another app." : "Launch a game and it will appear here automatically."}</p></div>{running.length > 0 && <div className="games-live__sessions">{running.map(s => <span className="games-live__session" key={`${s.gameId}-${s.pid}`}><StatusDot state="live" /><span>{s.name}</span>{s.primary && <small>Primary</small>}</span>)}</div>}</section>
    {error && <div className="games-feedback" role="alert"><span>{error}</span><Button size="sm" onClick={() => void refresh()}>Try again</Button></div>}
    {notice && <p className="settings-note" role="status"><Icon name="check" size={14} />{notice}</p>}
    <Card className="games-library">
      <div data-shard-slot="toolbar" className="games-library__toolbar"><div className="games-tabs" role="group" aria-label="Game lists">{([{ id: "games", label: "Your games", count: registered.length }, { id: "excluded", label: "Excluded apps", count: ignored.length }] as const).map(tab => <button type="button" key={tab.id} aria-pressed={view === tab.id} onClick={() => { setView(tab.id); setQuery(""); }} disabled={busy}>{tab.label}<span className="num">{tab.count}</span></button>)}</div><label className="games-search"><Icon name="search" size={15} /><input type="search" aria-label={view === "games" ? "Search games" : "Search excluded apps"} placeholder={view === "games" ? "Search games" : "Search excluded apps"} value={query} onChange={e => setQuery(e.target.value)} /></label></div>
      <div className="games-library__filters">{view === "games" ? <Segmented value={filter} onChange={setFilter} options={[{ value: "all", label: "All games" }, { value: "discovered", label: "Detected" }, { value: "user", label: "Added by you" }]} /> : <p>These executables are never automatically treated as games.</p>}<Button size="sm" variant="ghost" icon={<Icon name={view === "games" ? "refresh" : "plus"} size={14} />} disabled={busy} onClick={() => view === "games" ? void refresh() : open("exclude")}>{view === "games" ? "Refresh" : "Exclude app"}</Button></div>
      {loading ? <p className="games-loading" role="status">Loading games…</p> : view === "games" ? visible.length ? <ul className="games__list games-list">{visible.map(game => {
        const active = running.some(s => s.gameId === game.id || game.executables.includes(s.exe));
        return <li data-shard-component="game" data-running={!!active} className="games__row game-entry" key={game.id}><span className="game-entry__icon"><Icon name="box" size={20} /></span><div className="game-entry__identity"><strong title={game.name}>{game.name}</strong><span title={game.executables.join(", ")}>{game.executables.join(", ") || "No executable configured"}</span></div><span className="game-entry__origin">{game.source === "user" ? "Added by you" : "Detected"}</span>{active && <span className="game-entry__running"><StatusDot state="live" />Running</span>}<Button size="sm" variant="ghost" disabled={busy} aria-label={`Exclude ${game.name}`} onClick={() => excludeGame(game)}>Exclude</Button></li>;
      })}</ul> : <EmptyState icon={<Icon name="box" size={28} />} title={q || filter !== "all" ? "No matching games" : "Your next game starts here"}>{q || filter !== "all" ? "Try another search or filter." : "Play a game to detect it automatically, or add its executable with Add game."}</EmptyState> : visibleIgnored.length ? <ul className="games__list games-list">{visibleIgnored.map(exe => <li data-shard-component="game" data-excluded="true" className="games__row game-entry" key={exe}><span className="game-entry__icon"><Icon name="x" size={18} /></span><div className="game-entry__identity"><strong>{exe}</strong><span>Excluded from automatic detection</span></div><Button size="sm" variant="ghost" disabled={busy} aria-label={`Restore ${exe}`} onClick={() => void run(() => invoke("game.unignoreExe", { exe }), `${exe} can be detected again.`)}>Restore</Button></li>)}</ul> : <EmptyState icon={<Icon name="check" size={26} />} title={q ? "No matching apps" : "Nothing excluded"}>{q ? "Try a different executable name." : "Exclude utilities here if you don’t want them treated as games."}</EmptyState>}
    </Card>
    <div className="games-options"><Card title="Automatic recording" sub="Record full sessions in addition to saving replay clips.">
      <SwitchRow title="Record game sessions" description="Start with the first game and stop after the last one closes." checked={settings.game.autoRecord} onChange={autoRecord => patch({ autoRecord })} />
      <SettingRow title="Stop delay" description="Extra recording time after the final game closes."><NumberControl label="Recording stop delay" value={settings.game.graceSeconds} min={0} max={300} unit="sec" onChange={graceSeconds => patch({ graceSeconds })} /></SettingRow>
    </Card><Card title="Game detection" sub="Only games that qualify live appear in your list."><p className="games-explainer">Games are recognized from their running processes and windows. Adding one manually creates an explicit match; excluding an app takes priority.</p><details className="detection-details"><summary>Diagnostics</summary><SwitchRow title="Detailed detection logs" description="Write detection decisions to the developer console." checked={settings.game.verboseDetection} onChange={verboseDetection => patch({ verboseDetection })} /></details></Card></div>
    <Modal open={dialog !== null} onClose={busy ? undefined : () => setDialog(null)} title={dialog === "add" ? "Add a game" : "Exclude an app"} sub={dialog === "add" ? "Create an explicit match for a game you play." : "Keep an executable out of automatic game detection."} size="sm" foot={<><Button disabled={busy} onClick={() => setDialog(null)}>Cancel</Button><Button variant="primary" type="submit" form="game-management-form" loading={busy} disabled={!executables.trim() || (dialog === "add" && !name.trim())}>{dialog === "add" ? "Add game" : "Exclude app"}</Button></>}>
      <form id="game-management-form" className="game-form" onSubmit={event => { event.preventDefault(); submit(); }}>{dialog === "add" && <Field label="Game name"><input className="input" aria-label="Game name" placeholder="e.g. VRChat" value={name} onChange={e => setName(e.target.value)} autoFocus /></Field>}<Field label="Executable" hint="Use executable filenames, separated by commas. For games, choose the game itself rather than its launcher."><div className="game-form__executable"><input className="input" aria-label="Executable" placeholder="game.exe" value={executables} onChange={e => setExecutables(e.target.value)} /><ProcessPickerButton label="Browse" onPick={exe => { const current = executables.split(",").map(s => s.trim().toLowerCase()).filter(Boolean); setExecutables([...new Set([...current, exe.toLowerCase()])].join(", ")); if (!name.trim()) setName(exe.replace(/\.exe$/i, "")); }} /></div></Field>{formError && <p role="alert" className="form-error">{formError}</p>}</form>
    </Modal>
  </div>;
}
