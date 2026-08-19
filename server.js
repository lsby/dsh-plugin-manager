/**
 * DSH 插件管理器 —— 独立网页应用
 *
 * 提供一个本地图形界面，用于：
 *   - 查看每个 profile 的已激活 bundle 层与已安装依赖
 *   - 增/删/更新插件（转发给 `dsh plugin --profile <name> add/remove/update …`）
 *   - 调整 bundle 层顺序（`dsh.profile.bundles` 重排）
 *   - 临时禁用/启用插件（向 profile 的 cordis.patch.yml 追加
 *     `{ id, name, disabled: true }` 补丁，可持久、可一键还原）
 *   - 一键重启 / 启动 / 停止 `dsh web` 进程
 *
 * 零第三方依赖，仅用 Node 内置模块。仅监听 127.0.0.1。
 *
 * 运行：`node server.js`（或 `npm start`），默认端口 3929。
 */

import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");

/** Harness 主目录：显式指定或默认 ~/.dsh。 */
const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const PROFILES_DIR = join(DSH_HOME, "profiles");

/** 端口：--port 参数、PORT 环境变量，默认 3929。 */
const PORT = Number(process.env.PORT || parsePortArg() || 3929);

function parsePortArg() {
  const i = process.argv.indexOf("--port");
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return undefined;
}

// ────────────────────────────────────────────────────────────────────────────
// 工具函数
// ────────────────────────────────────────────────────────────────────────────

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function safeKill(pid, signal) {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      return true;
    }
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** 探测 dsh 可执行文件：环境变量 > PATH 上的 `dsh` > 兜底字符串。 */
function detectDshBin() {
  if (process.env.DSH_BIN) return process.env.DSH_BIN;
  const tool = process.platform === "win32" ? "where" : "which";
  try {
    const which = spawnSync(tool, ["dsh"], { encoding: "utf8" });
    if (which.status === 0 && which.stdout.trim()) {
      const lines = which.stdout
        .trim()
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      if (process.platform === "win32") {
        const cmdLine = lines.find((l) => /\.(cmd|exe|bat)$/i.test(l));
        if (cmdLine) return cmdLine;
      }
      if (lines[0]) return lines[0];
    }
  } catch {
    /* 忽略 */
  }
  return "dsh";
}
const DSH_BIN = detectDshBin();

/** 原子写：先写临时文件再 rename，避免 DSH 的文件监听读到半截内容。 */
function atomicWrite(file, content) {
  const tmp = file + ".pm-tmp";
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

// ────────────────────────────────────────────────────────────────────────────
// DSH 进程发现
// ────────────────────────────────────────────────────────────────────────────

const DSH_WEB_RE = /\b(?:dsh(?:\.(?:cmd|exe|bat|ps1))?|bin\.js)["']?\s+(?:web|--profile\s+web)\b/i;

let procCache = { at: 0, list: [] };
const PROC_CACHE_TTL_MS = 1500;

/**
 * 找出运行中的 `dsh web` 进程（含 PID、完整命令行、工作目录）。
 * @returns {Array<{pid:number, command:string, cwd:string}>}
 */
function findDshWeb(force = false) {
  const now = Date.now();
  if (!force && now - procCache.at < PROC_CACHE_TTL_MS) {
    return procCache.list;
  }

  let found = [];
  if (process.platform === "win32") {
    try {
      const psScript = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine -match "dsh" -or $_.CommandLine -match "bin\\.js") } | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress`;
      const encoded = Buffer.from(psScript, "utf16le").toString("base64");
      const result = spawnSync("powershell.exe", ["-NoProfile", "-EncodedCommand", encoded], {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        timeout: 5000,
      });
      if (result.status === 0 && result.stdout.trim()) {
        const parsed = JSON.parse(result.stdout.trim());
        const list = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of list) {
          if (!item || !item.ProcessId || !item.CommandLine) continue;
          const pid = Number(item.ProcessId);
          const command = item.CommandLine;
          if (pid === process.pid) continue;
          if (DSH_WEB_RE.test(command)) {
            found.push({ pid, command, cwd: process.cwd() });
          }
        }
      }
    } catch {
      /* 忽略 */
    }
  } else {
    try {
      const result = spawnSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" });
      if (result.status === 0 && result.stdout) {
        for (const line of result.stdout.split("\n")) {
          const match = /^\s*(\d+)\s+(.*)$/.exec(line);
          if (!match) continue;
          const pid = Number(match[1]);
          const command = match[2];
          if (pid === process.pid) continue;
          if (DSH_WEB_RE.test(command)) found.push({ pid, command, cwd: readCwd(pid) });
        }
      }
    } catch {
      /* 忽略 */
    }
  }

  procCache = { at: now, list: found };
  return found;
}

/** 通过 lsof 读取进程工作目录；失败回退到管理器自身 cwd。 */
function readCwd(pid) {
  try {
    const result = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" });
    for (const line of (result.stdout || "").split("\n")) {
      if (line.startsWith("n")) return line.slice(1);
    }
  } catch {
    /* 忽略 */
  }
  return process.cwd();
}

/** 推导 DSH Web 界面地址：环境变量 > 进程参数 --port > 默认 3080。 */
function detectWebUrl() {
  if (process.env.DSH_WEB_URL) return process.env.DSH_WEB_URL;
  for (const proc of findDshWeb()) {
    const match = /\s--port(?:\s+|=)(\d+)/.exec(proc.command);
    if (match) return `http://127.0.0.1:${match[1]}`;
  }
  return "http://127.0.0.1:3080";
}

// ────────────────────────────────────────────────────────────────────────────
// 插件条目发现（id + 包名 → 可禁用目标）
// ────────────────────────────────────────────────────────────────────────────

/** 从文本中提取 `- id: X` 后紧跟 `name: 'Y'` 的 (id, 包名) 对。 */
function extractIdNamePairs(text) {
  const pairs = [];
  const re = /- id:\s*([^\s,]+)\s+name:\s*'([^']+)'/g;
  let match;
  while ((match = re.exec(text)) !== null) pairs.push({ id: match[1], name: match[2] });
  return pairs;
}

/** 每个 profile 的 dump-config 结果缓存（TTL 30 秒）。 */
const dumpCache = new Map();
const DUMP_TTL_MS = 30000;

/**
 * 计算 profile 的「包名 → 条目 id 列表」映射：
 * 1. 运行 `dsh --profile <name> --dump-config`（权威的生效树，含全部补丁层）；
 * 2. 兜底/补充解析 profile 自己的 cordis.patch.yml 中的 insert 条目。
 * 二者合并去重。失败时返回空映射（不抛出）。
 */
function entryIdsByName(profile, dir, patchContent) {
  const now = Date.now();
  const cached = dumpCache.get(profile);
  if (cached && now - cached.at < DUMP_TTL_MS) return cached.map;

  const map = new Map();
  const add = (id, name) => {
    if (!map.has(name)) map.set(name, []);
    if (!map.get(name).includes(id)) map.get(name).push(id);
  };
  try {
    const result = spawnSync(DSH_BIN, ["--profile", profile, "--dump-config"], {
      encoding: "utf8",
      env: { ...process.env, DSH_HOME },
      timeout: 15000,
      shell: process.platform === "win32",
    });
    if (result.status === 0 && result.stdout) {
      for (const pair of extractIdNamePairs(result.stdout)) add(pair.id, pair.name);
    }
  } catch {
    /* 忽略，走 patch 解析兜底 */
  }
  for (const pair of extractIdNamePairs(patchContent)) add(pair.id, pair.name);

  dumpCache.set(profile, { at: now, map });
  return map;
}

// ────────────────────────────────────────────────────────────────────────────
// 禁用状态（sidecar 文件记录管理器写入的确切补丁文本）
// ────────────────────────────────────────────────────────────────────────────

function sidecarPath(profileDir) {
  return join(profileDir, ".dsh-plugin-manager.json");
}

function readSidecar(profileDir) {
  const data = readJson(sidecarPath(profileDir));
  return data && typeof data === "object" ? data : { disables: {} };
}

function writeSidecar(profileDir, state) {
  atomicWrite(sidecarPath(profileDir), JSON.stringify(state, null, 2) + "\n");
}

function yamlSingleQuote(value) {
  return String(value).replace(/'/g, "''");
}

// ────────────────────────────────────────────────────────────────────────────
// 状态读取
// ────────────────────────────────────────────────────────────────────────────

function resolveInstalledVersion(profileDir, name) {
  const candidates = [
    join(profileDir, "node_modules", name, "package.json"),
    join(PROFILES_DIR, "node_modules", name, "package.json"),
  ];
  for (const candidate of candidates) {
    const manifest = readJson(candidate);
    if (manifest && typeof manifest.version === "string") return manifest.version;
  }
  return null;
}

function profileInfo(name) {
  const dir = join(PROFILES_DIR, name);
  const manifest = readJson(join(dir, "package.json"));
  if (!manifest) return { name, dir, missing: true };

  const bundles = manifest.dsh?.profile?.bundles ?? [];
  const dependencies = manifest.dependencies ?? {};
  const patchPath = join(dir, "cordis.patch.yml");
  const patchContent = existsSync(patchPath) ? readFileSync(patchPath, "utf8") : "";
  const idsByName = entryIdsByName(name, dir, patchContent);
  const disables = readSidecar(dir).disables;

  const bundleEntries = bundles.map((bundle) => ({
    name: bundle,
    kind: Object.prototype.hasOwnProperty.call(dependencies, bundle)
      ? "bundle-dependency"
      : "bundle-builtin",
    spec: dependencies[bundle] ?? null,
    version: resolveInstalledVersion(dir, bundle),
  }));

  const dependencyEntries = Object.entries(dependencies).map(([depName, spec]) => {
    const entryIds = idsByName.get(depName) ?? [];
    return {
      name: depName,
      kind: bundles.includes(depName) ? "bundle-dependency" : "dependency",
      spec,
      version: resolveInstalledVersion(dir, depName),
      referencedInPatch: patchContent.includes(depName),
      entryIds,
      disabled: Boolean(disables[depName]),
    };
  });

  return {
    name,
    dir,
    bundles: bundleEntries,
    dependencies: dependencyEntries,
    hasPatch: patchContent.length > 0,
    patchPath,
  };
}

function listProfiles() {
  if (!existsSync(PROFILES_DIR)) return [];
  return readdirSync(PROFILES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
    .map((entry) => entry.name)
    .sort();
}

function getState() {
  const processes = findDshWeb();
  return {
    dshHome: DSH_HOME,
    dsh: {
      running: processes.length > 0,
      webUrl: detectWebUrl(),
      processes: processes.map((p) => ({ pid: p.pid, command: p.command, cwd: p.cwd })),
    },
    profiles: listProfiles().map(profileInfo),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// HTTP 辅助
// ────────────────────────────────────────────────────────────────────────────

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function readJsonBody(req) {
  const body = await readBody(req);
  try {
    return JSON.parse(body || "{}");
  } catch {
    return null;
  }
}

/** 建立 NDJSON 流式响应；返回 send(type, data) 函数。 */
function openStream(res) {
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
  });
  return (type, data) => res.write(JSON.stringify({ type, data: String(data) }) + "\n");
}

// ────────────────────────────────────────────────────────────────────────────
// 操作实现
// ────────────────────────────────────────────────────────────────────────────

/** 启动一个新的 dsh web 进程（detached，脱离管理器生命周期）。 */
function launchDshWeb(command, cwd, send) {
  send("info", `启动：${command}`);
  send("info", `工作目录：${cwd}`);
  const child = spawn(command, {
    shell: true,
    detached: true,
    stdio: "ignore",
    cwd,
    env: { ...process.env, DSH_HOME },
  });
  child.unref();
  send("ok", `已启动 dsh web（PID ${child.pid}）`);
}

async function waitForExit(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !isAlive(pid))) return true;
    await sleep(150);
  }
  return pids.every((pid) => !isAlive(pid));
}

/** 终止全部 dsh web 进程，等待退出，必要时 SIGKILL。返回是否曾终止。 */
async function stopDshProcesses(send) {
  procCache.at = 0;
  const processes = findDshWeb(true);
  if (processes.length === 0) {
    send?.("info", "dsh web 未在运行。");
    return false;
  }
  for (const proc of processes) {
    send?.("info", `终止 dsh web 进程 PID ${proc.pid}（SIGTERM）`);
    safeKill(proc.pid, "SIGTERM");
  }
  const exited = await waitForExit(processes.map((p) => p.pid), 6000);
  if (!exited) {
    for (const proc of processes) {
      if (isAlive(proc.pid)) {
        send?.("info", `PID ${proc.pid} 未退出，发送 SIGKILL`);
        safeKill(proc.pid, "SIGKILL");
      }
    }
    await sleep(500);
  }
  await sleep(400);
  return true;
}

async function handleRestart(req, res) {
  const send = openStream(res);
  try {
    if (findDshWeb().length === 0) {
      send("info", "未发现运行中的 dsh web 进程，直接启动。");
      launchDshWeb(`${DSH_BIN} web`, process.cwd(), send);
      send("exit", 0);
      return res.end();
    }
    // 终止前先捕获主进程的启动命令与工作目录（杀进程后就拿不到了）。
    const primary = findDshWeb()[0];
    const primaryCommand = primary.command;
    const primaryCwd = primary.cwd || process.cwd();

    await stopDshProcesses(send);
    launchDshWeb(primaryCommand, primaryCwd, send);
    send("exit", 0);
  } catch (error) {
    send("error", error && error.stack ? error.stack : String(error));
    send("exit", 1);
  } finally {
    res.end();
  }
}

async function handleStop(req, res) {
  const send = openStream(res);
  try {
    if (await stopDshProcesses(send)) send("ok", "dsh web 已停止。");
    send("exit", 0);
  } catch (error) {
    send("error", error && error.stack ? error.stack : String(error));
    send("exit", 1);
  } finally {
    res.end();
  }
}

const OP_ACTIONS = { add: "add", remove: "remove", update: "update" };

async function handlePluginOp(req, res) {
  const parsed = await readJsonBody(req);
  if (!parsed) return sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" });

  const { action, profile, spec } = parsed;
  if (!OP_ACTIONS[action]) return sendJson(res, 400, { ok: false, error: `未知操作：${action}` });
  if (!profile || typeof profile !== "string") return sendJson(res, 400, { ok: false, error: "缺少 profile" });
  if (action !== "remove" && (!spec || typeof spec !== "string")) return sendJson(res, 400, { ok: false, error: "缺少包名/spec" });

  const args = ["plugin", "--profile", profile, OP_ACTIONS[action]];
  if (spec) args.push(spec);

  const send = openStream(res);
  send("info", `$ ${DSH_BIN} ${args.join(" ")}`);

  let child;
  try {
    child = spawn(DSH_BIN, args, {
      cwd: process.cwd(),
      env: { ...process.env, DSH_HOME },
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
  } catch (error) {
    send("error", `无法启动 ${DSH_BIN}：${error.message}`);
    send("exit", 1);
    return res.end();
  }

  child.stdout.on("data", (chunk) => send("stdout", chunk.toString()));
  child.stderr.on("data", (chunk) => send("stderr", chunk.toString()));
  child.on("error", (error) => {
    if (error.code === "ENOENT") {
      send("error", `找不到 dsh 命令（${DSH_BIN}）。请确认已安装 dsh，或设置 DSH_BIN 环境变量。`);
    } else {
      send("error", error.message);
    }
  });
  child.on("close", (code) => {
    send(code === 0 ? "ok" : "stderr", `退出码：${code}`);
    send("exit", code);
    dumpCache.delete(profile); // 生效树可能变化，失效条目缓存
    res.end();
  });
}

/** 重排 profile 的 bundle 层顺序（写入 package.json 的 dsh.profile.bundles）。 */
function handleReorder(req, res) {
  readJsonBody(req).then((parsed) => {
    if (!parsed) return sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" });
    const { profile, names } = parsed;
    if (!profile || !Array.isArray(names)) return sendJson(res, 400, { ok: false, error: "需要 profile 与 names 数组" });
    try {
      const dir = join(PROFILES_DIR, profile);
      const manifest = readJson(join(dir, "package.json"));
      if (!manifest) throw new Error("profile 未初始化（缺少 package.json）");
      const current = manifest.dsh?.profile?.bundles ?? [];
      if (current.length !== names.length || !current.every((n) => names.includes(n))) {
        throw new Error("新的顺序必须与当前 bundle 列表是同一组名字（不允许增删）");
      }
      manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...names] } };
      atomicWrite(join(dir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
      sendJson(res, 200, { ok: true, bundles: names });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
  });
}

/** 临时禁用插件：向 profile 的 cordis.patch.yml 追加 { id, name, disabled: true }。 */
function handleDisable(req, res) {
  readJsonBody(req).then((parsed) => {
    if (!parsed) return sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" });
    const { profile, name } = parsed;
    if (!profile || !name) return sendJson(res, 400, { ok: false, error: "需要 profile 与 name" });
    try {
      const dir = join(PROFILES_DIR, profile);
      const patchPath = join(dir, "cordis.patch.yml");
      if (!existsSync(patchPath)) throw new Error("该 profile 没有 cordis.patch.yml，无法写入禁用补丁");
      const patchContent = readFileSync(patchPath, "utf8");
      const ids = (entryIdsByName(profile, dir, patchContent).get(name) ?? []).filter(Boolean);
      if (ids.length === 0) {
        throw new Error(`找不到「${name}」在生效插件树中的条目 id，无法禁用（它可能没有注册任何插件条目）`);
      }
      const sidecar = readSidecar(dir);
      if (sidecar.disables[name]) throw new Error(`「${name}」已处于禁用状态`);

      const lines = [`# dsh-plugin-manager-disable: ${name}`];
      for (const id of ids) {
        lines.push(`- id: ${id}`, `  name: '${yamlSingleQuote(name)}'`, "  disabled: true");
      }
      const block = lines.join("\n") + "\n";
      const appended = (patchContent.endsWith("\n") ? patchContent : patchContent + "\n") + block;
      atomicWrite(patchPath, appended);

      sidecar.disables[name] = { ids, block };
      writeSidecar(dir, sidecar);
      dumpCache.delete(profile);
      sendJson(res, 200, { ok: true, ids });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
  });
}

/** 重新启用插件：从 cordis.patch.yml 移除管理器写入的禁用补丁。 */
function handleEnable(req, res) {
  readJsonBody(req).then((parsed) => {
    if (!parsed) return sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" });
    const { profile, name } = parsed;
    if (!profile || !name) return sendJson(res, 400, { ok: false, error: "需要 profile 与 name" });
    try {
      const dir = join(PROFILES_DIR, profile);
      const patchPath = join(dir, "cordis.patch.yml");
      const sidecar = readSidecar(dir);
      const record = sidecar.disables[name];
      if (!record) throw new Error(`「${name}」未被禁用`);
      const content = readFileSync(patchPath, "utf8");
      if (!content.includes(record.block)) {
        throw new Error("cordis.patch.yml 内容与禁用记录不一致（可能被手动编辑过），请人工检查该文件");
      }
      atomicWrite(patchPath, content.replace(record.block, ""));
      delete sidecar.disables[name];
      writeSidecar(dir, sidecar);
      dumpCache.delete(profile);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
  });
}

// ────────────────────────────────────────────────────────────────────────────
// 静态资源
// ────────────────────────────────────────────────────────────────────────────

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/** 内嵌 HTML（在 SEA 打包时由构建脚本注入，支持单二进制独立运行）。若本地有 public/index.html 则优先读本地。 */
const EMBEDDED_INDEX_HTML = typeof __EMBEDDED_INDEX_HTML__ !== "undefined" ? __EMBEDDED_INDEX_HTML__ : "";

function serveStatic(res, pathname) {
  const safe = pathname === "/" ? "/index.html" : pathname;
  const file = join(PUBLIC_DIR, safe);
  if (file.startsWith(PUBLIC_DIR) && existsSync(file)) {
    const body = readFileSync(file);
    const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Content-Length": body.length,
    });
    return res.end(body);
  }

  // 兜底：如果是访问根路径或 index.html，且存在内嵌 HTML（SEA 单文件运行时）
  if ((safe === "/index.html" || safe === "/") && typeof EMBEDDED_INDEX_HTML === "string" && EMBEDDED_INDEX_HTML.length > 0) {
    const buf = Buffer.from(EMBEDDED_INDEX_HTML, "utf8");
    res.writeHead(200, {
      "Content-Type": MIME[".html"],
      "Content-Length": buf.length,
    });
    return res.end(buf);
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("404 Not Found");
}

// ────────────────────────────────────────────────────────────────────────────
// 服务器
// ────────────────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  try {
    if (url.pathname === "/api/state" && req.method === "GET") {
      return sendJson(res, 200, { ok: true, ...getState() });
    }
    if (url.pathname === "/api/restart" && req.method === "POST") {
      return await handleRestart(req, res);
    }
    if (url.pathname === "/api/stop" && req.method === "POST") {
      return await handleStop(req, res);
    }
    if (url.pathname === "/api/plugins" && req.method === "POST") {
      return await handlePluginOp(req, res);
    }
    if (url.pathname === "/api/reorder" && req.method === "POST") {
      return handleReorder(req, res);
    }
    if (url.pathname === "/api/disable" && req.method === "POST") {
      return handleDisable(req, res);
    }
    if (url.pathname === "/api/enable" && req.method === "POST") {
      return handleEnable(req, res);
    }
    if (req.method === "GET") {
      return serveStatic(res, url.pathname);
    }
    return sendJson(res, 405, { ok: false, error: "方法不允许" });
  } catch (error) {
    if (!res.headersSent) return sendJson(res, 500, { ok: false, error: String(error) });
    res.end();
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`\n  DSH 插件管理器已启动`);
  console.log(`  ─────────────────────`);
  console.log(`  ${url}`);
  console.log(`  DSH_HOME : ${DSH_HOME}`);
  console.log(`  dsh 命令 : ${DSH_BIN}`);
  const running = findDshWeb();
  console.log(`  dsh web  : ${running.length ? `运行中（PID ${running.map((p) => p.pid).join(", ")}）` : "未运行"}`);
  console.log(`  dsh URL  : ${detectWebUrl()}`);
  console.log(``);
});
