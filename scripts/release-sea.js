import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, "..");
const relReleaseDir = "release/sea";
const releaseDir = join(projectRoot, relReleaseDir);

function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

async function buildSea() {
  try {
    console.log("==================================================");
    console.log("  正在构建 DSH 插件管理器 SEA 单文件程序...");
    console.log("==================================================");

    console.log("\n[1/7] 准备输出目录...");
    if (existsSync(releaseDir)) {
      rmSync(releaseDir, { recursive: true, force: true });
    }
    ensureDir(releaseDir);

    console.log("[2/7] 读取前端静态页面并使用 esbuild 打包...");
    const htmlPath = join(projectRoot, "public", "index.html");
    const htmlContent = existsSync(htmlPath) ? readFileSync(htmlPath, "utf8") : "";

    // 准备内联了 HTML 的临时入口，避免命令行长度限制与转义问题
    const tempEntryPath = join(releaseDir, "entry.temp.js");
    let serverCode = readFileSync(join(projectRoot, "server.js"), "utf8");
    serverCode = serverCode.replace(
      'const EMBEDDED_INDEX_HTML = typeof __EMBEDDED_INDEX_HTML__ !== "undefined" ? __EMBEDDED_INDEX_HTML__ : "";',
      `const EMBEDDED_INDEX_HTML = ${JSON.stringify(htmlContent)};`
    );
    writeFileSync(tempEntryPath, serverCode, "utf8");

    const bundlePath = `${relReleaseDir}/server.bundle.cjs`;
    execSync(
      `npx -y esbuild "${relReleaseDir}/entry.temp.js" --bundle --platform=node --target=node20 --outfile=${bundlePath} --format=cjs --packages=bundle --define:import.meta.dirname=__dirname --define:import.meta.url=__import_meta_url --banner:js="var __import_meta_url = typeof __filename !== 'undefined' && __filename ? require('url').pathToFileURL(__filename).href : 'file:///'; var __dirname = typeof __dirname !== 'undefined' ? __dirname : '/';"`,
      { stdio: "inherit", cwd: projectRoot }
    );

    console.log("[3/7] 生成 SEA 配置与 Blob...");
    const seaConfig = {
      main: bundlePath,
      output: `${relReleaseDir}/sea-prep.blob`,
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
    };
    writeFileSync(join(projectRoot, `${relReleaseDir}/sea-config.json`), JSON.stringify(seaConfig, null, 2));
    execSync(`node --experimental-sea-config ${relReleaseDir}/sea-config.json`, {
      stdio: "inherit",
      cwd: projectRoot,
    });

    console.log("[4/7] 准备可执行二进制文件...");
    const nodeBin = process.execPath;
    const exeName = process.platform === "win32" ? "dsh-plugin-manager.exe" : "dsh-plugin-manager";
    const targetExe = join(releaseDir, exeName);
    copyFileSync(nodeBin, targetExe);

    console.log("[5/7] 处理代码签名与 Blob 注入...");
    if (process.platform === "win32") {
      try {
        execSync(`signtool remove /s "${targetExe}"`, { stdio: "ignore", cwd: projectRoot });
      } catch {
        // signtool 可能未在 PATH 中，postject 的 --overwrite 会继续尝试
      }
    } else if (process.platform === "darwin") {
      try {
        execSync(`codesign --remove-signature "${targetExe}"`, { stdio: "ignore", cwd: projectRoot });
      } catch {
        // 忽略
      }
    }

    const machoFlags = process.platform === "darwin" ? "--macho-segment-name NODE_SEA" : "";
    execSync(
      `npx -y postject "${targetExe}" NODE_SEA_BLOB "${relReleaseDir}/sea-prep.blob" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 ${machoFlags} --overwrite`,
      { stdio: "inherit", cwd: projectRoot }
    );

    if (process.platform !== "win32") {
      try {
        chmodSync(targetExe, 0o755);
      } catch {}
      if (process.platform === "darwin") {
        try {
          execSync(`codesign -s - "${targetExe}"`, { stdio: "ignore", cwd: projectRoot });
        } catch {}
      }
    }

    console.log("[6/7] 生成启动引导脚本...");
    if (process.platform === "win32") {
      const cmdContent = [
        "@echo off",
        "chcp 65001 >nul",
        "title DSH 插件管理器",
        'cd /d "%~dp0"',
        "echo ==================================================",
        "echo   正在启动 DSH 插件管理器 (SEA 单文件独立版)...",
        "echo ==================================================",
        'start "" http://127.0.0.1:3929',
        "dsh-plugin-manager.exe",
        "if %errorlevel% neq 0 (",
        "  echo.",
        "  echo [提示] 程序已退出，按任意键关闭窗口...",
        "  pause >nul",
        ")",
        "",
      ].join("\r\n");
      writeFileSync(join(releaseDir, "start.cmd"), cmdContent);
    } else {
      const shContent = [
        "#!/usr/bin/env bash",
        'DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"',
        'cd "$DIR"',
        'echo "=================================================="',
        'echo "  正在启动 DSH 插件管理器 (SEA 单文件独立版)..."',
        'echo "=================================================="',
        "which open >/dev/null 2>&1 && open http://127.0.0.1:3929 &",
        "./dsh-plugin-manager",
        "EXIT_CODE=$?",
        "if [ $EXIT_CODE -ne 0 ]; then",
        '  echo ""',
        '  echo "[提示] 程序异常退出 (ExitCode: $EXIT_CODE)"',
        '  read -p "按回车键关闭..."',
        "fi",
      ].join("\n");
      const shPath = join(releaseDir, "start.command");
      writeFileSync(shPath, shContent, { mode: 0o755 });
    }

    console.log("[7/7] 清理临时中间构建文件...");
    const tempFiles = ["entry.temp.js", "server.bundle.cjs", "sea-prep.blob", "sea-config.json"];
    for (const file of tempFiles) {
      const p = join(releaseDir, file);
      if (existsSync(p)) rmSync(p);
    }

    if (process.argv.includes("--archive") || process.argv.includes("--zip")) {
      console.log("\n正在打包发布压缩包 (--archive)...");
      const arch = process.arch;
      if (process.platform === "win32") {
        const zipName = `dsh-plugin-manager-win32-${arch}.zip`;
        const zipPath = join(releaseDir, zipName);
        try {
          execSync(`tar.exe -a -cf "${zipPath}" -C "${releaseDir}" "${exeName}" "start.cmd"`, {
            stdio: "inherit",
            cwd: projectRoot,
          });
          console.log(`✅ 已生成发布包: ${zipPath}`);
        } catch (err) {
          console.error("生成 Windows 压缩包失败:", err.message);
        }
      } else {
        const platform = process.platform === "darwin" ? "darwin" : "linux";
        const tarName = `dsh-plugin-manager-${platform}-${arch}.tar.gz`;
        const zipName = `dsh-plugin-manager-${platform}-${arch}.zip`;
        const tarPath = join(releaseDir, tarName);
        const zipPath = join(releaseDir, zipName);
        try {
          execSync(`tar -czvf "${tarPath}" -C "${releaseDir}" "${exeName}" "start.command"`, {
            stdio: "inherit",
            cwd: projectRoot,
          });
          console.log(`✅ 已生成发布包: ${tarPath}`);
        } catch {}
        try {
          execSync(`cd "${releaseDir}" && zip -q "${zipPath}" "${exeName}" "start.command"`, {
            stdio: "inherit",
            cwd: projectRoot,
          });
          console.log(`✅ 已生成发布包: ${zipPath}`);
        } catch {}
      }
    }

    console.log("\n==================================================");
    console.log("✅ 构建成功！");
    console.log(`成果物目录: ${releaseDir}`);
    console.log(`可执行程序: ${targetExe}`);
    console.log("==================================================");
  } catch (error) {
    console.error("❌ 构建过程中发生错误:", error);
    process.exit(1);
  }
}

buildSea();
