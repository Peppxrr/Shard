// Optional real-browser checks for the standalone clip viewer. Import only
// from an isolated UI fixture, open a clip, then use the checks button.
export function attachPlayerChecks(): void {
  const button = document.createElement("button");
  button.textContent = "Run player checks";
  button.style.cssText = "position:fixed;top:0;left:40%;z-index:99999;padding:6px";
  const output = document.createElement("output");
  output.id = "player-check-results";
  output.style.cssText = "position:fixed;top:34px;left:20%;z-index:99999;background:#10151c;color:white;padding:8px;max-width:70%;font:12px monospace";
  document.body.append(button, output);
  button.onclick = async () => {
    button.disabled = true;
    const checks: string[] = [];
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); checks.push(message); };
    const player = document.querySelector<HTMLElement>(".viewer-player");
    const video = player?.querySelector("video");
    const seek = player?.querySelector<HTMLInputElement>(".editor-player__seek");
    if (!player || !video || !seek) { output.textContent = "Open a clip viewer first."; button.disabled = false; return; }
    const originalLoop = video.loop;
    const positions = new Set<number>();
    let nativeUpdates = 0;
    const nativeUpdate = () => { nativeUpdates++; };
    const observer = new MutationObserver(() => positions.add(Number(seek.value)));
    const seekTo = async (time: number) => {
      video.currentTime = time;
      for (let i = 0; i < 100 && video.seeking; i++) await wait(20);
      await wait(80);
      check(!video.seeking, "media seek settles");
    };
    try {
      check(!video.controls && !player.querySelector(".editor-player__big-play"), "no native controls or circular overlay");
      check(video.duration > 2, "playable test clip loaded");
      video.pause();
      await seekTo(0.25);
      observer.observe(seek, { attributes: true });
      video.addEventListener("timeupdate", nativeUpdate);
      await video.play();
      await wait(1200);
      observer.disconnect();
      video.removeEventListener("timeupdate", nativeUpdate);
      video.pause();
      await wait(100);
      check(positions.size >= 12 && positions.size > nativeUpdates * 2, `smooth media clock: ${positions.size} positions / ${nativeUpdates} native events in 1.2 s`);
      check(Math.abs(Number(seek.value) - video.currentTime) < 0.08, "seek bar matches paused media time");
      const pausedTime = seek.value;
      await wait(250);
      check(seek.value === pausedTime, "paused seek bar stays still");
      await seekTo(1.625);
      check(Math.abs(Number(seek.value) - 1.625) < 0.005, "paused seek preserves fractional position");
      check(player.querySelector(".editor-player__time")!.textContent!.includes("0:01.625"), "time display preserves milliseconds");
      video.loop = true;
      await seekTo(video.duration - 0.2);
      await video.play();
      await wait(700);
      video.pause();
      await wait(100);
      check(video.currentTime < 1 && Math.abs(Number(seek.value) - video.currentTime) < 0.08, "loop updates seek bar from the media clock");
      video.loop = false;
      await seekTo(video.duration - 0.2);
      await video.play();
      await wait(700);
      check(video.ended && !!player.querySelector('[aria-label="Play (Space)"]'), "end of clip returns to the play control");
      check(Math.abs(Number(seek.value) - video.duration) < 0.01, "end time matches clip duration");
      output.textContent = `PASS: ${checks.join(" | ")}`;
    } catch (error) {
      output.textContent = `FAIL: ${String(error)}; passed: ${checks.join(" | ")}`;
    } finally {
      observer.disconnect();
      video.removeEventListener("timeupdate", nativeUpdate);
      video.pause();
      video.loop = originalLoop;
      button.disabled = false;
    }
  };
}
