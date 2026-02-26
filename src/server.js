import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import express from "express";
import httpProxy from "http-proxy";
import pty from "node-pty";
import { WebSocketServer } from "ws";

const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const STATE_DIR =
  process.env.OPENCLAW_STATE_DIR?.trim() ||
  path.join(os.homedir(), ".openclaw");
const WORKSPACE_DIR =
  process.env.OPENCLAW_WORKSPACE_DIR?.trim() ||
  path.join(STATE_DIR, "workspace");

const SETUP_PASSWORD = process.env.SETUP_PASSWORD?.trim();

function resolveGatewayToken() {
  const envTok = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (envTok) return envTok;

  const tokenPath = path.join(STATE_DIR, "gateway.token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch (err) {
    console.warn(
      `[gateway-token] could not read existing token: ${err.code || err.message}`,
    );
  }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    console.warn(
      `[gateway-token] could not persist token: ${err.code || err.message}`,
    );
  }
  return generated;
}

const OPENCLAW_GATEWAY_TOKEN = resolveGatewayToken();
process.env.OPENCLAW_GATEWAY_TOKEN = OPENCLAW_GATEWAY_TOKEN;

let cachedOpenclawVersion = null;
let cachedChannelsHelp = null;

async function getOpenclawInfo() {
  if (!cachedOpenclawVersion) {
    const [version, channelsHelp] = await Promise.all([
      runCmd(OPENCLAW_NODE, clawArgs(["--version"])),
      runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"])),
    ]);
    cachedOpenclawVersion = version.output.trim();
    cachedChannelsHelp = channelsHelp.output;
  }
  return { version: cachedOpenclawVersion, channelsHelp: cachedChannelsHelp };
}

const INTERNAL_GATEWAY_PORT = Number.parseInt(
  process.env.INTERNAL_GATEWAY_PORT ?? "18789",
  10,
);
const INTERNAL_GATEWAY_HOST = process.env.INTERNAL_GATEWAY_HOST ?? "127.0.0.1";
const GATEWAY_TARGET = `http://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`;

const OPENCLAW_ENTRY =
  process.env.OPENCLAW_ENTRY?.trim() || "/openclaw/dist/entry.js";
const OPENCLAW_NODE = process.env.OPENCLAW_NODE?.trim() || "node";
const DISABLE_CONTROL_UI_DEVICE_AUTH =
  process.env.OPENCLAW_DISABLE_DEVICE_AUTH?.toLowerCase() === "true";

const ENABLE_WEB_TUI = process.env.ENABLE_WEB_TUI?.toLowerCase() === "true";
const TUI_IDLE_TIMEOUT_MS = Number.parseInt(
  process.env.TUI_IDLE_TIMEOUT_MS ?? "300000",
  10,
);
const TUI_MAX_SESSION_MS = Number.parseInt(
  process.env.TUI_MAX_SESSION_MS ?? "1800000",
  10,
);
const AUTOMATION_STATE_PATH = path.join(STATE_DIR, "proactive-automation.json");
const AUTOMATION_JOB_NAMES = {
  progress: "OpenClaw Progress Update",
  morning: "OpenClaw Morning Briefing",
};
const SUPPORTED_DELIVERY_CHANNELS = new Set([
  "telegram",
  "discord",
  "slack",
  "whatsapp",
  "signal",
  "googlechat",
  "mattermost",
  "imessage",
  "msteams",
]);
const DEFAULT_AUTOMATION_SETTINGS = {
  progressEnabled: true,
  progressEveryHours: 6,
  progressPrompt:
    "Review my active tasks and send a concise status update: done, in progress, blocked, and next actions.",
  morningEnabled: true,
  morningTime: "08:00",
  morningTimezone: "UTC",
  deliveryChannel: "",
  deliveryTarget: "",
};
const CONTROL_UI_ALLOWED_ORIGINS_ENV =
  process.env.OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS?.trim() || "";

function clawArgs(args) {
  return [OPENCLAW_ENTRY, ...args];
}

function configPath() {
  return (
    process.env.OPENCLAW_CONFIG_PATH?.trim() ||
    path.join(STATE_DIR, "openclaw.json")
  );
}

function isConfigured() {
  try {
    return fs.existsSync(configPath());
  } catch {
    return false;
  }
}

function firstHeaderValue(value) {
  if (Array.isArray(value)) return (value[0] || "").trim();
  if (typeof value === "string") return value.trim();
  return "";
}

function normalizeOrigin(value) {
  const input = String(value || "").trim();
  if (!input) return "";
  try {
    return new URL(input).origin;
  } catch {
    return "";
  }
}

function parseOriginList(value) {
  const origins = new Set();
  for (const part of String(value || "").split(/[,\s]+/)) {
    const origin = normalizeOrigin(part);
    if (origin) origins.add(origin);
  }
  return Array.from(origins);
}

function normalizeDomainHost(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
}

function configuredControlUiOrigins() {
  const origins = new Set(parseOriginList(CONTROL_UI_ALLOWED_ORIGINS_ENV));

  const publicUrlOrigin = normalizeOrigin(
    process.env.OPENCLAW_PUBLIC_URL || process.env.PUBLIC_URL || "",
  );
  if (publicUrlOrigin) origins.add(publicUrlOrigin);

  const railwayHost = normalizeDomainHost(process.env.RAILWAY_PUBLIC_DOMAIN);
  if (railwayHost) {
    origins.add(`https://${railwayHost}`);
    origins.add(`http://${railwayHost}`);
  }

  return Array.from(origins);
}

function inferRequestOrigin(req) {
  const explicitOrigin = normalizeOrigin(firstHeaderValue(req?.headers?.origin));
  if (explicitOrigin) return explicitOrigin;

  const xfProto = firstHeaderValue(req?.headers?.["x-forwarded-proto"])
    .split(",")[0]
    .trim();
  const xfHost = firstHeaderValue(req?.headers?.["x-forwarded-host"])
    .split(",")[0]
    .trim();
  const host = xfHost || firstHeaderValue(req?.headers?.host);

  const fallbackProto =
    typeof req?.protocol === "string" && req.protocol
      ? req.protocol
      : req?.socket?.encrypted
        ? "https"
        : "http";

  if (!host) return "";
  return normalizeOrigin(`${xfProto || fallbackProto}://${host}`);
}

function readConfiguredControlUiAllowedOrigins() {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw);
    const list = parsed?.gateway?.controlUi?.allowedOrigins;
    if (!Array.isArray(list)) return [];
    return list
      .map((item) => normalizeOrigin(item))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function buildDesiredControlUiAllowedOrigins(req) {
  const origins = new Set(readConfiguredControlUiAllowedOrigins());
  for (const item of configuredControlUiOrigins()) {
    origins.add(item);
  }

  const requestOrigin = inferRequestOrigin(req);
  if (requestOrigin) origins.add(requestOrigin);

  return Array.from(origins).sort();
}

let gatewayProc = null;
let gatewayStarting = null;
let gatewayHealthy = false;
let gatewayRecovery = null;
let lastGatewayRecoveryAt = 0;
let shuttingDown = false;
let controlUiOriginsSync = null;
const syncedControlUiOrigins = new Set();
const GATEWAY_RECOVERY_COOLDOWN_MS = 5000;

// FIX #2: Debounced origin sync — run at most once per 60s, not per-request.
let lastOriginSyncAt = 0;
const ORIGIN_SYNC_INTERVAL_MS = 60_000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isConnRefusedError(err) {
  return err?.code === "ECONNREFUSED" || err?.cause?.code === "ECONNREFUSED";
}

function requestGatewayRecovery(reason) {
  if (shuttingDown || !isConfigured()) return;
  if (gatewayRecovery) return;

  const now = Date.now();
  if (now - lastGatewayRecoveryAt < GATEWAY_RECOVERY_COOLDOWN_MS) return;
  lastGatewayRecoveryAt = now;

  gatewayRecovery = (async () => {
    try {
      console.warn(`[gateway] recovery requested: ${reason}`);
      gatewayHealthy = false;
      if (gatewayProc) {
        try {
          gatewayProc.kill("SIGTERM");
        } catch (err) {
          console.warn(`[gateway] recovery kill error: ${err.message}`);
        }
        await sleep(500);
        gatewayProc = null;
      }
      await ensureGatewayRunning();
      console.log("[gateway] recovery completed");
    } catch (err) {
      console.error(`[gateway] recovery failed: ${err.message}`);
    }
  })().finally(() => {
    gatewayRecovery = null;
  });
}

async function waitForGatewayReady(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const start = Date.now();
  const endpoints = ["/openclaw", "/", "/health"];

  while (Date.now() - start < timeoutMs) {
    for (const endpoint of endpoints) {
      try {
        const res = await fetch(`${GATEWAY_TARGET}${endpoint}`, {
          method: "GET",
        });
        if (res) {
          gatewayHealthy = true;
          console.log(`[gateway] ready at ${endpoint}`);
          return true;
        }
      } catch (err) {
        if (!isConnRefusedError(err)) {
          const msg = err.code || err.message;
          if (msg !== "fetch failed" && msg !== "UND_ERR_CONNECT_TIMEOUT") {
            console.warn(`[gateway] health check error: ${msg}`);
          }
        }
      }
    }
    await sleep(250);
  }
  gatewayHealthy = false;
  console.error(
    `[gateway] failed to become ready after ${timeoutMs / 1000} seconds`,
  );
  return false;
}

async function ensureControlUiAllowedOrigins(req, opts = {}) {
  if (!isConfigured()) {
    return { ok: false, skipped: true, updated: false, origins: [] };
  }

  const logPrefix = opts.logPrefix || "[gateway-config]";
  const desiredOrigins = buildDesiredControlUiAllowedOrigins(req);
  if (!desiredOrigins.length) {
    return { ok: true, skipped: true, updated: false, origins: [] };
  }

  if (syncedControlUiOrigins.size === 0) {
    for (const origin of readConfiguredControlUiAllowedOrigins()) {
      syncedControlUiOrigins.add(origin);
    }
  }

  const knownOrigins = Array.from(syncedControlUiOrigins).sort();
  const isAlreadySynced =
    knownOrigins.length === desiredOrigins.length &&
    knownOrigins.every((origin, index) => origin === desiredOrigins[index]);
  if (isAlreadySynced) {
    return {
      ok: true,
      skipped: true,
      updated: false,
      origins: desiredOrigins,
    };
  }

  if (controlUiOriginsSync) {
    const inFlight = await controlUiOriginsSync;
    return {
      ok: inFlight.ok,
      skipped: true,
      updated: false,
      origins: desiredOrigins,
    };
  }

  controlUiOriginsSync = (async () => {
    const result = await runCmd(
      OPENCLAW_NODE,
      clawArgs([
        "config",
        "set",
        "--json",
        "gateway.controlUi.allowedOrigins",
        JSON.stringify(desiredOrigins),
      ]),
    );

    if (result.code !== 0) {
      const text = trimOutputBlock(result.output, 500);
      console.warn(
        `${logPrefix} failed setting gateway.controlUi.allowedOrigins (exit ${result.code})${text ? `\n${text}` : ""}`,
      );
      return { ok: false, updated: false };
    }

    syncedControlUiOrigins.clear();
    for (const origin of desiredOrigins) {
      syncedControlUiOrigins.add(origin);
    }
    console.log(
      `${logPrefix} gateway.controlUi.allowedOrigins=${JSON.stringify(desiredOrigins)}`,
    );
    return { ok: true, updated: true };
  })().finally(() => {
    controlUiOriginsSync = null;
  });

  const synced = await controlUiOriginsSync;
  if (synced.ok && synced.updated && opts.restartGatewayOnChange && isGatewayReady()) {
    await restartGateway();
  }

  return {
    ok: synced.ok,
    skipped: false,
    updated: synced.updated,
    origins: desiredOrigins,
  };
}

// FIX #2: Debounced wrapper — only spawns child process if interval elapsed.
async function maybeEnsureControlUiAllowedOrigins(req, opts = {}) {
  const now = Date.now();
  if (now - lastOriginSyncAt < ORIGIN_SYNC_INTERVAL_MS) {
    return { ok: true, skipped: true, updated: false, origins: [] };
  }
  lastOriginSyncAt = now;
  return ensureControlUiAllowedOrigins(req, opts);
}

async function ensureGatewayConfig() {
  if (!isConfigured()) return;
  console.log("[gateway] enforcing critical config settings...");

  const results = await Promise.all([
    runCmd(
      OPENCLAW_NODE,
      clawArgs([
        "config",
        "set",
        "--json",
        "gateway.controlUi.allowInsecureAuth",
        "true",
      ]),
    ),
    runCmd(
      OPENCLAW_NODE,
      clawArgs(["config", "set", "gateway.auth.token", OPENCLAW_GATEWAY_TOKEN]),
    ),
    runCmd(
      OPENCLAW_NODE,
      clawArgs([
        "config",
        "set",
        "--json",
        "gateway.trustedProxies",
        '["127.0.0.1"]',
      ]),
    ),
  ]);

  for (const r of results) {
    if (r.code !== 0) {
      console.warn(`[gateway] config enforcement warning: ${r.output}`);
    }
  }

  await ensureControlUiAllowedOrigins(null, {
    logPrefix: "[gateway-config]",
    restartGatewayOnChange: false,
  });
}

async function startGateway() {
  if (gatewayProc) return;
  if (!isConfigured()) throw new Error("Gateway cannot start: not configured");
  gatewayHealthy = false;

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  await ensureGatewayConfig();

  for (const lockPath of [
    path.join(STATE_DIR, "gateway.lock"),
    "/tmp/openclaw-gateway.lock",
  ]) {
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {}
  }

  const args = [
    "gateway",
    "run",
    "--bind",
    "loopback",
    "--port",
    String(INTERNAL_GATEWAY_PORT),
    "--auth",
    "token",
    "--token",
    OPENCLAW_GATEWAY_TOKEN,
    "--allow-unconfigured",
  ];

  gatewayProc = childProcess.spawn(OPENCLAW_NODE, clawArgs(args), {
    stdio: "inherit",
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: STATE_DIR,
      OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
    },
  });

  const safeArgs = args.map((arg, i) =>
    args[i - 1] === "--token" ? "[REDACTED]" : arg
  );
  console.log(
    `[gateway] starting with command: ${OPENCLAW_NODE} ${clawArgs(safeArgs).join(" ")}`,
  );
  console.log(`[gateway] STATE_DIR: ${STATE_DIR}`);
  console.log(`[gateway] WORKSPACE_DIR: ${WORKSPACE_DIR}`);
  console.log(`[gateway] config path: ${configPath()}`);

  gatewayProc.on("error", (err) => {
    console.error(`[gateway] spawn error: ${String(err)}`);
    gatewayHealthy = false;
    gatewayProc = null;
  });

  // FIX #3: Gate auto-restart behind a flag so manual kill+restart doesn't race.
  gatewayProc.on("exit", (code, signal) => {
    console.error(`[gateway] exited code=${code} signal=${signal}`);
    gatewayHealthy = false;
    const wasManualRestart = gatewayProc?._manualRestart;
    gatewayProc = null;
    if (!shuttingDown && !wasManualRestart && isConfigured()) {
      console.log("[gateway] scheduling auto-restart in 2s...");
      setTimeout(() => {
        if (!shuttingDown && !gatewayProc && isConfigured()) {
          ensureGatewayRunning().catch((err) => {
            console.error(`[gateway] auto-restart failed: ${err.message}`);
          });
        }
      }, 2000);
    }
  });
}

async function ensureGatewayRunning() {
  if (!isConfigured()) return { ok: false, reason: "not configured" };
  if (gatewayProc && gatewayStarting === null && gatewayHealthy) {
    return { ok: true };
  }

  // FIX #3: Mark the process as manually restarted to prevent exit handler race.
  if (gatewayProc && gatewayStarting === null && !gatewayHealthy) {
    console.warn(
      "[gateway] process exists but is marked unhealthy, restarting gateway...",
    );
    try {
      gatewayProc._manualRestart = true;
      gatewayProc.kill("SIGTERM");
    } catch (err) {
      console.warn(`[gateway] restart kill error: ${err.message}`);
    }
    await sleep(500);
    gatewayProc = null;
  }

  if (!gatewayStarting) {
    gatewayStarting = (async () => {
      await startGateway();
      const ready = await waitForGatewayReady({ timeoutMs: 60_000 });
      if (!ready) {
        throw new Error("Gateway did not become ready in time");
      }
    })().finally(() => {
      gatewayStarting = null;
    });
  }
  await gatewayStarting;
  return { ok: true };
}

function isGatewayStarting() {
  return gatewayStarting !== null;
}

function isGatewayReady() {
  return gatewayProc !== null && gatewayStarting === null && gatewayHealthy;
}

async function restartGateway() {
  gatewayHealthy = false;
  if (gatewayProc) {
    try {
      // FIX #3: Prevent exit handler from scheduling a competing auto-restart.
      gatewayProc._manualRestart = true;
      gatewayProc.kill("SIGTERM");
    } catch (err) {
      console.warn(`[gateway] kill error: ${err.message}`);
    }
    await sleep(750);
    gatewayProc = null;
  }
  return ensureGatewayRunning();
}

const setupRateLimiter = {
  attempts: new Map(),
  windowMs: 60_000,
  maxAttempts: 50,
  cleanupInterval: setInterval(function () {
    const now = Date.now();
    for (const [ip, data] of setupRateLimiter.attempts) {
      if (now - data.windowStart > setupRateLimiter.windowMs) {
        setupRateLimiter.attempts.delete(ip);
      }
    }
  }, 60_000),

  isRateLimited(ip) {
    const now = Date.now();
    const data = this.attempts.get(ip);
    if (!data || now - data.windowStart > this.windowMs) {
      this.attempts.set(ip, { windowStart: now, count: 1 });
      return false;
    }
    data.count++;
    return data.count > this.maxAttempts;
  },
};

function requireSetupAuth(req, res, next) {
  if (!SETUP_PASSWORD) {
    return res
      .status(500)
      .type("text/plain")
      .send(
        "SETUP_PASSWORD is not set. Set it in Railway Variables before using /setup.",
      );
  }

  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (setupRateLimiter.isRateLimited(ip)) {
    return res.status(429).type("text/plain").send("Too many requests. Try again later.");
  }

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Auth required");
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  const passwordHash = crypto.createHash("sha256").update(password).digest();
  const expectedHash = crypto.createHash("sha256").update(SETUP_PASSWORD).digest();
  const isValid = crypto.timingSafeEqual(passwordHash, expectedHash);
  if (!isValid) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Invalid password");
  }
  return next();
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", async (_req, res) => {
  let gateway = "unconfigured";
  if (isConfigured()) {
    gateway = isGatewayReady() ? "ready" : "starting";
  }
  res.json({ ok: true, gateway });
});

app.get("/setup/healthz", async (_req, res) => {
  const configured = isConfigured();
  const gatewayRunning = isGatewayReady();
  const starting = isGatewayStarting();
  let gatewayReachable = false;

  if (gatewayRunning) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const r = await fetch(`${GATEWAY_TARGET}/`, { signal: controller.signal });
      clearTimeout(timeout);
      gatewayReachable = r !== null;
    } catch {}
  }

  res.json({
    ok: true,
    wrapper: true,
    configured,
    gatewayRunning,
    gatewayStarting: starting,
    gatewayReachable,
  });
});

app.get("/setup", requireSetupAuth, (_req, res) => {
  res.sendFile(path.join(process.cwd(), "src", "public", "setup.html"));
});

app.get("/setup/api/status", requireSetupAuth, async (_req, res) => {
  const { version, channelsHelp } = await getOpenclawInfo();

  const authGroups = [
    {
      value: "openai",
      label: "OpenAI",
      hint: "Codex OAuth + API key",
      options: [
        { value: "codex-cli", label: "OpenAI Codex OAuth (Codex CLI)" },
        { value: "openai-codex", label: "OpenAI Codex (ChatGPT OAuth)" },
        { value: "openai-api-key", label: "OpenAI API key" },
      ],
    },
    {
      value: "anthropic",
      label: "Anthropic",
      hint: "Claude Code CLI + API key",
      options: [
        { value: "claude-cli", label: "Anthropic token (Claude Code CLI)" },
        { value: "token", label: "Anthropic token (paste setup-token)" },
        { value: "apiKey", label: "Anthropic API key" },
      ],
    },
    {
      value: "google",
      label: "Google",
      hint: "Gemini API key + OAuth",
      options: [
        { value: "gemini-api-key", label: "Google Gemini API key" },
        { value: "google-antigravity", label: "Google Antigravity OAuth" },
        { value: "google-gemini-cli", label: "Google Gemini CLI OAuth" },
      ],
    },
    {
      value: "openrouter",
      label: "OpenRouter",
      hint: "API key",
      options: [{ value: "openrouter-api-key", label: "OpenRouter API key" }],
    },
    {
      value: "ollama",
      label: "Ollama",
      hint: "Local or self-hosted models",
      options: [
        { value: "ollama-local", label: "Ollama local runtime (no key needed)" },
      ],
    },
    {
      value: "ai-gateway",
      label: "Vercel AI Gateway",
      hint: "API key",
      options: [
        { value: "ai-gateway-api-key", label: "Vercel AI Gateway API key" },
      ],
    },
    {
      value: "moonshot",
      label: "Moonshot AI",
      hint: "Kimi K2 + Kimi Code",
      options: [
        { value: "moonshot-api-key", label: "Moonshot AI API key" },
        { value: "kimi-code-api-key", label: "Kimi Code API key" },
      ],
    },
    {
      value: "zai",
      label: "Z.AI (GLM 4.7)",
      hint: "API key",
      options: [{ value: "zai-api-key", label: "Z.AI (GLM 4.7) API key" }],
    },
    {
      value: "minimax",
      label: "MiniMax",
      hint: "M2.1 (recommended)",
      options: [
        { value: "minimax-api", label: "MiniMax M2.1" },
        { value: "minimax-api-lightning", label: "MiniMax M2.1 Lightning" },
      ],
    },
    {
      value: "qwen",
      label: "Qwen",
      hint: "OAuth",
      options: [{ value: "qwen-portal", label: "Qwen OAuth" }],
    },
    {
      value: "copilot",
      label: "Copilot",
      hint: "GitHub + local proxy",
      options: [
        {
          value: "github-copilot",
          label: "GitHub Copilot (GitHub device login)",
        },
        { value: "copilot-proxy", label: "Copilot Proxy (local)" },
      ],
    },
    {
      value: "synthetic",
      label: "Synthetic",
      hint: "Anthropic-compatible (multi-model)",
      options: [{ value: "synthetic-api-key", label: "Synthetic API key" }],
    },
    {
      value: "opencode-zen",
      label: "OpenCode Zen",
      hint: "API key",
      options: [
        { value: "opencode-zen", label: "OpenCode Zen (multi-model proxy)" },
      ],
    },
  ];

  res.json({
    configured: isConfigured(),
    gatewayTarget: GATEWAY_TARGET,
    openclawVersion: version,
    channelsAddHelp: channelsHelp,
    authGroups,
    tuiEnabled: ENABLE_WEB_TUI,
  });
});

app.get("/setup/api/automation/status", requireSetupAuth, async (_req, res) => {
  if (!isConfigured()) {
    return res.json({
      ok: true,
      configured: false,
      settings: DEFAULT_AUTOMATION_SETTINGS,
      jobs: {
        progress: { name: AUTOMATION_JOB_NAMES.progress, id: null, active: false },
        morning: { name: AUTOMATION_JOB_NAMES.morning, id: null, active: false },
      },
      deliveryChannels: Array.from(SUPPORTED_DELIVERY_CHANNELS),
      cronSupported: false,
      cronError: "OpenClaw is not configured yet",
    });
  }

  const persisted = readAutomationState();
  const settings = {
    ...DEFAULT_AUTOMATION_SETTINGS,
    ...(persisted?.settings || {}),
  };
  if (!isValidTimezone(settings.morningTimezone)) {
    settings.morningTimezone = DEFAULT_AUTOMATION_SETTINGS.morningTimezone;
  }

  const cronList = await listCronJobs();
  const jobs = {
    progress: {
      name: AUTOMATION_JOB_NAMES.progress,
      id: persisted?.jobs?.progressJobId ?? null,
      active: false,
    },
    morning: {
      name: AUTOMATION_JOB_NAMES.morning,
      id: persisted?.jobs?.morningJobId ?? null,
      active: false,
    },
  };

  if (cronList.ok) {
    const progress =
      cronList.jobs.find((job) => job.name === AUTOMATION_JOB_NAMES.progress) ||
      null;
    const morning =
      cronList.jobs.find((job) => job.name === AUTOMATION_JOB_NAMES.morning) ||
      null;

    if (progress) {
      jobs.progress.id = progress.id;
      jobs.progress.active = progress.enabled !== false;
    }
    if (morning) {
      jobs.morning.id = morning.id;
      jobs.morning.active = morning.enabled !== false;
    }
  }

  return res.json({
    ok: true,
    configured: true,
    settings,
    jobs,
    deliveryChannels: Array.from(SUPPORTED_DELIVERY_CHANNELS),
    cronSupported: cronList.ok,
    cronError: cronList.ok
      ? ""
      : [cronList.error, cronList.output].filter(Boolean).join("\n"),
  });
});

app.post("/setup/api/automation/configure", requireSetupAuth, async (req, res) => {
  if (!isConfigured()) {
    return res
      .status(400)
      .json({ ok: false, output: "Configure OpenClaw first, then set automations." });
  }

  const normalized = normalizeAutomationPayload(req.body || {});
  if (normalized.error) {
    return res.status(400).json({ ok: false, output: normalized.error });
  }

  try {
    const configured = await configureAutomations(normalized.value);
    const output = [
      "Automation settings saved.",
      "",
      configured.output || "(no additional output)",
    ]
      .filter(Boolean)
      .join("\n");

    return res.json({
      ok: true,
      settings: configured.state.settings,
      jobs: configured.state.jobs,
      cronSupported: configured.cronListOk,
      output,
    });
  } catch (err) {
    console.error("[/setup/api/automation/configure] error:", err);
    return res.status(500).json({
      ok: false,
      output: `Failed to configure automations: ${err.message || String(err)}`,
    });
  }
});

function buildOnboardArgs(payload) {
  const args = [
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--json",
    "--no-install-daemon",
    "--skip-health",
    "--workspace",
    WORKSPACE_DIR,
    "--gateway-bind",
    "loopback",
    "--gateway-port",
    String(INTERNAL_GATEWAY_PORT),
    "--gateway-auth",
    "token",
    "--gateway-token",
    OPENCLAW_GATEWAY_TOKEN,
    "--flow",
    payload.flow || "quickstart",
  ];

  if (payload.authChoice) {
    const onboardAuthChoice =
      payload.authChoice === "ollama-local" ? "skip" : payload.authChoice;
    args.push("--auth-choice", onboardAuthChoice);

    const secret = (payload.authSecret || "").trim();
    const map = {
      "openai-api-key": "--openai-api-key",
      apiKey: "--anthropic-api-key",
      "openrouter-api-key": "--openrouter-api-key",
      "ai-gateway-api-key": "--ai-gateway-api-key",
      "moonshot-api-key": "--moonshot-api-key",
      "kimi-code-api-key": "--kimi-code-api-key",
      "gemini-api-key": "--gemini-api-key",
      "zai-api-key": "--zai-api-key",
      "minimax-api": "--minimax-api-key",
      "minimax-api-lightning": "--minimax-api-key",
      "synthetic-api-key": "--synthetic-api-key",
      "opencode-zen": "--opencode-zen-api-key",
    };
    const flag = map[payload.authChoice];
    if (flag && secret) {
      args.push(flag, secret);
    }

    if (payload.authChoice === "token" && secret) {
      args.push("--token-provider", "anthropic", "--token", secret);
    }
  }

  return args;
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const proc = childProcess.spawn(cmd, args, {
      ...opts,
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: STATE_DIR,
        OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
      },
    });

    let out = "";
    proc.stdout?.on("data", (d) => (out += d.toString("utf8")));
    proc.stderr?.on("data", (d) => (out += d.toString("utf8")));

    proc.on("error", (err) => {
      out += `\n[spawn error] ${String(err)}\n`;
      resolve({ code: 127, output: out });
    });

    proc.on("close", (code) => resolve({ code: code ?? 0, output: out }));
  });
}

function readAutomationState() {
  try {
    const raw = fs.readFileSync(AUTOMATION_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeAutomationState(state) {
  try {
    fs.mkdirSync(path.dirname(AUTOMATION_STATE_PATH), { recursive: true });
    fs.writeFileSync(
      AUTOMATION_STATE_PATH,
      `${JSON.stringify(state, null, 2)}\n`,
      "utf8",
    );
  } catch (err) {
    console.warn(`[automation] failed to persist state: ${err.message}`);
  }
}

function parseLooseJson(output) {
  const text = String(output || "").trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {}

  const startCandidates = [text.indexOf("["), text.indexOf("{")].filter(
    (idx) => idx >= 0,
  );
  if (!startCandidates.length) return null;
  const start = Math.min(...startCandidates);
  const end = Math.max(text.lastIndexOf("]"), text.lastIndexOf("}"));
  if (end <= start) return null;

  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function extractCronJobs(payload) {
  const jobs = [];
  const seen = new Set();

  function walk(node, depth = 0) {
    if (depth > 8 || node == null) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node !== "object") return;

    const id =
      typeof node.jobId === "string"
        ? node.jobId
        : typeof node.id === "string"
          ? node.id
          : null;
    const name = typeof node.name === "string" ? node.name : null;
    if (id && name) {
      const key = `${id}::${name}`;
      if (!seen.has(key)) {
        seen.add(key);
        jobs.push({
          id,
          name,
          enabled: node.enabled !== false,
        });
      }
    }

    for (const value of Object.values(node)) {
      walk(value, depth + 1);
    }
  }

  walk(payload);
  return jobs;
}

function trimOutputBlock(output, maxChars = 1200) {
  const text = String(output || "").trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...(truncated ${text.length - maxChars} chars)`;
}

async function listCronJobs() {
  const result = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["cron", "list", "--all", "--json"]),
  );

  if (result.code !== 0) {
    return {
      ok: false,
      error: `cron list failed (exit ${result.code})`,
      output: trimOutputBlock(result.output),
      jobs: [],
    };
  }

  const parsed = parseLooseJson(result.output);
  if (!parsed) {
    return {
      ok: false,
      error: "cron list returned non-JSON output",
      output: trimOutputBlock(result.output),
      jobs: [],
    };
  }

  return { ok: true, jobs: extractCronJobs(parsed), output: "" };
}

function isValidTimezone(timezone) {
  if (typeof timezone !== "string" || !timezone.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone.trim() }).format(
      new Date(),
    );
    return true;
  } catch {
    return false;
  }
}

function normalizeAutomationPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return { error: "Invalid payload: expected JSON object" };
  }

  const progressEnabled = payload.progressEnabled !== false;
  const morningEnabled = payload.morningEnabled !== false;

  const progressEveryHours = Number.parseInt(
    String(
      payload.progressEveryHours ?? DEFAULT_AUTOMATION_SETTINGS.progressEveryHours,
    ),
    10,
  );
  if (
    progressEnabled &&
    (!Number.isInteger(progressEveryHours) ||
      progressEveryHours < 1 ||
      progressEveryHours > 24)
  ) {
    return { error: "progressEveryHours must be an integer between 1 and 24" };
  }

  const morningTime = String(
    payload.morningTime ?? DEFAULT_AUTOMATION_SETTINGS.morningTime,
  ).trim();
  const timeMatch = morningTime.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (morningEnabled && !timeMatch) {
    return { error: "morningTime must match HH:MM (24-hour format)" };
  }

  const morningTimezone = String(
    payload.morningTimezone ?? DEFAULT_AUTOMATION_SETTINGS.morningTimezone,
  ).trim();
  if (morningEnabled && !isValidTimezone(morningTimezone)) {
    return { error: "morningTimezone must be a valid IANA timezone" };
  }

  const deliveryChannel = String(payload.deliveryChannel ?? "")
    .trim()
    .toLowerCase();
  const deliveryTarget = String(payload.deliveryTarget ?? "").trim();
  if (deliveryChannel && !SUPPORTED_DELIVERY_CHANNELS.has(deliveryChannel)) {
    return {
      error: `deliveryChannel must be one of: ${Array.from(SUPPORTED_DELIVERY_CHANNELS).join(", ")}`,
    };
  }
  if ((deliveryChannel && !deliveryTarget) || (!deliveryChannel && deliveryTarget)) {
    return {
      error:
        "deliveryChannel and deliveryTarget must be set together, or both left empty",
    };
  }

  const progressPrompt = String(
    payload.progressPrompt ?? DEFAULT_AUTOMATION_SETTINGS.progressPrompt,
  ).trim();
  const morningPrompt = String(
    payload.morningPrompt ?? DEFAULT_AUTOMATION_SETTINGS.morningPrompt,
  ).trim();
  if (!progressPrompt) return { error: "progressPrompt cannot be empty" };
  if (!morningPrompt) return { error: "morningPrompt cannot be empty" };
  if (progressPrompt.length > 2000) {
    return { error: "progressPrompt must be <= 2000 characters" };
  }
  if (morningPrompt.length > 2000) {
    return { error: "morningPrompt must be <= 2000 characters" };
  }

  return {
    value: {
      progressEnabled,
      progressEveryHours,
      progressPrompt,
      morningEnabled,
      morningTime,
      morningTimezone,
      deliveryChannel,
      deliveryTarget,
    },
  };
}

function buildDeliveryArgs(settings) {
  const args = ["--announce"];
  if (settings.deliveryChannel && settings.deliveryTarget) {
    args.push("--channel", settings.deliveryChannel, "--to", settings.deliveryTarget);
  }
  return args;
}

async function removeManagedCronJobs(logLines) {
  const toRemove = new Set();
  const previous = readAutomationState();

  if (previous?.jobs?.progressJobId) toRemove.add(previous.jobs.progressJobId);
  if (previous?.jobs?.morningJobId) toRemove.add(previous.jobs.morningJobId);

  const listed = await listCronJobs();
  if (listed.ok) {
    for (const job of listed.jobs) {
      if (job.name === AUTOMATION_JOB_NAMES.progress) toRemove.add(job.id);
      if (job.name === AUTOMATION_JOB_NAMES.morning) toRemove.add(job.id);
    }
  } else {
    logLines.push(`[automation] ${listed.error}`);
    if (listed.output) logLines.push(listed.output);
  }

  for (const id of toRemove) {
    const removed = await runCmd(OPENCLAW_NODE, clawArgs(["cron", "rm", id]));
    logLines.push(`[cron rm] id=${id} exit=${removed.code}`);
    const out = trimOutputBlock(removed.output, 400);
    if (out) logLines.push(out);
  }
}

async function configureAutomations(settings) {
  const logLines = [];
  await removeManagedCronJobs(logLines);

  const deliveryArgs = buildDeliveryArgs(settings);

  if (settings.progressEnabled) {
    const progress = await runCmd(
      OPENCLAW_NODE,
      clawArgs([
        "cron",
        "add",
        "--name",
        AUTOMATION_JOB_NAMES.progress,
        "--every",
        `${settings.progressEveryHours}h`,
        "--session",
        "isolated",
        "--message",
        settings.progressPrompt,
        ...deliveryArgs,
      ]),
    );
    logLines.push(`[cron add] progress exit=${progress.code}`);
    const out = trimOutputBlock(progress.output, 600);
    if (out) logLines.push(out);
    if (progress.code !== 0) {
      throw new Error("Failed to create progress update cron job");
    }
  }

  if (settings.morningEnabled) {
    const [hour, minute] = settings.morningTime.split(":");
    const cronExpr = `${Number.parseInt(minute, 10)} ${Number.parseInt(hour, 10)} * * *`;
    const morning = await runCmd(
      OPENCLAW_NODE,
      clawArgs([
        "cron",
        "add",
        "--name",
        AUTOMATION_JOB_NAMES.morning,
        "--cron",
        cronExpr,
        "--tz",
        settings.morningTimezone,
        "--session",
        "isolated",
        "--message",
        settings.morningPrompt,
        ...deliveryArgs,
      ]),
    );
    logLines.push(`[cron add] morning exit=${morning.code}`);
    const out = trimOutputBlock(morning.output, 600);
    if (out) logLines.push(out);
    if (morning.code !== 0) {
      throw new Error("Failed to create morning briefing cron job");
    }
  }

  let progressJobId = null;
  let morningJobId = null;
  const listed = await listCronJobs();
  if (listed.ok) {
    progressJobId =
      listed.jobs.find((job) => job.name === AUTOMATION_JOB_NAMES.progress)?.id ||
      null;
    morningJobId =
      listed.jobs.find((job) => job.name === AUTOMATION_JOB_NAMES.morning)?.id ||
      null;
  } else {
    logLines.push(`[automation] ${listed.error}`);
    if (listed.output) logLines.push(listed.output);
  }

  const state = {
    version: 1,
    updatedAt: new Date().toISOString(),
    settings,
    jobs: {
      progressJobId,
      morningJobId,
    },
  };
  writeAutomationState(state);

  return {
    state,
    output: logLines.join("\n"),
    cronListOk: listed.ok,
    cronListError: listed.ok ? "" : listed.error,
  };
}

async function syncGatewayConfigForProxy(opts = {}) {
  if (!isConfigured()) {
    return { ok: false, skipped: true, output: "" };
  }

  const logPrefix = opts.logPrefix || "[gateway-config]";
  let output = "";
  const checks = [];

  async function runSetting(label, args) {
    const result = await runCmd(OPENCLAW_NODE, clawArgs(args));
    checks.push(result.code === 0);
    output += `${logPrefix} ${label} exit=${result.code}\n`;
    if (result.code !== 0 && result.output?.trim()) {
      output += `${result.output.trim()}\n`;
    }
    return result;
  }

  await runSetting("gateway.controlUi.allowInsecureAuth=true", [
    "config",
    "set",
    "gateway.controlUi.allowInsecureAuth",
    "true",
  ]);

  await runSetting(
    `gateway.controlUi.dangerouslyDisableDeviceAuth=${String(DISABLE_CONTROL_UI_DEVICE_AUTH)}`,
    [
      "config",
      "set",
      "gateway.controlUi.dangerouslyDisableDeviceAuth",
      String(DISABLE_CONTROL_UI_DEVICE_AUTH),
    ],
  );

  await runSetting("gateway.auth.mode=token", [
    "config",
    "set",
    "gateway.auth.mode",
    "token",
  ]);

  await runSetting("gateway.auth.token", [
    "config",
    "set",
    "gateway.auth.token",
    OPENCLAW_GATEWAY_TOKEN,
  ]);

  await runSetting("gateway.trustedProxies=[127.0.0.1,::1]", [
    "config",
    "set",
    "--json",
    "gateway.trustedProxies",
    '["127.0.0.1","::1"]',
  ]);

  const originSync = await ensureControlUiAllowedOrigins(opts.req || null, {
    logPrefix,
    restartGatewayOnChange: false,
  });
  checks.push(originSync.ok || originSync.skipped);
  if (originSync.updated && originSync.origins?.length) {
    output += `${logPrefix} gateway.controlUi.allowedOrigins=${JSON.stringify(originSync.origins)}\n`;
  }

  return { ok: checks.every(Boolean), skipped: false, output };
}

const VALID_FLOWS = ["quickstart", "advanced", "manual"];
const VALID_AUTH_CHOICES = [
  "codex-cli",
  "openai-codex",
  "openai-api-key",
  "claude-cli",
  "token",
  "apiKey",
  "gemini-api-key",
  "google-antigravity",
  "google-gemini-cli",
  "openrouter-api-key",
  "ollama-local",
  "ai-gateway-api-key",
  "moonshot-api-key",
  "kimi-code-api-key",
  "zai-api-key",
  "minimax-api",
  "minimax-api-lightning",
  "qwen-portal",
  "github-copilot",
  "copilot-proxy",
  "synthetic-api-key",
  "opencode-zen",
];

function validatePayload(payload) {
  if (payload.flow && !VALID_FLOWS.includes(payload.flow)) {
    return `Invalid flow: ${payload.flow}. Must be one of: ${VALID_FLOWS.join(", ")}`;
  }
  if (payload.authChoice && !VALID_AUTH_CHOICES.includes(payload.authChoice)) {
    return `Invalid authChoice: ${payload.authChoice}`;
  }
  const stringFields = [
    "telegramToken",
    "discordToken",
    "slackBotToken",
    "slackAppToken",
    "authSecret",
    "model",
  ];
  for (const field of stringFields) {
    if (payload[field] !== undefined && typeof payload[field] !== "string") {
      return `Invalid ${field}: must be a string`;
    }
  }
  if (payload.authChoice === "ollama-local") {
    const model = payload.model?.trim() || "";
    if (!model) {
      return 'Model is required for Ollama (example: "ollama/llama3.1:8b")';
    }
    if (!model.startsWith("ollama/")) {
      return 'Ollama model must start with "ollama/"';
    }
  }
  return null;
}

app.post("/setup/api/run", requireSetupAuth, async (req, res) => {
  try {
    if (isConfigured()) {
      const synced = await syncGatewayConfigForProxy({
        logPrefix: "[setup-config]",
        req,
      });
      await restartGateway();
      return res.json({
        ok: true,
        output: [
          "Already configured.",
          "Applied compatibility gateway settings for reverse proxy mode.",
          "Gateway restarted.",
          "",
          synced.output.trim(),
        ]
          .filter(Boolean)
          .join("\n"),
      });
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

    const payload = req.body || {};
    const validationError = validatePayload(payload);
    if (validationError) {
      return res.status(400).json({ ok: false, output: validationError });
    }
    const onboardArgs = buildOnboardArgs(payload);
    const onboard = await runCmd(OPENCLAW_NODE, clawArgs(onboardArgs));

    let extra = "";
    extra += `\n[setup] Onboarding exit=${onboard.code} configured=${isConfigured()}\n`;

    const ok = onboard.code === 0 && isConfigured();

    if (ok) {
      extra += "\n[setup] Configuring gateway settings...\n";

      const allowInsecureResult = await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "config",
          "set",
          "--json",
          "gateway.controlUi.allowInsecureAuth",
          "true",
        ]),
      );
      extra += `[config] gateway.controlUi.allowInsecureAuth=true exit=${allowInsecureResult.code}\n`;

      const tokenResult = await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "config",
          "set",
          "gateway.auth.token",
          OPENCLAW_GATEWAY_TOKEN,
        ]),
      );
      extra += `[config] gateway.auth.token exit=${tokenResult.code}\n`;

      const proxiesResult = await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "config",
          "set",
          "--json",
          "gateway.trustedProxies",
          '["127.0.0.1"]',
        ]),
      );
      extra += `[config] gateway.trustedProxies exit=${proxiesResult.code}\n`;

      const originSync = await ensureControlUiAllowedOrigins(req, {
        logPrefix: "[setup-config]",
        restartGatewayOnChange: false,
      });
      extra += `[config] gateway.controlUi.allowedOrigins exit=${originSync.ok ? 0 : 1}\n`;

      if (payload.authChoice === "ollama-local") {
        const resolvedOllamaApiKey =
          payload.authSecret?.trim() ||
          process.env.OLLAMA_API_KEY?.trim() ||
          "ollama-local";
        process.env.OLLAMA_API_KEY = resolvedOllamaApiKey;
        const ollamaHost = process.env.OLLAMA_HOST?.trim() || "127.0.0.1:11434";
        process.env.OLLAMA_BASE_URL =
          process.env.OLLAMA_BASE_URL?.trim() || `http://${ollamaHost}/api`;
        extra += `[setup] Ollama provider enabled (OLLAMA_BASE_URL=${process.env.OLLAMA_BASE_URL})\n`;
      }

      if (payload.model?.trim()) {
        extra += `[setup] Setting model to ${payload.model.trim()}...\n`;
        const modelResult = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["models", "set", payload.model.trim()]),
        );
        extra += `[models set] exit=${modelResult.code}\n${modelResult.output || ""}`;
      }

      async function configureChannel(name, cfgObj) {
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs([
            "config",
            "set",
            "--json",
            `channels.${name}`,
            JSON.stringify(cfgObj),
          ]),
        );
        const get = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "get", `channels.${name}`]),
        );
        return (
          `\n[${name} config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}` +
          `\n[${name} verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`
        );
      }

      if (payload.telegramToken?.trim()) {
        extra += await configureChannel("telegram", {
          enabled: true,
          dmPolicy: "pairing",
          botToken: payload.telegramToken.trim(),
          groupPolicy: "allowlist",
          streamMode: "partial",
        });
      }

      if (payload.discordToken?.trim()) {
        extra += await configureChannel("discord", {
          enabled: true,
          token: payload.discordToken.trim(),
          groupPolicy: "allowlist",
          dm: { policy: "pairing" },
        });
      }

      if (payload.slackBotToken?.trim() || payload.slackAppToken?.trim()) {
        extra += await configureChannel("slack", {
          enabled: true,
          botToken: payload.slackBotToken?.trim() || undefined,
          appToken: payload.slackAppToken?.trim() || undefined,
        });
      }

      extra += "\n[setup] Starting gateway...\n";
      await restartGateway();
      extra += "[setup] Gateway started.\n";
    }

    return res.status(ok ? 200 : 500).json({
      ok,
      output: `${onboard.output}${extra}`,
    });
  } catch (err) {
    console.error("[/setup/api/run] error:", err);
    return res
      .status(500)
      .json({ ok: false, output: `Internal error: ${String(err)}` });
  }
});

app.get("/setup/api/debug", requireSetupAuth, async (_req, res) => {
  const v = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const help = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["channels", "add", "--help"]),
  );
  res.json({
    wrapper: {
      node: process.version,
      port: PORT,
      stateDir: STATE_DIR,
      workspaceDir: WORKSPACE_DIR,
      configPath: configPath(),
      gatewayTokenFromEnv: Boolean(process.env.OPENCLAW_GATEWAY_TOKEN?.trim()),
      gatewayTokenPersisted: fs.existsSync(
        path.join(STATE_DIR, "gateway.token"),
      ),
      disableControlUiDeviceAuth: DISABLE_CONTROL_UI_DEVICE_AUTH,
      railwayCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    },
    openclaw: {
      entry: OPENCLAW_ENTRY,
      node: OPENCLAW_NODE,
      version: v.output.trim(),
      channelsAddHelpIncludesTelegram: help.output.includes("telegram"),
    },
  });
});

app.post("/setup/api/pairing/approve", requireSetupAuth, async (req, res) => {
  const { channel, code } = req.body || {};
  if (!channel || !code) {
    return res
      .status(400)
      .json({ ok: false, error: "Missing channel or code" });
  }
  const r = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["pairing", "approve", String(channel), String(code)]),
  );
  return res
    .status(r.code === 0 ? 200 : 500)
    .json({ ok: r.code === 0, output: r.output });
});

app.post("/setup/api/reset", requireSetupAuth, async (_req, res) => {
  try {
    const logs = [];
    await removeManagedCronJobs(logs);
    fs.rmSync(AUTOMATION_STATE_PATH, { force: true });
    fs.rmSync(configPath(), { force: true });
    res.type("text/plain").send(
      [
        "OK - deleted config file. You can rerun setup now.",
        "",
        logs.length ? logs.join("\n") : "(no automation cleanup output)",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } catch (err) {
    res.status(500).type("text/plain").send(String(err));
  }
});

app.post("/setup/api/doctor", requireSetupAuth, async (_req, res) => {
  const args = ["doctor", "--non-interactive", "--repair"];
  const result = await runCmd(OPENCLAW_NODE, clawArgs(args));
  return res.status(result.code === 0 ? 200 : 500).json({
    ok: result.code === 0,
    output: result.output,
  });
});

app.get("/tui", requireSetupAuth, (_req, res) => {
  if (!ENABLE_WEB_TUI) {
    return res
      .status(403)
      .type("text/plain")
      .send("Web TUI is disabled. Set ENABLE_WEB_TUI=true to enable it.");
  }
  if (!isConfigured()) {
    return res.redirect("/setup");
  }
  res.sendFile(path.join(process.cwd(), "src", "public", "tui.html"));
});

let activeTuiSession = null;

function verifyTuiAuth(req) {
  if (!SETUP_PASSWORD) return false;
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) return false;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  const passwordHash = crypto.createHash("sha256").update(password).digest();
  const expectedHash = crypto.createHash("sha256").update(SETUP_PASSWORD).digest();
  return crypto.timingSafeEqual(passwordHash, expectedHash);
}

function createTuiWebSocketServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws, req) => {
    const clientIp = req.socket?.remoteAddress || "unknown";
    console.log(`[tui] session started from ${clientIp}`);

    let ptyProcess = null;
    let idleTimer = null;
    let maxSessionTimer = null;

    activeTuiSession = {
      ws,
      pty: null,
      startedAt: Date.now(),
      lastActivity: Date.now(),
    };

    function resetIdleTimer() {
      if (activeTuiSession) {
        activeTuiSession.lastActivity = Date.now();
      }
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        console.log("[tui] session idle timeout");
        ws.close(4002, "Idle timeout");
      }, TUI_IDLE_TIMEOUT_MS);
    }

    function spawnPty(cols, rows) {
      if (ptyProcess) return;

      console.log(`[tui] spawning PTY with ${cols}x${rows}`);
      ptyProcess = pty.spawn(OPENCLAW_NODE, clawArgs(["tui"]), {
        name: "xterm-256color",
        cols,
        rows,
        cwd: WORKSPACE_DIR,
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: STATE_DIR,
          OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
          TERM: "xterm-256color",
        },
      });

      if (activeTuiSession) {
        activeTuiSession.pty = ptyProcess;
      }

      idleTimer = setTimeout(() => {
        console.log("[tui] session idle timeout");
        ws.close(4002, "Idle timeout");
      }, TUI_IDLE_TIMEOUT_MS);

      maxSessionTimer = setTimeout(() => {
        console.log("[tui] max session duration reached");
        ws.close(4002, "Max session duration");
      }, TUI_MAX_SESSION_MS);

      ptyProcess.onData((data) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(data);
        }
      });

      ptyProcess.onExit(({ exitCode, signal }) => {
        console.log(`[tui] PTY exited code=${exitCode} signal=${signal}`);
        if (ws.readyState === ws.OPEN) {
          ws.close(1000, "Process exited");
        }
      });
    }

    ws.on("message", (message) => {
      resetIdleTimer();
      try {
        const msg = JSON.parse(message.toString());
        if (msg.type === "resize" && msg.cols && msg.rows) {
          const cols = Math.min(Math.max(msg.cols, 10), 500);
          const rows = Math.min(Math.max(msg.rows, 5), 200);
          if (!ptyProcess) {
            spawnPty(cols, rows);
          } else {
            ptyProcess.resize(cols, rows);
          }
        } else if (msg.type === "input" && msg.data && ptyProcess) {
          ptyProcess.write(msg.data);
        }
      } catch (err) {
        console.warn(`[tui] invalid message: ${err.message}`);
      }
    });

    ws.on("close", () => {
      console.log("[tui] session closed");
      clearTimeout(idleTimer);
      clearTimeout(maxSessionTimer);
      if (ptyProcess) {
        try {
          ptyProcess.kill();
        } catch {}
      }
      activeTuiSession = null;
    });

    ws.on("error", (err) => {
      console.error(`[tui] WebSocket error: ${err.message}`);
    });
  });

  return wss;
}

const proxy = httpProxy.createProxyServer({
  target: GATEWAY_TARGET,
  ws: true,
  xfwd: true,
  proxyTimeout: 120_000,
  timeout: 120_000,
});

proxy.on("error", (err, _req, resOrSocket) => {
  if (isConnRefusedError(err)) {
    console.warn(
      `[proxy] gateway connection refused at ${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`,
    );
    gatewayHealthy = false;
    requestGatewayRecovery("proxy connection refused");
  } else {
    console.error("[proxy]", err);
  }

  if (
    resOrSocket &&
    typeof resOrSocket.headersSent !== "undefined" &&
    !resOrSocket.headersSent
  ) {
    resOrSocket.writeHead(503, { "Content-Type": "text/html" });
    try {
      const html = fs.readFileSync(
        path.join(process.cwd(), "src", "public", "loading.html"),
        "utf8",
      );
      resOrSocket.end(html);
    } catch {
      resOrSocket.end("Gateway unavailable. Retrying...");
    }
  } else if (resOrSocket && typeof resOrSocket.destroy === "function") {
    resOrSocket.destroy();
  }
});

// FIX #1: Auth token injected via header only — never in URL.
proxy.on("proxyReq", (proxyReq, req, res) => {
  proxyReq.setHeader("Authorization", `Bearer ${OPENCLAW_GATEWAY_TOKEN}`);
});

proxy.on("proxyReqWs", (proxyReq, req, socket, options, head) => {
  proxyReq.setHeader("Authorization", `Bearer ${OPENCLAW_GATEWAY_TOKEN}`);
});

app.use(async (req, res) => {
  if (!isConfigured() && !req.path.startsWith("/setup")) {
    return res.redirect("/setup");
  }

  if (isConfigured()) {
    // FIX #2: Debounced — only syncs origins at most once per 60s, not per-request.
    try {
      await maybeEnsureControlUiAllowedOrigins(req, {
        logPrefix: "[request-config]",
        restartGatewayOnChange: true,
      });
    } catch (err) {
      console.warn(
        `[request-config] failed syncing allowed origins: ${err.message}`,
      );
    }

    if (!isGatewayReady()) {
      try {
        await ensureGatewayRunning();
      } catch {
        return res
          .status(503)
          .sendFile(path.join(process.cwd(), "src", "public", "loading.html"));
      }

      if (!isGatewayReady()) {
        return res
          .status(503)
          .sendFile(path.join(process.cwd(), "src", "public", "loading.html"));
      }
    }
  }

  // FIX #1: Removed token-in-URL redirect for /openclaw.
  // The proxy already injects Authorization header in proxyReq/proxyReqWs events.
  // Putting the token in the query string leaks it to browser history, logs, and
  // any analytics/CDN sitting in front of Railway.

  return proxy.web(req, res, { target: GATEWAY_TARGET });
});

const server = app.listen(PORT, () => {
  console.log(`[wrapper] listening on port ${PORT}`);
  console.log(`[wrapper] setup wizard: http://localhost:${PORT}/setup`);
  console.log(`[wrapper] web TUI: ${ENABLE_WEB_TUI ? "enabled" : "disabled"}`);
  console.log(`[wrapper] configured: ${isConfigured()}`);

  if (isConfigured()) {
    (async () => {
      try {
        console.log("[wrapper] running openclaw doctor --fix...");
        const dr = await runCmd(OPENCLAW_NODE, clawArgs(["doctor", "--fix"]));
        console.log(`[wrapper] doctor --fix exit=${dr.code}`);
        if (dr.output) console.log(dr.output);
      } catch (err) {
        console.warn(`[wrapper] doctor --fix failed: ${err.message}`);
      }
      await ensureGatewayRunning();
    })().catch((err) => {
      console.error(`[wrapper] failed to start gateway at boot: ${err.message}`);
    });
  }
});

const tuiWss = createTuiWebSocketServer(server);

server.on("upgrade", async (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/tui/ws") {
    if (!ENABLE_WEB_TUI) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!verifyTuiAuth(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"OpenClaw TUI\"\r\n\r\n");
      socket.destroy();
      return;
    }

    if (activeTuiSession) {
      socket.write("HTTP/1.1 409 Conflict\r\n\r\n");
      socket.destroy();
      return;
    }

    tuiWss.handleUpgrade(req, socket, head, (ws) => {
      tuiWss.emit("connection", ws, req);
    });
    return;
  }

  if (!isConfigured()) {
    socket.destroy();
    return;
  }
  try {
    // FIX #2: Debounced origin sync for WebSocket upgrades too.
    await maybeEnsureControlUiAllowedOrigins(req, {
      logPrefix: "[websocket-config]",
      restartGatewayOnChange: true,
    });
    await ensureGatewayRunning();
  } catch (err) {
    console.warn(`[websocket] gateway not ready: ${err.message}`);
    socket.destroy();
    return;
  }
  proxy.ws(req, socket, head, { target: GATEWAY_TARGET });
});

// FIX #4: Null-safe graceful shutdown — pty may be null, gatewayProc may already be gone.
async function gracefulShutdown(signal) {
  console.log(`[wrapper] received ${signal}, shutting down`);
  shuttingDown = true;

  if (setupRateLimiter.cleanupInterval) {
    clearInterval(setupRateLimiter.cleanupInterval);
  }

  if (activeTuiSession) {
    try {
      activeTuiSession.ws?.close(1001, "Server shutting down");
    } catch {}
    try {
      activeTuiSession.pty?.kill();
    } catch {}
    activeTuiSession = null;
  }

  server.close();

  const proc = gatewayProc;
  if (proc) {
    try {
      proc._manualRestart = true;
      proc.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => proc.on("exit", resolve)),
        sleep(2000),
      ]);
      if (!proc.killed) {
        proc.kill("SIGKILL");
      }
    } catch (err) {
      console.warn(`[wrapper] error killing gateway: ${err.message}`);
    }
  }

  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));