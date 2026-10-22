// Shared game/app artwork: one cache for the Games page, statusbar and audio rows.
import { useEffect, useState, useSyncExternalStore } from "react";
import type { GameIconRequest, GameInfo, GameSessionInfo } from "../shared/contracts";

const gameIcons = new Map<string, string>();
const requested = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
const notify = () => { version++; for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

// Asks main only for games (or newly running paths) not asked about before.
export function loadGameIcons(games: GameInfo[], sessions: GameSessionInfo[]): void {
  const requests: GameIconRequest[] = games.map(game => ({ id: game.id, name: game.name, executables: game.executables, installPaths: game.installPaths,
    launchers: game.launchers, path: sessions.find(s => s.gameId === game.id && s.path)?.path || undefined }))
    .filter(request => !gameIcons.has(request.id) && !requested.has(`${request.id}:${request.path ?? ""}`));
  if (!requests.length) return;
  for (const request of requests) requested.add(`${request.id}:${request.path ?? ""}`);
  void window.shard.gameIcons(requests).then(found => {
    for (const [id, url] of Object.entries(found)) gameIcons.set(id, url);
    if (Object.keys(found).length) notify();
  }).catch(() => {});
}

export function useGameIcons(): ReadonlyMap<string, string> {
  useSyncExternalStore(subscribe, () => version);
  return gameIcons;
}

// Artwork for the game currently captured, looked up from the core's sessions.
export function useCapturedGameIcon(subject: { kind: string; name: string | null } | null): string | undefined {
  const icons = useGameIcons();
  const [gameId, setGameId] = useState<string | null>(null);
  const name = subject?.kind === "game" ? subject.name : null;
  useEffect(() => {
    setGameId(null);
    if (!name) return;
    let current = true;
    void Promise.all([window.shard.invoke("game.sessions"), window.shard.invoke("game.listGames")]).then(([s, g]) => {
      const sessions = s as GameSessionInfo[];
      const session = sessions.find(entry => entry.name === name) ?? sessions.find(entry => entry.primary);
      const game = (g as GameInfo[]).find(entry => entry.id === session?.gameId);
      if (!current || !game) return;
      setGameId(game.id);
      loadGameIcons([game], sessions);
    }).catch(() => {});
    return () => { current = false; };
  }, [name]);
  return gameId ? icons.get(gameId) : undefined;
}

const appIcons = new Map<string, string>();
// Icons for App audio executables; apps not running yet are asked about again later.
export function useAppIcons(exes: string[]): ReadonlyMap<string, string> {
  useSyncExternalStore(subscribe, () => version);
  const key = [...new Set(exes.map(exe => exe.toLowerCase()).filter(Boolean))].sort().join("|");
  useEffect(() => {
    const missing = key ? key.split("|").filter(exe => !appIcons.has(exe)) : [];
    if (!missing.length) return;
    void window.shard.appIcons(missing).then(found => {
      for (const [exe, url] of Object.entries(found)) appIcons.set(exe, url);
      if (Object.keys(found).length) notify();
    }).catch(() => {});
  }, [key]);
  return appIcons;
}
