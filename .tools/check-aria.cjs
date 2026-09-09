const fs = require("fs");
const files = [
  "src/App.tsx",
  "src/features/video/VideoLink.tsx",
  "src/features/table/DataTable.tsx",
  "src/features/controls/ControlCanvas.tsx",
  "src/features/plot/Plot2D.tsx",
  "src/features/console/ConsolePanel.tsx",
  "src/features/ai/AiChat.tsx",
  "src/features/framecanvas/FrameCanvas.tsx",
  "src/features/hexview/HexView.tsx",
  "src/features/xray/XRayPanel.tsx",
  "src/features/settings/SettingsModal.tsx",
  "src/features/serial/SerialToolbar.tsx",
];
function findButtons(src) {
  const out = [];
  let i = 0;
  while ((i = src.indexOf("<button", i)) !== -1) {
    let depth = 0;
    let j = i + 7;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    const tag = src.slice(i, j + 1);
    if (/icon/.test(tag)) out.push({ idx: i, tag });
    i = j + 1;
  }
  return out;
}
let missing = 0;
for (const f of files) {
  if (!fs.existsSync(f)) continue;
  const src = fs.readFileSync(f, "utf8");
  for (const { idx, tag } of findButtons(src)) {
    if (!/title=/.test(tag) && !/aria-label=/.test(tag)) {
      const lineNo = src.slice(0, idx).split("\n").length;
      console.log(f + ":" + lineNo + "  " + tag.replace(/\s+/g, " ").slice(0, 120));
      missing++;
    }
  }
}
console.log("missing:", missing);
