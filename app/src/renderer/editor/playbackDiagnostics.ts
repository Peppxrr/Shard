// On-demand measurement only: no polling or frame callbacks during normal playback.
export function measurePlayback(video: HTMLVideoElement, signal: AbortSignal): Promise<object> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const startTime = video.currentTime;
    const startQuality = video.getVideoPlaybackQuality();
    const intervals: number[] = [];
    const decodeTimes: number[] = [];
    let lastFrame = 0;
    let frame = 0;
    let waiting = 0;
    let seeks = 0;
    let pauses = 0;
    let callbackCount = 0;
    let longTasks = 0;
    let longestTaskMs = 0;
    let observer: PerformanceObserver | null = null;
    let hidden = document.hidden;
    const onWaiting = () => waiting++;
    const onSeeking = () => seeks++;
    const onPause = () => pauses++;
    const onVisibility = () => { hidden ||= document.hidden; };
    const onFrame: VideoFrameRequestCallback = (_now, metadata) => {
      callbackCount++;
      if (lastFrame) intervals.push(metadata.expectedDisplayTime - lastFrame);
      lastFrame = metadata.expectedDisplayTime;
      if (typeof metadata.processingDuration === "number" && Number.isFinite(metadata.processingDuration)) {
        decodeTimes.push(metadata.processingDuration * 1000);
      }
      frame = video.requestVideoFrameCallback(onFrame);
    };
    const cleanup = () => {
      clearTimeout(timer);
      if (frame) video.cancelVideoFrameCallback(frame);
      observer?.disconnect();
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("pause", onPause);
      document.removeEventListener("visibilitychange", onVisibility);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => { cleanup(); reject(new Error("Playback measurement cancelled.")); };
    const timer = window.setTimeout(() => {
      cleanup();
      const seconds = (performance.now() - started) / 1000;
      const quality = video.getVideoPlaybackQuality();
      const total = Math.max(0, quality.totalVideoFrames - startQuality.totalVideoFrames);
      const dropped = Math.max(0, quality.droppedVideoFrames - startQuality.droppedVideoFrames);
      const percentile = (values: number[], fraction: number) => {
        if (!values.length) return null;
        values.sort((a, b) => a - b);
        return Number(values[Math.min(values.length - 1, Math.floor(values.length * fraction))].toFixed(2));
      };
      resolve({
        sampleSeconds: Number(seconds.toFixed(2)),
        video: { width: video.videoWidth, height: video.videoHeight, duration: video.duration, playbackRate: video.playbackRate },
        startTime, endTime: video.currentTime, paused: video.paused, ended: video.ended,
        totalFrames: total, droppedFrames: dropped,
        presentedFps: Number(((total - dropped) / seconds).toFixed(2)),
        droppedPercent: total ? Number((dropped / total * 100).toFixed(2)) : null,
        frameIntervalMedianMs: percentile(intervals, .5), frameIntervalP95Ms: percentile(intervals, .95),
        decoderProcessingP95Ms: percentile(decodeTimes, .95),
        frameCallbacks: callbackCount, mainThreadLongTasks: longTasks, longestMainThreadTaskMs: longestTaskMs,
        waitingEvents: waiting, seekingEvents: seeks, pauseEvents: pauses, windowHiddenDuringSample: hidden,
        readyState: video.readyState, networkState: video.networkState,
        note: "Measure while playing without seeking. Pauses, loops, hidden windows and clip endings affect FPS. Frame callbacks can be delayed by main-thread scheduling. Decoder processing time includes pipeline latency and is not a throughput benchmark.",
      });
    }, 5000);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("seeking", onSeeking);
    video.addEventListener("pause", onPause);
    document.addEventListener("visibilitychange", onVisibility);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
      observer = new PerformanceObserver((entries) => {
        for (const entry of entries.getEntries()) {
          longTasks++;
          longestTaskMs = Math.max(longestTaskMs, Math.round(entry.duration));
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
    }
    if (video.requestVideoFrameCallback) frame = video.requestVideoFrameCallback(onFrame);
  });
}
