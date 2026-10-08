// Whether Recording priority actually works right now. An elevated core is
// not enough: only libobs reporting that it applied its GPU scheduling
// priority ("set") makes the feature active. Shared by the settings UI and
// the diagnostics bundle.
import type { PerfSample, PerfSession, RecordingPriorityStatus } from "./contracts";

export type RecordingPriorityState = "loading" | "unsupported" | "busy" | "off" | "active" | "inactive";

// Why an enabled Recording priority is not in effect.
export type RecordingPriorityProblem =
  | "not_installed" // no scheduled task for this Windows account
  | "task_stale" // task or protected runtime no longer matches this install
  | "core_not_elevated" // the running core started normally (fallback)
  | "gpu_priority_failed" // libobs tried; Windows/driver refused
  | "gpu_priority_unsupported" // libobs skips the D3D11 priority path (Intel GPUs)
  | "gpu_priority_unknown"; // elevated, but libobs never reported a result

export interface RecordingPriorityEffect {
  state: RecordingPriorityState;
  problem: RecordingPriorityProblem | null;
}

export function recordingPriorityEffect(status: RecordingPriorityStatus | null): RecordingPriorityEffect {
  if (!status) return { state: "loading", problem: null };
  if (!status.supported) return { state: "unsupported", problem: null };
  if (status.busy) return { state: "busy", problem: null };
  if (!status.enabled) return { state: "off", problem: null };
  if (status.coreElevated && status.gpuPriority === "set") return { state: "active", problem: null };
  // No running core has reported yet (starting or restarting): not active,
  // but nothing to explain unless the task itself is missing or stale.
  const reported = status.gpuVendor !== null;
  let problem: RecordingPriorityProblem | null;
  if (status.coreElevated) {
    // OBS's libobs-d3d11 deliberately skips the priority call on Intel GPUs.
    problem = status.gpuPriority === "failed" ? "gpu_priority_failed"
      : status.gpuVendor === "intel" ? "gpu_priority_unsupported"
      : "gpu_priority_unknown";
  } else {
    problem = !status.installed ? "not_installed" : !status.current ? "task_stale" : reported ? "core_not_elevated" : null;
  }
  return { state: "inactive", problem };
}

const PROBLEM_TEXT: Record<RecordingPriorityProblem, string> = {
  not_installed: "Recording priority isn't set up for this Windows account, so Shard is recording normally.",
  task_stale: "Recording priority needs to be set up again, so Shard is recording normally.",
  core_not_elevated: "The capture core started without administrator rights, so Shard is recording normally.",
  gpu_priority_failed: "Windows or your graphics driver didn't apply GPU priority, so recording runs at normal priority.",
  gpu_priority_unsupported: "Intel graphics don't support the GPU priority Shard uses, so recording runs at normal priority.",
  gpu_priority_unknown: "Your graphics driver didn't report GPU priority, so recording may run at normal priority.",
};

export function recordingPriorityProblemText(problem: RecordingPriorityProblem): string {
  return PROBLEM_TEXT[problem];
}

// One flat record in the diagnostics bundle answering "is Recording priority
// working, and if not, why", next to the capture facts it affects.
export function recordingPriorityDiagnostics(
  status: RecordingPriorityStatus,
  launchMode: "normal" | "priority",
  session: PerfSession | null,
  latest: PerfSample | null,
) {
  const { state, problem } = recordingPriorityEffect(status);
  const encoder = session?.encoders.replay ?? session?.encoders.recording ?? null;
  return {
    setting: status.enabled ? "enabled" : "disabled",
    effective: state,
    problem,
    problemText: problem ? recordingPriorityProblemText(problem) : null,
    lastMessage: status.message,
    task: { installed: status.installed, current: status.current },
    launchMode,
    coreElevated: session?.elevated ?? null,
    gpuPriority: session?.gpuPriority ?? "unknown",
    gpuVendor: session?.adapter.vendor ?? null,
    hags: session ? session.hags : null,
    processPriority: session?.processPriority ?? null,
    captureMethod: session?.capture.method ?? null,
    encoder: encoder?.encoder ?? null,
    zeroCopy: encoder?.zeroCopy ?? null,
    gpu3dPct: latest?.gpu.available ? latest.gpu.engine3d ?? null : null,
    videoEncodePct: latest?.gpu.available ? latest.gpu.videoEncode ?? null : null,
    backlogMs: latest?.backlogMs ?? null,
    lagCause: latest?.cause ?? null,
  };
}
