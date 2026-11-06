// 「项目进度管理器」浏览器半身 —— 手写 lazy-CJS bundle，无需构建工具。
// 面板本体是一个同源 iframe，指向宿主半身托管的页面：
// 看板 / 甘特图 / 拖拽 / 弹窗都跑在 iframe 里，一行没重写；
// 数据落在 dsh-app://app 这个稳定源下的 localStorage，重开应用还在。
(function () {
  window.__ModuleLoader__.load({
    id: 'dsh-todolist',
    factory: (require) => {
      const module = { exports: {} };
      const exports = module.exports;
      const React = require('react');
      const h = React.createElement;

      /** 宿主半身（lib/index.js）注册的同源路由。 */
      const PAGE_SRC = '/dsh-todolist/app';

      const CSS = `
.dshtl{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;background:#f6f8fa;overflow:hidden}
.dshtl-frame{flex:1;display:block;width:100%;height:100%;min-height:0;border:0;background:#f6f8fa}
.dshtl-state{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:24px;text-align:center;background:#f6f8fa;color:#57606a;font:13px/1.7 var(--dsh-font-family-content,system-ui,"Microsoft YaHei",sans-serif)}
.dshtl-state a{color:#0969da;text-decoration:none}
.dshtl-state a:hover{text-decoration:underline}
.dshtl-error{margin:24px;padding:16px 18px;border:1px solid #d0d7de;border-radius:10px;background:#fff;color:#1f2328;font:13px/1.7 var(--dsh-font-family-content,system-ui,"Microsoft YaHei",sans-serif)}
.dshtl-error h2{margin:0 0 8px;font-size:15px;font-weight:600}
.dshtl-error code{display:block;margin-top:8px;white-space:pre-wrap;word-break:break-all;font:12px/1.6 Consolas,"Courier New",monospace;color:#656d76}
`;

      // 看板图标：外框 + 三列高低不同的卡片，跟侧栏里「日程」的日历图标同一笔画风格。
      function BoardIcon(props) {
        const size = (props && props.size) || 18;
        return h('svg', {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
          h('rect', { x: 3.4, y: 4.6, width: 17.2, height: 15.2, rx: 2.6 }),
          h('path', { d: 'M8.5 8.4v7.2M12 8.4v4.6M15.5 8.4v6.2' })
        );
      }

      function BoardPage() {
        const [ready, setReady] = React.useState(false);
        const [slow, setSlow] = React.useState(false);

        React.useEffect(() => {
          const timer = setTimeout(() => setSlow(true), 5000);
          return () => clearTimeout(timer);
        }, []);

        return h('div', { className: 'dshtl' },
          h('iframe', {
            className: 'dshtl-frame',
            src: PAGE_SRC,
            title: '项目进度管理器',
            allow: 'clipboard-read; clipboard-write',
            onLoad: () => setReady(true),
          }),
          ready ? null : h('div', { className: 'dshtl-state' },
            h('div', null, '正在载入项目进度管理器…'),
            slow ? h('div', null, '一直停在这里？', h('a', { href: PAGE_SRC, target: '_blank', rel: 'noreferrer' }, '在新窗口打开')) : null
          )
        );
      }

      /** 渲染炸了也把错误显示出来，而不是让主区域整块变黑。 */
      class PanelBoundary extends React.Component {
        constructor(props) {
          super(props);
          this.state = { error: null };
        }

        static getDerivedStateFromError(error) {
          return { error };
        }

        render() {
          if (!this.state.error) return this.props.children;
          return h('div', { className: 'dshtl-error' },
            h('h2', null, '「项目进度管理器」渲染出错'),
            h('div', null, '面板本身没起来，跟你的数据无关。可先重启 DSH 再试。'),
            h('code', null, String((this.state.error && this.state.error.stack) || this.state.error))
          );
        }
      }

      function registerPanel(ctx) {
        const id = 'dsh-todolist.board';
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: id,
          inject: () => ({ workbench: true }),
        }, function TodoListPage() {
          return h(PanelBoundary, null, h(BoardPage));
        }));

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id,
          // 排在「日程」(-10) 正下方、宿主「插件」(0) 之上。
          order: -9,
          label: 'ToDoList',
        }, function TodoListNavIcon(props) {
          return h(BoardIcon, { size: props && props.size });
        }));
      }

      function apply(ctx) {
        try {
          ctx.effect(() => {
            const tag = document.createElement('style');
            tag.setAttribute('data-dsh-todolist', 'styles');
            tag.textContent = CSS;
            document.head.appendChild(tag);
            return () => { try { tag.remove(); } catch { /* ignore */ } };
          }, 'dsh-todolist: styles');
        } catch { /* 纯 node 侧冒烟时没有 DOM */ }
        registerPanel(ctx);
      }

      exports.name = 'todolist-client';
      exports.inject = ['slots'];
      exports.apply = apply;
      exports.__parts = { BoardPage, BoardIcon, PAGE_SRC };
      return module.exports;
    },
  });
})();
