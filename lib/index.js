/**
 * dsh-todolist —— 「项目进度管理器」宿主半身。
 *
 * 这里不重写看板页面，而是在宿主的 webServer 上开一条同源路由，把一份 HTML 原样吐出去，
 * 由浏览器半身的 iframe 整块嵌进侧栏 —— 拖拽、甘特图定位、弹窗全部保持原样。
 *
 * 因为页面跑在 `dsh-app://app` 这个稳定源下（不是 file://，也不是每次都变的端口），
 * 页面自己的 `localStorage` 就能长期留住数据。
 *
 * 响应时只做一处改动：在 `</body>` 前插入 `assets/bridge.js`，给页面顶栏补上
 * 「导入 / 导出」两个按钮，用于备份与迁移。HTML 文件本身一个字节都不动。
 *
 * 页面来源按优先级取：
 *   1. 环境变量 DSH_TODOLIST_HTML（兼容旧的 DSH_PROJECT_BOARD_HTML）
 *   2. 插件目录下的 config.json  →  { "html": "D:\\某个目录\\index.html" }
 *   3. 插件自带的 assets/index.html
 * 前两者读不到时自动回落到第 3 项。
 *
 * 路由：
 *   GET /dsh-todolist/app       页面本体
 *   GET /dsh-todolist/bridge.js 注入脚本
 *   GET /dsh-todolist/status    排障用：当前用的是哪份 HTML
 *
 * @module dsh-todolist
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'todolist';
export const inject = [];

const PREFIX = '/dsh-todolist';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..');

const BUNDLED_HTML = join(PKG_ROOT, 'assets', 'index.html');
const BRIDGE_JS = join(PKG_ROOT, 'assets', 'bridge.js');
const CONFIG_JSON = join(PKG_ROOT, 'config.json');

const BRIDGE_TAG = '<script src="/dsh-todolist/bridge.js"></script>';

/** 环境变量优先级从高到低；第二个是为了兼容插件改名前的旧配置。 */
const ENV_KEYS = ['DSH_TODOLIST_HTML', 'DSH_PROJECT_BOARD_HTML'];

/** config.json 每次请求都重读：改完不用重启 DSH。 */
async function readConfigPage() {
  try {
    const raw = await readFile(CONFIG_JSON, 'utf8');
    const config = JSON.parse(raw);
    const candidate = config && (config.html || config.page || config.path);
    return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
  } catch {
    return null;
  }
}

/** 决定「用户指定的页面」是谁；没有指定就用自带副本。 */
async function resolveTarget() {
  for (const key of ENV_KEYS) {
    const value = (process.env[key] || '').trim();
    if (value) return { kind: 'env', key, path: resolve(value) };
  }
  const configured = await readConfigPage();
  if (configured) return { kind: 'config', path: resolve(configured) };
  return { kind: 'bundled', path: BUNDLED_HTML };
}

/** 先读用户指定的那份，读不到就回落到自带副本。 */
async function readPage() {
  const target = await resolveTarget();
  const candidates = target.kind === 'bundled'
    ? [{ path: BUNDLED_HTML, source: 'bundled' }]
    : [{ path: target.path, source: target.kind }, { path: BUNDLED_HTML, source: 'bundled' }];

  for (const candidate of candidates) {
    try {
      const html = await readFile(candidate.path, 'utf8');
      if (html && html.trim()) {
        return {
          html,
          source: candidate.source,
          path: candidate.path,
          target,
        };
      }
    } catch {
      /* 该路径不存在或不可读，试下一个 */
    }
  }
  return null;
}

/** 在最后一个 </body> 前插入桥接脚本；没有 </body> 就追加到末尾。 */
function withBridge(html) {
  const at = html.toLowerCase().lastIndexOf('</body>');
  if (at < 0) return `${html}\n${BRIDGE_TAG}\n`;
  return `${html.slice(0, at)}${BRIDGE_TAG}\n${html.slice(at)}`;
}

function send(res, status, type, body) {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function sendJson(res, status, body) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(body));
}

function sendText(res, status, body) {
  send(res, status, 'text/plain; charset=utf-8', body);
}

async function servePage(req, res) {
  const page = await readPage();
  if (!page) {
    sendText(res, 500, [
      '找不到项目进度管理器页面。',
      `当前配置：${(await resolveTarget()).path}`,
      `兜底副本：${BUNDLED_HTML}`,
    ].join('\n'));
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-dsh-todolist-source': page.source,
  });
  res.end(req.method === 'HEAD' ? undefined : withBridge(page.html));
}

async function serveBridge(res) {
  try {
    const js = await readFile(BRIDGE_JS, 'utf8');
    send(res, 200, 'application/javascript; charset=utf-8', js);
  } catch {
    sendText(res, 404, 'bridge.js 缺失');
  }
}

async function statusPayload() {
  const page = await readPage();
  const target = await resolveTarget();
  return {
    ok: Boolean(page),
    prefix: PREFIX,
    page: page ? page.path : null,
    source: page ? page.source : null,
    requested: { kind: target.kind, path: target.path },
    bundled: BUNDLED_HTML,
    config: CONFIG_JSON,
    bytes: page ? Buffer.byteLength(page.html, 'utf8') : 0,
  };
}

async function handle(req, res) {
  const url = new URL(req.url || PREFIX, 'http://127.0.0.1');
  const path = url.pathname.replace(/\/+$/u, '') || PREFIX;

  if (path === `${PREFIX}/status`) {
    sendJson(res, 200, await statusPayload());
    return;
  }
  if (path === `${PREFIX}/bridge.js`) {
    await serveBridge(res);
    return;
  }
  if (path === PREFIX || path === `${PREFIX}/app`) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, '只支持 GET');
      return;
    }
    await servePage(req, res);
    return;
  }
  if (path === `${PREFIX}/favicon.ico`) {
    res.writeHead(204, { 'cache-control': 'no-store' });
    res.end();
    return;
  }
  sendText(res, 404, `未知路径：${url.pathname}`);
}

export function apply(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: PREFIX,
      handler: handle,
    }), 'dsh-todolist: page route');
  });
}
