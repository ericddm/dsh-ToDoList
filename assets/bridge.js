/*
 * 「项目进度管理器」桥接脚本 —— 由宿主半身在响应时插入到 </body> 之前。
 * 原 HTML 文件不动：这里只做两件事。
 *   1. 在顶栏右侧补「导入 / 导出」两个按钮（备份、把旧浏览器里的数据搬过来）。
 *   2. 用弹窗搬运 localStorage 里的 sh-pm-v1，不依赖下载目录或剪贴板权限。
 */
(function () {
  'use strict';

  if (window.__dshProjectBoardBridge) return;
  window.__dshProjectBoardBridge = true;

  var LS_KEY = 'sh-pm-v1';
  var MAX_BYTES = 8 * 1024 * 1024;

  var CSS = [
    '.dsb-io{display:flex;gap:6px;margin-left:6px;flex:none}',
    '.dsb-io button{border:1px solid #57606a;background:rgba(255,255,255,.08);color:#adbac7;',
    'font-size:13px;line-height:1.4;padding:4px 10px;border-radius:6px;font-family:inherit;cursor:pointer}',
    '.dsb-io button:hover{background:rgba(255,255,255,.18);color:#fff}',
    '.dsb-mask{position:fixed;inset:0;z-index:400;background:rgba(0,0,0,.45);display:flex;',
    'align-items:center;justify-content:center;padding:24px}',
    '.dsb-box{width:min(760px,100%);max-height:calc(100vh - 48px);display:flex;flex-direction:column;',
    'background:#fff;color:#1f2328;border-radius:10px;overflow:hidden;',
    'box-shadow:0 16px 40px rgba(0,0,0,.3);',
    'font-family:"HarmonyOS Sans SC","Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}',
    '.dsb-head{display:flex;align-items:baseline;gap:10px;padding:16px 20px 12px;border-bottom:1px solid #d0d7de}',
    '.dsb-head b{font-size:16px;font-weight:600}',
    '.dsb-head span{font-size:12.5px;color:#656d76}',
    '.dsb-body{padding:14px 20px;display:flex;flex-direction:column;gap:10px;min-height:0;overflow:auto}',
    '.dsb-hint{font-size:13px;line-height:1.7;color:#656d76}',
    '.dsb-hint code{background:#eaeef2;border-radius:4px;padding:1px 5px;font-size:12px}',
    '.dsb-ta{width:100%;min-height:260px;resize:vertical;border:1px solid #d0d7de;border-radius:6px;',
    'padding:10px;font:12.5px/1.6 Consolas,"Courier New",monospace;color:#1f2328;background:#f6f8fa}',
    '.dsb-ta:focus{outline:2px solid #add8ff;border-color:#0969da;background:#fff}',
    '.dsb-foot{display:flex;align-items:center;gap:8px;padding:12px 20px 16px;border-top:1px solid #d0d7de}',
    '.dsb-foot .dsb-grow{flex:1}',
    '.dsb-btn{border:1px solid #d0d7de;background:#f6f8fa;color:#1f2328;font-size:13px;padding:6px 14px;',
    'border-radius:6px;font-family:inherit;cursor:pointer}',
    '.dsb-btn:hover{background:#eaeef2}',
    '.dsb-btn.primary{background:#1f883d;border-color:#1a7f37;color:#fff}',
    '.dsb-btn.primary:hover{background:#1a7f37}',
    '.dsb-msg{font-size:12.5px;line-height:1.6}',
    '.dsb-msg.err{color:#cf222e}',
    '.dsb-msg.ok{color:#1a7f37}',
  ].join('');

  function addStyle() {
    var tag = document.createElement('style');
    tag.setAttribute('data-dsh-todolist', 'bridge');
    tag.textContent = CSS;
    (document.head || document.documentElement).appendChild(tag);
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  /** 读出当前存储的数据对象；顺带容忍老版本只有数组的情况。 */
  function readState() {
    var raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    var data = JSON.parse(raw);
    if (Array.isArray(data)) data = { projects: data, activeId: null };
    if (!data || !Array.isArray(data.projects)) throw new Error('数据格式不对：缺少 projects 数组');
    return data;
  }

  function summarize(data) {
    var projects = (data && data.projects) || [];
    var tasks = 0;
    for (var i = 0; i < projects.length; i += 1) {
      tasks += (projects[i].items || []).length;
    }
    return projects.length + ' 个项目 / ' + tasks + ' 个任务';
  }

  function todayStamp() {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  function copyText(textarea, button) {
    var done = function () {
      var old = button.textContent;
      button.textContent = '已复制';
      setTimeout(function () { button.textContent = old; }, 1200);
    };
    var legacy = function () {
      try {
        textarea.focus();
        textarea.select();
        if (document.execCommand('copy')) { done(); return; }
      } catch (e) { /* 落到下面提示 */ }
      button.textContent = '请手动 Ctrl+C';
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(textarea.value).then(done, legacy);
      return;
    }
    legacy();
  }

  function download(text) {
    var blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = '项目管理器-数据-' + todayStamp() + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      try { a.remove(); URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
    }, 1000);
  }

  /** 弹窗骨架：mode = 'export' | 'import' */
  function openDialog(mode) {
    var mask = el('div', 'dsb-mask');
    var box = el('div', 'dsb-box');
    var head = el('div', 'dsb-head');
    head.appendChild(el('b', null, mode === 'export' ? '导出数据' : '导入数据'));
    head.appendChild(el('span', null, mode === 'export'
      ? 'JSON · 可复制或存成文件'
      : '粘贴或选择之前导出的 JSON'));

    var body = el('div', 'dsb-body');
    var hint = el('div', 'dsb-hint');
    var ta = el('textarea', 'dsb-ta');
    ta.spellcheck = false;

    var foot = el('div', 'dsb-foot');
    var msg = el('div', 'dsb-msg');
    var grow = el('div', 'dsb-grow');
    var fileInput = null;

    function close() {
      document.removeEventListener('keydown', onKey);
      if (mask.parentNode) mask.parentNode.removeChild(mask);
    }
    function onKey(event) {
      if (event.key === 'Escape') close();
    }

    function say(text, kind) {
      msg.textContent = text || '';
      msg.className = 'dsb-msg' + (kind ? ' ' + kind : '');
    }

    if (mode === 'export') {
      var data = null;
      try { data = readState(); } catch (error) { say(String(error.message || error), 'err'); }
      if (!data) {
        hint.textContent = '这个页面还没有存过数据（你在里面建过项目后就会有）。';
        ta.value = '';
        ta.readOnly = true;
        ta.style.minHeight = '80px';
      } else {
        ta.value = JSON.stringify(data, null, 2);
        ta.readOnly = true;
        hint.textContent = '当前共 ' + summarize(data) + '。复制或下载后，可在另一台机器 / 另一个页面用「导入」还原。';
      }
      var copyBtn = el('button', 'dsb-btn', '复制全部');
      copyBtn.addEventListener('click', function () {
        if (!ta.value) { say('没有可复制的数据。', 'err'); return; }
        copyText(ta, copyBtn);
      });
      var downBtn = el('button', 'dsb-btn', '下载 .json');
      downBtn.addEventListener('click', function () {
        if (!ta.value) { say('没有可下载的数据。', 'err'); return; }
        try { download(ta.value); say('已发起下载，浏览器可能弹保存框。', 'ok'); } catch (e) { say('下载失败，改用「复制全部」。', 'err'); }
      });
      foot.appendChild(copyBtn);
      foot.appendChild(downBtn);
      foot.appendChild(grow);
      foot.appendChild(msg);
      foot.appendChild(el('button', 'dsb-btn', '关闭')).addEventListener('click', close);
      body.appendChild(hint);
      body.appendChild(ta);
    } else {
      ta.placeholder = '把导出的 JSON 粘贴到这里…';
      hint.innerHTML = '导入会<b>整页覆盖</b>当前数据（原数据先导出就不怕）。也可以直接选一个之前下载的 <code>.json</code> 文件。';
      var pick = el('button', 'dsb-btn', '选择文件…');
      fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = '.json,application/json';
      fileInput.style.display = 'none';
      fileInput.addEventListener('change', function () {
        var file = fileInput.files && fileInput.files[0];
        if (!file) return;
        if (file.size > MAX_BYTES) { say('文件太大（超过 8MB），多半不是数据文件。', 'err'); return; }
        var reader = new FileReader();
        reader.onload = function () { ta.value = String(reader.result || ''); say('已读入「' + file.name + '」，检查无误后点「覆盖导入」。', 'ok'); };
        reader.onerror = function () { say('读取文件失败。', 'err'); };
        reader.readAsText(file, 'utf-8');
      });
      pick.addEventListener('click', function () { fileInput.click(); });

      var importBtn = el('button', 'dsb-btn primary', '覆盖导入');
      importBtn.addEventListener('click', function () {
        var text = ta.value.trim();
        if (!text) { say('还没有内容可导入。', 'err'); return; }
        var incoming;
        try { incoming = JSON.parse(text); } catch (e) { say('不是合法 JSON：' + e.message, 'err'); return; }
        if (Array.isArray(incoming)) incoming = { projects: incoming, activeId: null };
        if (!incoming || !Array.isArray(incoming.projects)) { say('数据格式不对：缺少 projects 数组。', 'err'); return; }
        var before = '';
        try { before = summarize(readState()) + ' → '; } catch (e) { /* 旧数据可能不存在 */ }
        var ok = window.confirm('确定覆盖导入？\n\n' + before + summarize(incoming) + '\n\n当前页面里的项目会被替换（已导出的另说）。');
        if (!ok) return;
        try {
          localStorage.setItem(LS_KEY, JSON.stringify(incoming));
        } catch (e) {
          say('写入失败：' + e.message, 'err');
          return;
        }
        say('导入成功，正在刷新…', 'ok');
        setTimeout(function () { location.reload(); }, 400);
      });

      foot.appendChild(pick);
      foot.appendChild(importBtn);
      foot.appendChild(grow);
      foot.appendChild(msg);
      foot.appendChild(el('button', 'dsb-btn', '关闭')).addEventListener('click', close);
      body.appendChild(hint);
      body.appendChild(ta);
      if (fileInput) box.appendChild(fileInput);
    }

    box.appendChild(head);
    box.appendChild(body);
    box.appendChild(foot);
    mask.appendChild(box);
    mask.addEventListener('click', function (event) { if (event.target === mask) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(mask);
    if (mode === 'import') setTimeout(function () { ta.focus(); }, 30);
  }

  function mount() {
    var header = document.querySelector('header');
    if (!header) return false;
    if (header.querySelector('.dsb-io')) return true;
    var group = el('div', 'dsb-io');
    var imp = el('button', null, '导入');
    var exp = el('button', null, '导出');
    imp.title = '从 JSON 还原数据（会覆盖当前数据）';
    exp.title = '把当前数据导出为 JSON';
    imp.addEventListener('click', function () { openDialog('import'); });
    exp.addEventListener('click', function () { openDialog('export'); });
    group.appendChild(imp);
    group.appendChild(exp);
    header.appendChild(group);
    return true;
  }

  addStyle();
  if (!mount()) {
    // 页面结构万一变了，也保证按钮还在：贴到右上角。
    document.addEventListener('DOMContentLoaded', function () {
      if (!mount()) {
        var group = el('div', 'dsb-io');
        group.style.cssText = 'position:fixed;top:10px;right:12px;z-index:200';
        var imp = el('button', null, '导入');
        var exp = el('button', null, '导出');
        imp.addEventListener('click', function () { openDialog('import'); });
        exp.addEventListener('click', function () { openDialog('export'); });
        group.appendChild(imp);
        group.appendChild(exp);
        document.body.appendChild(group);
      }
    });
  }
})();
