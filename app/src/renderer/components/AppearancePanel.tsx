import { useEffect, useRef, useState } from "react";
import type { Settings } from "../../shared/contracts";
import type { ThemeMeta, ThemeValue } from "../../shared/themes";
import { Button, Card, Icon, ShardSelect, Toggle } from "./ui";
import { getAllThemes, getThemeState, getSelectedId, setTheme, reloadThemes, openThemesFolder, setThemeValues, THEME_CHANGE_EVENT, THEME_LIST_EVENT } from "../themeManager";

export function AppearancePanel({ settings, onChange }: { settings: Settings; onChange: (settings: Settings) => void }) {
  const [themes, setThemes] = useState<ThemeMeta[]>([]);
  const [state, setState] = useState(getThemeState);
  const [folder, setFolder] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    let live = true;
    let request = 0;
    const load = async () => {
      const current = ++request;
      try {
        const all = await getAllThemes();
        if (live && current === request) setThemes(all);
      } catch (error) { if (live) setError(String(error)); }
      finally { if (live) setLoading(false); }
    };
    const changed = () => setState({ ...getThemeState() });
    void load();
    void window.shard.getThemesDir().then(dir => { if (live) setFolder(dir); });
    window.addEventListener(THEME_LIST_EVENT, load);
    window.addEventListener(THEME_CHANGE_EVENT, changed);
    return () => { live = false; window.removeEventListener(THEME_LIST_EVENT, load); window.removeEventListener(THEME_CHANGE_EVENT, changed); };
  }, []);

  const run = async (action: () => Promise<unknown>) => {
    setError(""); setBusy(true);
    try { await action(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const select = (id: string) => run(async () => {
    const applied = await setTheme(id);
    onChange({ ...settingsRef.current, appearance: { ...settingsRef.current.appearance, theme: applied } });
  });
  const option = (key: string, value: ThemeValue) => {
    void setThemeValues({ ...getThemeState().theme.values, [key]: value }).catch(error => setError(String(error)));
  };
  const active = state.theme;
  const custom = themes.filter(theme => theme.kind === "custom");
  return <div className="stack" data-shard-component="theme-picker">
    <Card title="App theme" sub="Choose a theme, then save your changes.">
      <div className="theme-grid" aria-label="Built-in themes">
        {themes.filter(theme => theme.kind === "builtin").map(theme => <button key={theme.id} type="button"
          aria-pressed={active.meta.id === theme.id} className="theme-option" disabled={busy} onClick={() => void select(theme.id)}>
          <span className={"theme-option__preview theme-option__preview--" + theme.id} aria-hidden="true">
            <span className="theme-option__bar" /><span className="theme-option__sidebar" /><span className="theme-option__surface"><i /><i /><i /></span>
          </span>
          <span className="theme-option__label">{theme.name}{active.meta.id === theme.id && <Icon name="check" size={15} />}</span>
          <span className="theme-option__description">{theme.id === "oled" ? "Pure black surfaces" : theme.id === "midnight" ? "Deep navy, cool highlights" : "Charcoal with soft blue"}</span>
        </button>)}
      </div>
      {loading && <p className="field__hint">Loading themes…</p>}
    </Card>
    {(error || state.error) && <div className="theme-feedback" role="alert"><Icon name="bell" size={17} /><span>{error || state.error} Your previous theme stays available.</span></div>}
    <Card title="Custom themes" sub="Changes to theme files appear automatically."
      actions={<Button size="sm" disabled={busy} icon={<Icon name="refresh" size={14} />} onClick={() => void run(() => reloadThemes(getSelectedId()))}>Reload themes</Button>}>
      <div className="stack">{custom.map(theme => <button key={theme.id} type="button" className="theme-custom"
        disabled={busy || !!theme.error} aria-pressed={active.meta.id === theme.id} onClick={() => void select(theme.id)}>
        <span className="theme-custom__identity"><span className="setting-symbol"><Icon name="paintbrush" size={18} /></span><span>
          <strong>{theme.name}</strong><span className={theme.error ? "theme-custom__error" : "field__hint"}>{theme.error || theme.description || (theme.author ? `Created by ${theme.author}` : "Custom theme")}</span>
          {!theme.error && (theme.author || theme.version) && <span className="field__hint">{[theme.author, theme.version && `v${theme.version}`].filter(Boolean).join(" · ")}</span>}
        </span></span>{active.meta.id === theme.id && <Icon name="check" size={16} />}
      </button>)}</div>
      {!custom.length && <p className="field__hint">No custom themes installed.</p>}
      <div className="theme-folder"><Button icon={<Icon name="folder" size={15} />} onClick={() => void run(openThemesFolder)}>Open themes folder</Button>
        {folder && <span className="field__hint" title={folder}>{folder}</span>}
      </div>
      <details className="theme-help"><summary>Create a custom theme</summary>
        <p className="field__hint">Drop in a <code>.css</code> file, or add a folder with <code>theme.css</code>. An optional <code>theme.json</code> adds theme options and multiple stylesheets. See the theme authoring guide in <code>docs/THEMES.md</code>.</p>
        <p className="field__hint">Themes can load fonts and images from the internet. Only install themes you trust.</p>
      </details>
    </Card>
    {Object.keys(active.meta.settings ?? {}).length > 0 && <Card title={`${active.meta.name} options`} sub="Options apply and save automatically for this theme."
      actions={<Button size="sm" onClick={() => void run(() => setThemeValues({}))}>Reset options</Button>}>
      <div className="theme-options">{Object.entries(active.meta.settings ?? {}).map(([key, spec]) => <div className="theme-options__row" key={`${active.meta.id}:${key}`}>
        <div className="theme-options__copy"><label id={`theme-label-${key}`} htmlFor={`theme-option-${key}`}>{spec.name}</label>{spec.description && <p className="field__hint">{spec.description}</p>}</div>
        {spec.type === "boolean" && <Toggle id={`theme-option-${key}`} checked={active.values[key] === true} onChange={value => option(key, value)} />}
        {spec.type === "color" && <div className="theme-options__color"><span className="mono">{String(active.values[key])}</span><input type="color" id={`theme-option-${key}`} value={String(active.values[key])} onChange={event => option(key, event.target.value)} /></div>}
        {spec.type === "range" && <div className="theme-options__range"><input type="range" id={`theme-option-${key}`} min={spec.min} max={spec.max} step={spec.step} value={Number(active.values[key])} onChange={event => option(key, Number(event.target.value))} /><output htmlFor={`theme-option-${key}`} className="num">{active.values[key]}{spec.unit}</output></div>}
        {spec.type === "select" && <ShardSelect value={String(active.values[key])} options={spec.choices} onChange={value => option(key, value)} ariaLabel={spec.name} />}
      </div>)}</div>
    </Card>}
  </div>;
}
