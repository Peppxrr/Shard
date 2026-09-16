import { useState } from "react";
import type { MonitorInfo, VideoEncoderInfo, VideoSettings } from "../../shared/contracts";
import { Card, Icon, Segmented, ShardSelect } from "./ui";

import { NumberControl } from "./SettingControls";

const QUALITY = [
  { id: "low", name: "Low", description: "Smaller files", detail: "Up to 720p · 4 Mbps" },
  { id: "medium", name: "Balanced", description: "Everyday capture", detail: "Native · 8 Mbps" },
  { id: "high", name: "High", description: "More detail", detail: "Native · 16 Mbps" },
  { id: "custom", name: "Custom", description: "Your settings", detail: "Set each value" },
] as const;

export function VideoSettingsPanel({ video, encoders, monitor, onChange }: {
  video: VideoSettings;
  encoders: VideoEncoderInfo[];
  monitor?: MonitorInfo;
  onChange: (video: VideoSettings) => void;
}) {
  const patch = (next: Partial<VideoSettings>) => onChange({ ...video, ...next });
  const custom = video.preset === "custom";
  const rate = video.preset === "low" ? 4 : video.preset === "high" ? 16 : 8;
  const encoder = encoders.find((item) => item.id === video.encoder);
  const frameRate = String(video.fps);
  const standardFps = ["30", "60", "120"].includes(frameRate);
  const [otherFps, setOtherFps] = useState(!standardFps);
  const selectQuality = (preset: VideoSettings["preset"]) => {
    patch({ preset, custom: preset === "custom",
      ...(preset === "custom" ? {
        bitrateKbps: video.bitrateKbps > 0 ? video.bitrateKbps : rate * 1000,
        width: video.width >= 320 ? video.width : monitor?.width ?? 1920,
        height: video.height >= 240 ? video.height : monitor?.height ?? 1080,
      } : {}),
    });
  };

  return <div className="stack video-settings">
    <Card title="Recording quality" sub="Choose a starting point for your clips.">
      <div className="quality-options" role="group" aria-label="Recording quality">
        {QUALITY.map((quality) => <button key={quality.id} type="button"
          className="quality-option" aria-pressed={video.preset === quality.id}
          onClick={() => selectQuality(quality.id)}>
          <span className="quality-option__name">{quality.name}<span className="quality-option__check" aria-hidden="true">{video.preset === quality.id && <Icon name="check" size={12} />}</span></span>
          <span className="quality-option__description">{quality.description}</span>
          <span className="quality-option__detail">{quality.detail}</span>
        </button>)}
      </div>
      {!custom && <p className="field__hint video-settings__note">
        {video.preset === "low" ? "Caps the capture at 720p and 30 FPS to keep files small."
          : "Keeps your display’s native resolution. Choose a frame rate below."}
      </p>}
      {custom && <div className="video-custom">
        <div className="video-setting">
          <div className="video-setting__copy"><h3>Resolution</h3><p>Width × height in pixels.</p></div>
          <div className="video-dimensions">
            <NumberControl label="Video width" value={video.width} min={320} max={8192} step={2} onChange={(width) => patch({ width })} />
            <span className="dim" aria-hidden="true">×</span>
            <NumberControl label="Video height" value={video.height} min={240} max={8192} step={2} onChange={(height) => patch({ height })} />
          </div>
        </div>
        <div className="video-setting">
          <div className="video-setting__copy"><h3>Bitrate</h3><p>Higher values preserve detail and use more storage.</p></div>
          <NumberControl label="Video bitrate in Mbps" value={video.bitrateKbps / 1000} min={0.1} max={200} step={0.1} unit="Mbps" onChange={(value) => patch({ bitrateKbps: Math.round(value * 1000) })} />
        </div>
      </div>}
      <div className="video-setting video-setting--rule">
        <div className="video-setting__copy"><h3>Frame rate</h3><p>{video.preset === "low" ? "Low quality limits output to 30 FPS." : "Match the motion you want to capture."}</p></div>
        {video.preset === "low" ? <span className="video-setting__value num">Up to {Math.min(30, video.fps)} FPS</span> : <div className="video-frame-rate">
          <Segmented value={otherFps || !standardFps ? "other" : frameRate}
            onChange={(value) => { setOtherFps(value === "other"); if (value !== "other") patch({ fps: Number(value) }); }}
            options={[{ value: "30", label: "30 FPS" }, { value: "60", label: "60 FPS" }, { value: "120", label: "120 FPS" }, { value: "other", label: "Other" }]} />
          {(otherFps || !standardFps) && <NumberControl label="Custom frame rate" value={video.fps} min={15} max={240} step={1} unit="FPS" onChange={(fps) => patch({ fps })} />}
        </div>}
      </div>
    </Card>
    <Card title="Encoding" sub="Choose how your video is compressed.">
      <div className="video-setting video-setting--encoder">
        <div className="video-setting__copy"><h3>Encoder</h3><p>{video.encoder === "auto" ? "Uses supported GPU H.264, with CPU fallback." : encoder ? `${encoder.hardware ? "Hardware accelerated" : "CPU encoding"} · ${encoder.codec.toUpperCase()}` : "Checking available encoders…"}</p></div>
        <ShardSelect value={video.encoder} onChange={(value) => patch({ encoder: value })}
          options={[{ value: "auto", label: "Automatic" }, ...encoders.map((item) => ({ value: item.id, label: item.label }))]} />
      </div>
      {video.encoder === "obs_x264" && <div className="video-setting video-setting--rule">
        <div className="video-setting__copy"><h3>CPU preset</h3><p>Slower presets trade processing time for compression.</p></div>
        <ShardSelect value={video.x264Preset} onChange={(x264Preset) => patch({ x264Preset })}
          options={["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow"].map((value) => ({ value, label: value }))} />
      </div>}
    </Card>
  </div>;
}
