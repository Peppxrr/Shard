// Development-only mathematical assertions for the editor timeline model
// (requirement 32). Run: node --experimental-strip-types scripts/editor-model-assertions.mjs
// Exits non-zero on the first failed invariant.
import {
  pixelsPerSecond,
  timeToPixel,
  pixelToTime,
  sourceToResultTime,
  resultToSourceTime,
  segmentAtTime,
  createEditorState,
  splitSegment,
  trimSegment,
  editedDuration,
} from "../src/renderer/editor/model.ts";

let failures = 0;
function check(name, actual, expected, tol = 1e-9) {
  const ok = Math.abs(actual - expected) <= tol;
  if (!ok) {
    failures++;
    console.error(`FAIL ${name}: got ${actual}, want ${expected} (tol ${tol})`);
  } else {
    console.log(`ok   ${name}`);
  }
}
function checkFlag(name, ok) {
  if (!ok) { failures++; console.error(`FAIL ${name}`); } else console.log(`ok   ${name}`);
}

// --- pixel/time round trip across zoom levels -------------------------------
for (const px of [10, 40.5, 96, 200, 640]) {
  for (const t of [0, 0.5, 1, 2.5, 7.25, 19.999]) {
    check(`roundtrip t=${t} px=${px}`, pixelToTime(timeToPixel(t, px), px), t, 1e-9);
  }
}

// --- source/result conversions ----------------------------------------------
// Clip: [0,5] kept, (5,8) deleted, [8,12] kept, (12,15) deleted, [15,20] kept.
const state = createEditorState(20, []);
state.segments = [
  { id: "a", sourceStart: 0, sourceEnd: 5, sourceMin: 0, sourceMax: 20 },
  { id: "b", sourceStart: 8, sourceEnd: 12, sourceMin: 0, sourceMax: 20 },
  { id: "c", sourceStart: 15, sourceEnd: 20, sourceMin: 0, sourceMax: 20 },
];
const segs = state.segments;

check("result at clip start", sourceToResultTime(segs, 0), 0);
check("result inside first segment", sourceToResultTime(segs, 2.5), 2.5);
check("result at end of first segment", sourceToResultTime(segs, 5), 5);
check("result inside gap clamps to prior result", sourceToResultTime(segs, 6.5), 5);
check("result at second segment start", sourceToResultTime(segs, 8), 5);
check("result inside second segment", sourceToResultTime(segs, 10), 7);
check("result inside second gap clamps", sourceToResultTime(segs, 13), 9);
check("result at third segment start", sourceToResultTime(segs, 15), 9);
check("result near clip end", sourceToResultTime(segs, 19.5), 13.5);

check("inverse at beginning", resultToSourceTime(segs, 0), 0);
check("inverse mid first", resultToSourceTime(segs, 2.5), 2.5);
check("inverse at boundary 5 -> earlier edge (end of a)", resultToSourceTime(segs, 5), 5);
check("inverse mid second", resultToSourceTime(segs, 7), 10);
check("inverse at third boundary -> earlier edge (end of b)", resultToSourceTime(segs, 9), 12);
check("inverse beyond end clamps to last end", resultToSourceTime(segs, 99), 20);

// Interior points round-trip exactly.
for (const t of [0, 1, 4.999, 9.3, 11.999, 17.77, 20]) {
  const back = resultToSourceTime(segs, sourceToResultTime(segs, t));
  check(`src->res->src interior t=${t}`, back, t, 1e-6);
}
// Boundary ambiguity is inherent: source 5 and source 8 share result 5;
// the inverse resolves to the earlier edge (documented in model.ts).
{
  const r = sourceToResultTime(segs, 8);
  check("src->res->src across boundary t=8 lands at earlier edge", resultToSourceTime(segs, r), 5, 1e-6);
}
{
  const r = sourceToResultTime(segs, 15);
  check("src->res->src across boundary t=15 lands at earlier edge", resultToSourceTime(segs, r), 12, 1e-6);
}

// segmentAtTime boundaries use epsilon tolerance.
checkFlag("segmentAtTime(8) -> b", segmentAtTime(segs, 8)?.id === "b");
checkFlag("segmentAtTime(gap 6.5) -> null", segmentAtTime(segs, 6.5) === null);

// split/trim invariants
const sumBefore = editedDuration(segs);
const splitState = splitSegment({ ...state, selectedSegmentId: "b" }, "b", 10);
checkFlag("split produced 4 segments", splitState.segments.length === 4);
const sumAfter = editedDuration(splitState.segments);
check("split preserves edited duration", sumAfter, sumBefore, 1e-9);

const trimmed = trimSegment(splitState, "b-L1", "end", 9); // left half was [8,10] -> [8,9]
{
  const nb = trimmed.segments.find((s) => s.id === "b-L1");
  checkFlag("trim end -> 9", nb && Math.abs(nb.sourceEnd - 9) < 1e-9);
  check("trim duration delta -1s", editedDuration(trimmed.segments), sumAfter - 1, 1e-9);
}

// zoom scaling sanity
check("pxPerSecond at fit", pixelsPerSecond(20, 800, 1), 40);
check("pxPerSecond at 16x", pixelsPerSecond(20, 800, 16), 640);

if (failures) {
  console.error(`\n${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log("\nAll editor-model assertions passed.");
