import fs from "node:fs";
import path from "node:path";

const ASSETS_DIR =
  process.env.OPENCLAW_CONTROL_UI_ASSETS_DIR ||
  "/usr/local/lib/node_modules/openclaw/dist/control-ui/assets";

const INSTANCE_STORAGE_KEY = "openclaw.control.instance-id.v1";

function patchBundle(filePath) {
  let source;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    console.warn(`[control-ui-patch] failed to read ${filePath}: ${err.message}`);
    return false;
  }

  if (source.includes(INSTANCE_STORAGE_KEY)) {
    console.log(`[control-ui-patch] already patched: ${path.basename(filePath)}`);
    return false;
  }

  const target = /(clientName:"openclaw-control-ui",mode:"webchat",)(onHello:)/;
  if (!target.test(source)) {
    console.warn(
      `[control-ui-patch] pattern not found in ${path.basename(filePath)} (skipping)`,
    );
    return false;
  }

  const instanceExpr =
    'instanceId:(()=>{const e="openclaw.control.instance-id.v1";try{const t=localStorage.getItem(e);if(t&&t.trim())return t;const n=(globalThis.crypto&&typeof globalThis.crypto.randomUUID=="function"?globalThis.crypto.randomUUID():Math.random().toString(36).slice(2)+Date.now().toString(36));localStorage.setItem(e,n);return n}catch{return"openclaw-control-ui"}})(),';
  const patched = source.replace(target, `$1${instanceExpr}$2`);

  if (patched === source) {
    console.warn(
      `[control-ui-patch] no changes applied for ${path.basename(filePath)} (skipping)`,
    );
    return false;
  }

  fs.writeFileSync(filePath, patched, "utf8");
  console.log(`[control-ui-patch] patched ${path.basename(filePath)}`);
  return true;
}

function run() {
  let entries;
  try {
    entries = fs.readdirSync(ASSETS_DIR, { withFileTypes: true });
  } catch (err) {
    console.warn(`[control-ui-patch] assets directory not found: ${ASSETS_DIR}`);
    return;
  }

  const bundleFiles = entries
    .filter((entry) => entry.isFile() && /^index-.*\.js$/.test(entry.name))
    .map((entry) => path.join(ASSETS_DIR, entry.name));

  if (bundleFiles.length === 0) {
    console.warn(`[control-ui-patch] no control-ui bundles found in ${ASSETS_DIR}`);
    return;
  }

  let patchedCount = 0;
  for (const filePath of bundleFiles) {
    if (patchBundle(filePath)) {
      patchedCount += 1;
    }
  }
  console.log(`[control-ui-patch] finished (patched=${patchedCount}, total=${bundleFiles.length})`);
}

run();
