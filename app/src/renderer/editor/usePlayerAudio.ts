import { useCallback, useEffect, useState } from "react";

interface PlayerAudio { volume: number; muted: boolean }

export function usePlayerAudio(player: "editor" | "preview") {
  const key = `shard:playerAudio:${player}`;
  const [audio, setAudio] = useState<PlayerAudio>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? "null");
      return {
        volume: typeof saved?.volume === "number" && Number.isFinite(saved.volume)
          ? Math.max(0, Math.min(1, saved.volume)) : 1,
        muted: saved?.muted === true,
      };
    } catch { return { volume: 1, muted: false }; }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(audio)); } catch {}
  }, [key, audio]);
  const setVolume = useCallback((volume: number) => {
    if (Number.isFinite(volume))
      setAudio(current => ({ ...current, volume: Math.max(0, Math.min(1, volume)) }));
  }, []);
  const setMuted = useCallback((muted: boolean) => setAudio(current => ({ ...current, muted })), []);
  return { ...audio, setVolume, setMuted };
}
