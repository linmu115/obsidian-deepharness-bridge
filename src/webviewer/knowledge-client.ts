import type { App } from 'obsidian';
export type KnowledgeRequest = <T>(operation: string, input?: Record<string, unknown>) => Promise<T>;

/** Use the already authenticated, vault-owned viewer. No cookies or launch secrets are copied. */
export async function requestViewerKnowledge<T>(app: App, origin: string, surfaceId: string, operation: string, input: Record<string, unknown> = {}): Promise<T> {
  if (!/^[a-z-]{1,40}$/.test(operation)) throw new Error('不支持的知识操作');
  const expected = new URL(origin);
  if (expected.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(expected.hostname)) throw new Error('仅支持当前本地实例');
  const views = app.workspace.getLeavesOfType('webviewer').flatMap(leaf => [...leaf.view.containerEl.querySelectorAll('webview')]);
  const matching = views.filter(element => {
    try {
      const view = element as Element & { getURL(): string };
      const url = new URL(view.getURL());
      return url.origin === expected.origin && (new URLSearchParams(url.hash.slice(1)).get('dshBridgeSurface') ?? url.searchParams.get('dshBridgeSurface')) === surfaceId;
    } catch { return false; }
  });
  if (matching.length !== 1) throw new Error('请在此 Vault 打开一个已登录的 DSH 内嵌页，再重试');
  const payload = JSON.stringify({ operation, input, origin: expected.origin, surfaceId });
  if (payload.length > 512 * 1024) throw new Error('单次请求过大');
  const view = matching[0] as Element & { executeJavaScript(code: string): Promise<unknown> };
  const result = await view.executeJavaScript(`(async (q) => {
    if (location.origin !== q.origin || (new URLSearchParams(location.hash.slice(1)).get('dshBridgeSurface') || new URLSearchParams(location.search).get('dshBridgeSurface')) !== q.surfaceId) throw new Error('实例窗口已切换');
    const response = await fetch('/maintenance-knowledge/api/' + q.operation, {method:'POST', credentials:'same-origin', headers:{'content-type':'application/json'}, body:JSON.stringify(q.input), signal:AbortSignal.timeout(30000)});
    const value = await response.json();
    return {ok:response.ok, value};
  })(${payload})`) as { ok: boolean; value: T & { error?: { code?: string; message?: string } } };
  if (!result.ok) throw Object.assign(new Error(result.value.error?.message ?? 'Maintenance 知识操作未完成'), { code: result.value.error?.code });
  return result.value;
}
