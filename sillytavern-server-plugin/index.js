/**
 * SillyTavern 服务端插件入口(CommonJS)。
 * 职责:随酒馆启动拉起 proxy.js,酒馆退出时关掉它。
 * 安装:整个目录放到 <SillyTavern>/plugins/st-lite-agent/ 并执行 npm install --omit=dev。
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

let child = null;

function startProxy() {
  if (child) return;
  const proxy = path.join(__dirname, 'proxy.js');
  child = spawn(process.execPath, [proxy], {
    cwd: __dirname,
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.on('error', (err) => console.error('[st-lite-agent] proxy 启动失败:', err));
  child.on('exit', (code, signal) => {
    console.log('[st-lite-agent] proxy 已退出 code=' + code + ' signal=' + signal);
    child = null;
  });
}

function stopProxy() {
  if (!child) return;
  child.kill('SIGTERM');
  child = null;
}

module.exports = {
  info: {
    name: 'st-lite-agent(服务端)',
    description: '随酒馆启动/关闭 OpenAI 兼容轻量转发服务',
  },
  init() {
    startProxy();
    console.log('[st-lite-agent] 插件已初始化,proxy 由酒馆托管');
  },
  exit() {
    stopProxy();
    console.log('[st-lite-agent] 插件已退出,proxy 已停止');
  },
};

