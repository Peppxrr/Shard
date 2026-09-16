import { useState, type CSSProperties } from "react";
import type { Settings } from "../../shared/contracts";
import { Button, Card, Icon, Toggle } from "./ui";

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
    actions={<label className="clip-sound__enabled"><span>{enabled ? "On" : "Off"}</span><span className="sr">Play sound when a clip is saved</span><Toggle checked={enabled} onChange={(clipSound) => patch({ clipSound })} /></label>}>
    <div className="clip-sound__file">
      <button type="button" className="clip-sound__play" onClick={() => void preview()} aria-label="Preview clip sound" title="Preview at selected volume"><Icon name="play" size={18} /></button>
      <div className="clip-sound__name"><strong title={file || "Bundled clip sound"}>{file ? file.split(/[\\/]/).pop() : "Default sound"}</strong><span>{file ? "Custom sound" : "Built-in sound"}</span></div>
      <div className="clip-sound__file-actions">
        {file && <Button variant="ghost" size="sm" onClick={() => { patch({ clipSoundPath: "" }); setError(""); }}>Reset</Button>}
        <Button size="sm" onClick={() => void choose()} loading={choosing} icon={<Icon name="folder" size={14} />}>Choose file</Button>
      </div>
    </div>
    <div className="clip-sound__volume">
      <label htmlFor="clip-sound-volume">Volume</label>
      <div className="clip-sound__slider"><Icon name="volume" size={15} /><input id="clip-sound-volume" type="range" className="slider" min={0} max={1} step={0.01} value={volume}
        style={{ "--range-progress": `${volume * 100}%` } as CSSProperties}
        onChange={(event) => patch({ clipSoundVolume: Number(event.target.value) })} /><output htmlFor="clip-sound-volume" className="num">{Math.round(volume * 100)}%</output></div>
    </div>
    <p className="field__hint">{enabled ? "Preview to hear your selection. " : "Automatic sound is off. You can still preview your selection. "}WAV, MP3, OGG, FLAC, or M4A.</p>
    {error && <p role="alert" className="clip-sound__error">{error}</p>}
  </Card>;
}
