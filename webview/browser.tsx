import { useState, useEffect } from 'react';
import type { WorkbenchState } from '../src/model';
export function BrowserPanel({
  state,
  send,
}: {
  state: WorkbenchState;
  send: (action: string, payload?: unknown) => void;
}) {
  const [url, setUrl] = useState(state.project?.web?.url ?? 'http://localhost:5173/');
  const [result, setResult] = useState<any>();
  const [sceneId, setSceneId] = useState(''),
    [actionId, setActionId] = useState('');
  const [testId, setTestId] = useState('');
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.data?.type === 'browser.result') setResult(event.data);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);
  const call = (tool: string, args: unknown = {}) => send('browser.call', { tool, args });
  return (
    <details className="card">
      <summary>托管浏览器</summary>
      <p>
        显式准备私有 Chromium，再创建独立 Context。首次导航前安装规则；Service Worker
        阻止，路由关闭缓存。不会附着日常 Profile。
      </p>
      <button disabled={state.busy} onClick={() => call('prepare_browser')}>
        准备浏览器依赖
      </button>
      <button disabled={state.busy} onClick={() => call('create_browser_context')}>
        创建浏览器 Context
      </button>
      <label>
        托管页面 URL
        <input aria-label="托管页面 URL" value={url} onChange={(event) => setUrl(event.target.value)} />
      </label>
      <label>
        Web Scene ID
        <input
          aria-label="Web Scene ID"
          value={sceneId}
          onChange={(event) => setSceneId(event.target.value)}
        />
      </label>
      <label>
        Web Action ID
        <input
          aria-label="Web Action ID"
          value={actionId}
          onChange={(event) => setActionId(event.target.value)}
        />
      </label>
      <label>
        Web Test ID
        <input aria-label="Web Test ID" value={testId} onChange={(event) => setTestId(event.target.value)} />
      </label>
      {state.browser?.contexts.map((context) => (
        <div key={context.runtimeId}>
          <p>
            Context {context.runtimeId} · generation {context.generation} · {context.busy ?? 'idle'}
          </p>
          <button
            disabled={!!context.busy}
            onClick={() =>
              call('set_capture_enabled', {
                target: { runtimeId: context.runtimeId, generation: context.generation },
                domain: 'ws',
                enabled: !context.wsCapture,
              })
            }
          >
            {context.wsCapture ? '暂停 Web WS 采集' : '开启 Web WS 采集'}
          </button>
          <button
            onClick={() =>
              call('get_ws_connections', {
                target: { runtimeId: context.runtimeId, generation: context.generation },
              })
            }
          >
            Web WS 连接
          </button>
          <button
            onClick={() =>
              call('get_ws_messages', {
                target: { runtimeId: context.runtimeId, generation: context.generation },
                limit: 20,
              })
            }
          >
            Web WS 消息
          </button>
          <button
            disabled={!!context.busy}
            onClick={() =>
              call('open_browser_page', {
                target: { runtimeId: context.runtimeId, generation: context.generation },
                url,
              })
            }
          >
            打开托管页面
          </button>
          <button
            onClick={() =>
              call('close_browser_context', {
                target: { runtimeId: context.runtimeId, generation: context.generation },
              })
            }
          >
            关闭 Context
          </button>
          {context.pages.map((page) => (
            <div key={page.pageId}>
              <code>{page.pageId}</code> {page.url}
              <button
                disabled={!!context.busy || !testId}
                onClick={() =>
                  call('run_test', {
                    target: {
                      runtimeId: context.runtimeId,
                      generation: context.generation,
                      pageId: page.pageId,
                    },
                    testId,
                  })
                }
              >
                运行 Web 测试
              </button>
              <button
                disabled={!!context.busy}
                onClick={() =>
                  call('take_screenshot', {
                    target: {
                      runtimeId: context.runtimeId,
                      generation: context.generation,
                      pageId: page.pageId,
                    },
                    source: 'web',
                    mode: 'screen',
                  })
                }
              >
                网页截图
              </button>
              <button
                disabled={!!context.busy}
                onClick={() =>
                  call('take_screenshot', {
                    target: {
                      runtimeId: context.runtimeId,
                      generation: context.generation,
                      pageId: page.pageId,
                    },
                    source: 'web',
                    mode: 'full_page',
                  })
                }
              >
                网页整页截图
              </button>
              <button
                disabled={!!context.busy || !sceneId || !actionId}
                onClick={() =>
                  call('run_scene_action', {
                    target: {
                      runtimeId: context.runtimeId,
                      generation: context.generation,
                      pageId: page.pageId,
                    },
                    sceneId,
                    actionId,
                  })
                }
              >
                运行 Web 操作
              </button>
              <button
                disabled={!!context.busy}
                onClick={() =>
                  call('navigate_browser_page', {
                    target: {
                      runtimeId: context.runtimeId,
                      generation: context.generation,
                      pageId: page.pageId,
                    },
                    url,
                  })
                }
              >
                导航
              </button>
              <button
                disabled={!!context.busy}
                onClick={() =>
                  call('reload_browser_page', {
                    target: {
                      runtimeId: context.runtimeId,
                      generation: context.generation,
                      pageId: page.pageId,
                    },
                  })
                }
              >
                刷新
              </button>
              <button
                disabled={!!context.busy}
                onClick={() =>
                  call('close_browser_page', {
                    target: {
                      runtimeId: context.runtimeId,
                      generation: context.generation,
                      pageId: page.pageId,
                    },
                  })
                }
              >
                关闭页面
              </button>
            </div>
          ))}
          {context.actions?.recentRuns.map((run) => (
            <div key={run.runId}>
              <span>
                {run.name} · {run.status} · {run.currentStep}
              </span>
              <button
                onClick={() =>
                  call('get_scene_action_run', {
                    target: { runtimeId: context.runtimeId, generation: context.generation },
                    runId: run.runId,
                  })
                }
              >
                查看 Web 运行
              </button>
              {run.status === 'running' && (
                <button
                  onClick={() =>
                    call('cancel_scene_action_run', {
                      target: { runtimeId: context.runtimeId, generation: context.generation },
                      runId: run.runId,
                    })
                  }
                >
                  取消 Web 运行
                </button>
              )}
            </div>
          ))}
          {context.tests?.recentRuns.map((run) => (
            <div key={run.runId}>
              {run.name} · {run.status}
              <button
                onClick={() =>
                  call('get_test_run', {
                    target: { runtimeId: context.runtimeId, generation: context.generation },
                    runId: run.runId,
                  })
                }
              >
                查看 Web 测试
              </button>
              <button
                onClick={() =>
                  call('cancel_test_run', {
                    target: { runtimeId: context.runtimeId, generation: context.generation },
                    runId: run.runId,
                  })
                }
              >
                {context.cleanupPending.includes(run.runId) && run.status !== 'running'
                  ? '重试 Web 测试清理'
                  : '取消 Web 测试'}
              </button>
            </div>
          ))}
        </div>
      ))}
      {state.browser?.archivedRuns?.map((run) => (
        <div key={run.runId}>
          已断开运行 · {run.status} · {run.runId}
          <button onClick={() => call(run.tool, { target: run.target, runId: run.runId })}>
            查看断线运行报告
          </button>
        </div>
      ))}
      {result?.result?.image && (
        <img
          alt="托管网页截图"
          src={`data:image/png;base64,${result.result.image.data}`}
          style={{ maxWidth: '100%' }}
        />
      )}
      {result?.result?.run && (
        <pre aria-label="Web 运行结果">{JSON.stringify(result.result.run, null, 2)}</pre>
      )}
      {['get_ws_connections', 'get_ws_messages', 'get_browser_ws_message'].includes(result?.tool) && (
        <pre aria-label="Web WS 结果">{JSON.stringify(result.result, null, 2)}</pre>
      )}
    </details>
  );
}
