// Attach to the isolated Editor fixture when verifying pointer lifecycle bugs.
// Uses real rendered DOM/events; does not inspect React internals.
export function attachTimelineChecks(): void {
  const button = document.createElement("button");
  button.textContent = "Run timeline interaction checks";
  button.style.cssText = "position:fixed;top:0;left:40%;z-index:99999;padding:6px";
  document.body.append(button);
  button.onclick = async () => {
    button.disabled = true;
    const checks: string[] = [];
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); checks.push(message); };
    const host = document.querySelector<HTMLElement>(".timeline__scroll")!;
    const ruler = document.querySelector<HTMLElement>(".timeline__ruler")!;
    const video = document.querySelector("video")!;
    const event = (type: string, x: number, buttons = 1) => new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 987, pointerType: "mouse", isPrimary: true,
      button: 0, buttons, clientX: x, clientY: ruler.getBoundingClientRect().top + 10,
    });
    const dragActive = () => host.classList.contains("is-scrubbing");
    const rect = host.getBoundingClientRect();
    const x = rect.left + 164 + (host.clientWidth - 164) * 0.35;
    const y = rect.top + 10;
    try {
      video.pause();
      ruler.dispatchEvent(event("pointerdown", x));
      await frame();
      check(dragActive(), "surface starts scrubbing");
      window.dispatchEvent(event("pointercancel", x, 0));
      await frame();
      check(!dragActive(), "pointer cancel releases scrubbing without capture");
      ruler.dispatchEvent(event("pointerdown", x));
      await frame();
      host.dispatchEvent(event("lostpointercapture", x, 0));
      await frame();
      check(!dragActive(), "unexpected capture loss clears drag state");
      ruler.dispatchEvent(event("pointerdown", x));
      window.dispatchEvent(new Event("blur"));
      await frame();
      check(!dragActive(), "window blur releases scrubbing");
      host.dispatchEvent(event("pointerdown", x));
      await frame();
      check(!dragActive(), "native scrollbar area cannot start a seek");
      const mute = document.querySelector<HTMLButtonElement>(".timeline__audio-label button")!;
      mute.dispatchEvent(event("pointerdown", x));
      await frame();
      check(!dragActive(), "audio controls cannot start a seek");
      const sampleTime = () => (x - ruler.getBoundingClientRect().left) / ruler.getBoundingClientRect().width * video.duration;
      const beforeZoom = sampleTime();
      ruler.dispatchEvent(event("pointerdown", x));
      const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -180, clientX: x, clientY: y });
      ruler.dispatchEvent(wheel);
      await frame();
      check(wheel.defaultPrevented, "Ctrl-wheel prevents browser page zoom");
      check(!dragActive(), "zoom during a gesture clears the old drag");
      check(Math.abs(sampleTime() - beforeZoom) < 0.05, "Ctrl-wheel anchors the source time under the cursor");
      // Repeated zoom/fit/cancel/reseek exercises the intermittent stuck state.
      for (let index = 0; index < 8; index++) {
        ruler.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: index % 2 ? 200 : -200, clientX: x, clientY: y }));
        await frame();
        ruler.dispatchEvent(event("pointerdown", x + index * 2));
        window.dispatchEvent(event("pointermove", x + 80));
        window.dispatchEvent(event("pointerup", x + 80, 0));
        await frame();
        check(!dragActive(), `zoom/reseek cycle ${index + 1} ends cleanly`);
      }
      for (let index = 0; index < 15; index++) {
        ruler.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -240, clientX: x, clientY: y }));
        await frame();
      }
      const labels = [...ruler.querySelectorAll("b")].map((label) => label.textContent);
      check(new Set(labels).size === labels.length, "deep zoom labels never duplicate");
      check(labels.some((label) => label?.includes(".")), "deep zoom labels include fractional seconds");
      const updates: number[] = [];
      const observer = new MutationObserver(() => updates.push(performance.now()));
      observer.observe(document.querySelector(".timeline__playhead")!, { attributes: true, attributeFilter: ["style"] });
      await video.play();
      await new Promise((resolve) => setTimeout(resolve, 700));
      video.pause();
      observer.disconnect();
      check(updates.length >= 7, "playback playhead updates more than ten times per second");
      button.textContent = `PASS: ${checks.length} timeline interaction checks`;
      button.dataset.results = JSON.stringify(checks);
    } catch (error) {
      button.textContent = `FAIL: ${error instanceof Error ? error.message : error}`;
      button.dataset.results = JSON.stringify(checks);
    } finally {
      button.disabled = false;
    }
  };
}
