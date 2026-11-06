// 冒烟测试：不装插件、不开 DSH，直接验证宿主半身的路由输出与浏览器半身的注册结果。
// 用法：node test/smoke.mjs（零依赖）
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, existsSync, unlinkSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const FIXTURE = join(ROOT, 'test', 'fixtures', 'page.html');
const CONFIG = join(ROOT, 'config.json');
const CONFIG_BAK = join(ROOT, 'config.json.smoke-bak');

const fails = [];
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name);
  else { console.log('  FAIL ' + name + (detail ? '  →  ' + detail : '')); fails.push(name); }
}

// ---------- 宿主半身 ----------
const host = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href);
const routes = [];
host.apply({
  inject(services, fn) {
    fn({
      effect(fn2) { fn2(); return () => {}; },
      webServer: { register(route) { routes.push(route); return () => {}; } },
    });
  },
  effect(fn) { fn(); },
});

check('宿主注册了 1 条路由', routes.length === 1, JSON.stringify(routes.map((r) => r.path)));
check('路由是 prefix /dsh-todolist', routes[0]?.kind === 'prefix' && routes[0]?.path === '/dsh-todolist');

function fakeRes() {
  const res = {
    status: 0, headers: null, body: '',
    writeHead(s, h) { res.status = s; res.headers = h; },
    end(b) { res.body = b == null ? '' : String(b); },
  };
  return res;
}

async function call(url, method = 'GET') {
  const res = fakeRes();
  await routes[0].handler({ url, method, headers: { host: 'dsh-app://app' } }, res);
  return res;
}

// 环境变量优先级最高：指向哪个文件就服务哪个。
process.env.DSH_TODOLIST_HTML = FIXTURE;
const custom = await call('/dsh-todolist/app');
check('自定义页面 200', custom.status === 200, String(custom.status));
check('自定义页面内容正确', custom.body.includes('CUSTOM-PAGE-FIXTURE'));
check('来源标记 env', custom.headers['x-dsh-todolist-source'] === 'env', custom.headers['x-dsh-todolist-source']);
check('自定义页面也注入了 bridge', custom.body.includes('<script src="/dsh-todolist/bridge.js"></script>'));

// 指向一个不存在的路径 → 回落到自带的 assets/index.html
process.env.DSH_TODOLIST_HTML = join(ROOT, 'test', 'fixtures', 'does-not-exist.html');
const fallback = await call('/dsh-todolist/app');
check('路径不存在时回落到自带页面', fallback.status === 200 && fallback.body.includes('项目管理器'));
check('来源标记 bundled', fallback.headers['x-dsh-todolist-source'] === 'bundled', fallback.headers['x-dsh-todolist-source']);

// config.json：没有环境变量时生效
// （真实用户可能已经有自己的 config.json，先挪开，保证测试可重复）
delete process.env.DSH_TODOLIST_HTML;
const hadConfig = existsSync(CONFIG);
if (hadConfig) renameSync(CONFIG, CONFIG_BAK);
writeFileSync(CONFIG, JSON.stringify({ html: FIXTURE }), 'utf8');
const viaConfig = await call('/dsh-todolist/app');
check('config.json 生效', viaConfig.body.includes('CUSTOM-PAGE-FIXTURE'));
check('来源标记 config', viaConfig.headers['x-dsh-todolist-source'] === 'config', viaConfig.headers['x-dsh-todolist-source']);
unlinkSync(CONFIG);

// 没有任何配置 → 用自带页面（仓库默认状态；此时 config.json 已挪开）
const bundled = await call('/dsh-todolist/app');
check('默认用自带页面', bundled.status === 200 && bundled.headers['x-dsh-todolist-source'] === 'bundled');
check('自带页面内容正常', bundled.body.includes('项目管理器') && bundled.body.includes('sh-pm-v1'));
check('content-type 是 utf-8 html', /text\/html; charset=utf-8/.test(bundled.headers['content-type'] || ''));
check('no-store', bundled.headers['cache-control'] === 'no-store');
check('bridge 在 </body> 之前', bundled.body.indexOf('bridge.js') < bundled.body.lastIndexOf('</body>'));
check('字节数大于原文件', Buffer.byteLength(bundled.body, 'utf8') > readFileSync(join(ROOT, 'assets', 'index.html')).length);

const bridge = await call('/dsh-todolist/bridge.js');
check('bridge.js 200', bridge.status === 200);
check('bridge.js 是 js', /application\/javascript/.test(bridge.headers['content-type'] || ''));
check('bridge.js 有导入导出逻辑', bridge.body.includes('localStorage') && bridge.body.includes('sh-pm-v1'));

const status = await call('/dsh-todolist/status');
check('status 200', status.status === 200);
const st = JSON.parse(status.body);
check('status.ok', st.ok === true, JSON.stringify(st));
check('status 指向自带页面', String(st.page).endsWith(join('assets', 'index.html')), st.page);
check('status 带 requested/bundled', Boolean(st.requested && st.bundled));

// 把用户自己的 config.json 放回去
if (hadConfig) renameSync(CONFIG_BAK, CONFIG);

const missing = await call('/dsh-todolist/nope');
check('未知路径 404', missing.status === 404, String(missing.status));

const post = await call('/dsh-todolist/app', 'POST');
check('POST 405', post.status === 405, String(post.status));

const favicon = await call('/dsh-todolist/favicon.ico');
check('favicon 204', favicon.status === 204, String(favicon.status));

// ---------- 浏览器半身 ----------
const mainRegs = [];
const navRegs = [];
function slotCtx() {
  return {
    effect(fn) { fn(); },
    slots: {
      inject(name, fn) { fn(); },
      register(options, component) {
        const entry = { options, component };
        if (options.name === 'main') mainRegs.push(entry); else navRegs.push(entry);
        return () => {};
      },
    },
  };
}

// 极简 React 替身：够验证组件树结构，不渲染真实 DOM。
function makeReact() {
  return {
    createElement(tag, props, ...children) {
      if (tag === 'Fragment') return { type: 'fragment', props: props || {}, children };
      return { type: tag, props: props || {}, children };
    },
    useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}]; },
    useEffect() {},
    Component: class { constructor(props) { this.props = props; this.state = {}; } },
  };
}
globalThis.window = { __ModuleLoader__: { load({ id, factory }) { globalThis.__loaded = { id, mod: factory(() => makeReact()) }; } } };
globalThis.document = { head: { appendChild() {} }, createElement() { return { setAttribute() {}, remove() {} }; } };

await import(pathToFileURL(join(ROOT, 'lib', 'client.js')).href);
const client = globalThis.__loaded?.mod;
check('client 模块导出', Boolean(client), 'factory 没跑');
check('client name', client?.name === 'todolist-client', client?.name);
check('client inject slots', Array.isArray(client?.inject) && client.inject.includes('slots'));
client?.apply?.(slotCtx());

check('注册了 main 面板', mainRegs.length === 1, String(mainRegs.length));
check('main key = dsh-todolist.board', mainRegs[0]?.options.key === 'dsh-todolist.board', mainRegs[0]?.options.key);
check('注册了侧栏项', navRegs.length === 1, String(navRegs.length));
check('侧栏 order = -9（日程 -10 之下）', navRegs[0]?.options.order === -9, String(navRegs[0]?.options.order));
check('侧栏 label', navRegs[0]?.options.label === 'ToDoList', navRegs[0]?.options.label);
check('侧栏 id 与 main key 一致', navRegs[0]?.options.id === mainRegs[0]?.options.key);

// 侧栏图标：注册的是 wrapper，真正的 svg 由它内部的图标组件产出。
const iconEl = navRegs[0]?.component({ size: 18 });
check('侧栏图标元素指向图标组件', typeof iconEl?.type === 'function' && iconEl?.props?.size === 18);
const icon = iconEl.type(iconEl.props);
check('图标是 svg', icon?.type === 'svg' && icon.props.width === 18);
check('图标取 size 缺省 18', iconEl.type({})?.props?.width === 18);

const tree = mainRegs[0]?.component({});
check('面板根节点是错误边界组件', typeof tree?.type === 'function', String(tree?.type));
const inner = tree?.children?.[0];
check('边界内是 BoardPage', inner && inner.type === client.__parts.BoardPage, String(inner && inner.type && inner.type.name));
const pageTree = client.__parts.BoardPage({});
check('页面根 class dshtl', pageTree?.props?.className === 'dshtl', pageTree?.props?.className);
const frame = pageTree.children.find((c) => c && c.type === 'iframe');
check('内嵌 iframe', Boolean(frame));
check('iframe src 指向同源路由', frame?.props?.src === '/dsh-todolist/app', frame?.props?.src);
check('iframe 无 sandbox（同源自家页面）', frame?.props?.sandbox === undefined);

console.log(fails.length ? `\n${fails.length} 项失败` : '\n全部通过');
process.exitCode = fails.length ? 1 : 0;
