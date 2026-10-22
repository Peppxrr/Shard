import { useState, type CSSProperties } from "react";
import type { Settings } from "../../shared/contracts";
import { Button, Card, Icon, IconButton, Toggle } from "./ui";
import { SettingRow } from "./SettingControls";

export function ClipSoundSettings({ settings, onChange }: { settings: Settings; onChange: (settings: Settings) => void }) {
  const [error, setError] = useState("");
  const [choosing, setChoosing] = useState(false);
  const { clipSound: enabled, clipSoundPath: file = "", clipSoundVolume = 0.8 } = settings.app;
  const volume = Math.max(0, Math.min(1, clipSoundVolume));
  const patch = (next: Partial<Settings["app"]>) => onChange({ ...settings, app: { ...settings.app, ...next } });
  const choose = async () => {
    setChoosing(true); setError("");
    try {
      const picked = await window.shard.pickClipSound();
      if (picked) patch({ clipSoundPath: picked });
    } catch { setError("Could not open the sound picker. Please try again."); }
    finally { setChoosing(false); }
  };
  const preview = async () => {
    setError("");
    try { await window.shard.previewClipSound(file, volume); }
    catch { setError("Could not preview this sound. Choose another file and try again."); }
  };

  return <Card className="clip-sound" title="Clip saved sound" sub="A short cue when your clip is ready."
    actions={<label data-shard-slot="clip-sound-toggle" className="card__switch"><span className="sr">Play sound when a clip is saved</span><Toggle checked={enabled} onChange={(clipSound) => patch({ clipSound })} /></label>}>
    <div data-shard-component="clip-sound" data-shard-state={enabled ? "on" : "off"} className="clip-sound__body">
      <SettingRow title="Sound" description={file ? "Custom file · WAV, MP3, OGG, FLAC or M4A" : "Built-in · or choose a WAV, MP3, OGG, FLAC or M4A file"}>
        <div className="clip-sound__picker">
          <span className="clip-sound__file">
            <IconButton size="sm" className="clip-sound__play" label="Preview clip sound" title="Preview at selected volume" onClick={() => void preview()}><Icon name="play" size={14} /></IconButton>
            <span className="clip-sound__name" title={file || "Bundled clip sound"}>{file ? file.split(/[\\/]/).pop() : "Default sound"}</span>
            {file && <IconButton size="sm" label="Use default sound" onClick={() => { patch({ clipSoundPath: "" }); setError(""); }}><Icon name="undo" size={14} /></IconButton>}
          </span>
          <Button onClick={() => void choose()} loading={choosing} icon={<Icon name="folder" size={14} />}>Choose…</Button>
        </div>
      </SettingRow>
      <SettingRow title="Volume">
        <div className="source-volume clip-sound__volume"><Icon name="volume" size={15} /><input aria-label="Clip sound volume" type="range" className="slider" min={0} max={1} step={0.01} value={volume}
          style={{ "--range-progress": `${volume * 100}%` } as CSSProperties}
          onChange={(event) => patch({ clipSoundVolume: Number(event.target.value) })} onDoubleClick={() => patch({ clipSoundVolume: 1 })} title="Double-click to reset to 100%" /><output className="num">{Math.round(volume * 100)}%</output></div>
      </SettingRow>
      {error && <p role="alert" className="clip-sound__error">{error}</p>}
    </div>
  </Card>;
}
