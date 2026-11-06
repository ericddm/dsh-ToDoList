// 假 DOM 测试：验证注入到页面里的 bridge.js（顶栏导入/导出）真的能用。
// 用法：node test/bridge-dom.mjs（零依赖，不需要真的浏览器）
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = readFileSync(join(ROOT, 'assets', 'bridge.js'), 'utf8');
const fails = [];
const check = (name, cond, detail) => {
  if (cond) console.log('  ok   ' + name);
  else { console.log('  FAIL ' + name + (detail ? '  → ' + detail : '')); fails.push(name); }
};

const btn = (root, label) => {
  const walk = (n) => {
    for (const c of n.children) {
      if (c.tagName === 'BUTTON' && c.textContent === label) return c;
      const hit = walk(c);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root);
};

// ---------- 假 DOM ----------
function makeNode(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    className: '',
    textContent: '',
    value: '',
    readOnly: false,
    title: '',
    placeholder: '',
    type: '',
    accept: '',
    href: '',
    download: '',
    style: {},
    children: [],
    attrs: {},
    parentNode: null,
    listeners: {},
    appendChild(child) { child.parentNode = node; node.children.push(child); return child; },
    removeChild(child) {
      const i = node.children.indexOf(child);
      if (i >= 0) node.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    remove() { if (node.parentNode) node.parentNode.removeChild(node); },
    setAttribute(k, v) { node.attrs[k] = v; },
    addEventListener(type, fn) { (node.listeners[type] = node.listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const list = node.listeners[type] || [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    dispatch(type, event) { (node.listeners[type] || []).slice().forEach((fn) => fn(event || { target: node })); },
    click() { node.dispatch('click', { target: node }); },
    focus() {},
    select() {},
    querySelector(sel) {
      if (!sel.startsWith('.')) return null;
      const cls = sel.slice(1);
      const walk = (n) => {
        for (const c of n.children) {
          if ((c.className || '').split(/\s+/).includes(cls)) return c;
          const hit = walk(c);
          if (hit) return hit;
        }
        return null;
      };
      return walk(node);
    },
  };
  return node;
}

const html = makeNode('html');
const head = makeNode('head');
const body = makeNode('body');
const header = makeNode('header');
html.appendChild(head);
html.appendChild(body);
body.appendChild(header);

const documentListeners = {};
const document = {
  head, body, documentElement: html,
  createElement: (tag) => makeNode(tag),
  querySelector(sel) { return sel === 'header' ? header : null; },
  addEventListener(type, fn) { (documentListeners[type] = documentListeners[type] || []).push(fn); },
  removeEventListener(type, fn) {
    const list = documentListeners[type] || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  },
  dispatch(type, event) { (documentListeners[type] || []).slice().forEach((fn) => fn(event || {})); },
  execCommand() { return true; },
};

// ---------- 假存储 / 浏览器 API ----------
const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
};

let reloaded = 0;
const location = { reload() { reloaded += 1; } };
let confirmAnswer = true;
const confirmCalls = [];
const timers = [];
const sandbox = {
  window: null,
  document,
  localStorage,
  location,
  navigator: { clipboard: { writeText: () => Promise.resolve() } },
  Blob: class { constructor(parts) { this.parts = parts; } },
  URL: { createObjectURL: () => 'blob:fake', revokeObjectURL() {} },
  FileReader: class { readAsText() { sandbox.__reader = this; } },
  confirm: (text) => { confirmCalls.push(text); return confirmAnswer; },
  setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  console,
};
sandbox.window = sandbox;
sandbox.window.confirm = sandbox.confirm;
sandbox.window.localStorage = localStorage;
sandbox.window.location = location;
sandbox.__reader = null;

const ctx = createContext(sandbox);
runInContext(SRC, ctx);

// ---------- 断言 ----------
const group = header.querySelector('.dsb-io');
check('顶栏挂上 .dsb-io', Boolean(group));
check('.dsb-io 有两个按钮', group && group.children.length === 2, String(group && group.children.length));
check('按钮是「导入」「导出」', group && group.children[0].textContent === '导入' && group.children[1].textContent === '导出');
check('插了 bridge 样式表', head.children.some((n) => n.tagName === 'STYLE' && n.attrs['data-dsh-todolist'] === 'bridge'));
check('重复执行不会重复挂', (() => { runInContext(SRC, ctx); return header.querySelector('.dsb-io').children.length === 2; })());

// 空数据时打开导出
group.children[1].click();
let mask = body.children.find((n) => n.className === 'dsb-mask');
check('导出弹窗打开', Boolean(mask));
let ta = mask && mask.querySelector('.dsb-ta');
check('导出框只读', ta && ta.readOnly === true);
check('空数据有提示', mask && mask.querySelector('.dsb-hint').textContent.includes('还没有存过数据'));
btn(mask, '关闭').click();
check('关闭按钮移除弹窗', !body.children.some((n) => n.className === 'dsb-mask'));

// 有数据时的导出内容
const sample = {
  projects: [{
    id: 'p1', name: '甲', createdAt: 1,
    items: [
      { id: 'i1', title: 'a', due: '', col: 0, createdAt: 1 },
      { id: 'i2', title: 'b', due: '', col: 1, createdAt: 1 },
    ],
  }],
  activeId: 'p1',
};
store.set('sh-pm-v1', JSON.stringify(sample));
group.children[1].click();
mask = body.children.find((n) => n.className === 'dsb-mask');
ta = mask.querySelector('.dsb-ta');
check('导出内容是完整 JSON', (() => { try { return JSON.parse(ta.value).projects[0].name === '甲'; } catch { return false; } })());
check('导出提示带统计', mask.querySelector('.dsb-hint').textContent.includes('1 个项目 / 2 个任务'), mask.querySelector('.dsb-hint').textContent);
btn(mask, '下载 .json').click();
check('下载提示已发起', mask.querySelector('.dsb-msg').textContent.includes('已发起下载'), mask.querySelector('.dsb-msg').textContent);
mask.remove();

// 导入：合法数据
group.children[0].click();
mask = body.children.find((n) => n.className === 'dsb-mask');
check('导入弹窗打开', Boolean(mask));
ta = mask.querySelector('.dsb-ta');
check('导入框可编辑', ta.readOnly === false);
const next = { projects: [{ id: 'p9', name: '乙', createdAt: 2, items: [{ id: 'x', title: 'c', due: '', col: 3, createdAt: 2 }] }], activeId: 'p9' };
ta.value = JSON.stringify(next);
const importBtn = btn(mask, '覆盖导入');
check('有「覆盖导入」按钮', Boolean(importBtn));
importBtn.click();
check('确认框显示了前后对比',
  confirmCalls.length === 1 && confirmCalls[0].includes('1 个项目 / 2 个任务') && confirmCalls[0].includes('1 个项目 / 1 个任务'),
  confirmCalls[0]);
check('写入了新数据', JSON.parse(store.get('sh-pm-v1')).projects[0].name === '乙');
check('提示导入成功', mask.querySelector('.dsb-msg').textContent.includes('导入成功'));
timers.forEach((t) => t.fn());
check('之后会刷新页面', reloaded === 1, String(reloaded));

// 导入：坏 JSON
mask.remove();
group.children[0].click();
mask = body.children.find((n) => n.className === 'dsb-mask');
mask.querySelector('.dsb-ta').value = '{ 坏数据 ';
btn(mask, '覆盖导入').click();
const msg = mask.querySelector('.dsb-msg');
check('坏 JSON 报错且不覆盖',
  msg.textContent.includes('不是合法 JSON') && JSON.parse(store.get('sh-pm-v1')).projects[0].name === '乙',
  msg.textContent);

// 取消确认
mask.remove();
confirmAnswer = false;
group.children[0].click();
mask = body.children.find((n) => n.className === 'dsb-mask');
mask.querySelector('.dsb-ta').value = JSON.stringify({ projects: [], activeId: null });
btn(mask, '覆盖导入').click();
check('取消后不覆盖', JSON.parse(store.get('sh-pm-v1')).projects[0].name === '乙');

// Esc 关闭
mask.remove();
confirmAnswer = true;
group.children[0].click();
document.dispatch('keydown', { key: 'Escape' });
check('Esc 关闭弹窗', !body.children.some((n) => n.className === 'dsb-mask'));

console.log(fails.length ? `\n${fails.length} 项失败` : '\n全部通过');
process.exitCode = fails.length ? 1 : 0;
