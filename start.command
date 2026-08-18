#!/bin/bash

# 切换到脚本所在目录
cd "$(dirname "$0")" || exit 1

# 加载 NVM（如果存在）
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck source=/dev/null
  \. "$NVM_DIR/nvm.sh"
fi

# 补充 macOS 常见环境路径（Homebrew、pnpm、cargo、local bin 等）
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:$HOME/.local/bin:$HOME/.cargo/bin:$HOME/Library/pnpm:$PATH"

# 如果未找到 node，尝试从 zsh 环境变量读取
if ! command -v node >/dev/null 2>&1; then
  if [ -f "$HOME/.zshrc" ]; then
    NODE_PATH_EXTRACT=$(zsh -i -c 'echo $PATH' 2>/dev/null)
    if [ -n "$NODE_PATH_EXTRACT" ]; then
      export PATH="$NODE_PATH_EXTRACT:$PATH"
    fi
  fi
fi

# 检查 Node.js 是否可用
if ! command -v node >/dev/null 2>&1; then
  echo "=================================================="
  echo "❌ 错误: 未检测到 Node.js 环境！"
  echo "请确保已安装 Node.js 并配置环境变量。"
  echo "=================================================="
  echo "按回车键退出..."
  read -r
  exit 1
fi

echo "=================================================="
echo "🚀 正在启动 DSH 插件管理器..."
echo "=================================================="

# 自动在默认浏览器中打开页面（后台延时 1 秒等待服务监听）
(sleep 1 && open "http://127.0.0.1:3929") &

# 启动 Node.js 服务
node server.js
