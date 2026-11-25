import type { BrowserContext, Page } from 'playwright';
import type { HistoryEntry, Rule } from '../model';
import type { DynamicHttp } from './dynamic-http';
import { bodyLimit, bodySnapshot, entry, patchRequest, patchResponse, selectHttp } from './http';

/** CDP preserves Chromium's real OPTIONS/CORS checks and can continue unbuffered responses. */
export async function installHttp(
  context: BrowserContext,
  page: Page,
  settings: () => {
    capture: boolean;
    mock: boolean;
    rules: Rule[];
    states: Map<string, string>;
    dynamic: DynamicHttp;
  },
  save: (record: HistoryEntry) => void,
) {
  const session = await context.newCDPSession(page);
  const requests = new Map<string, HistoryEntry>();
  const clock = () => performance.timeOrigin + performance.now();
  session.on('Fetch.requestPaused', (event) => {
    void handle(event).catch(async (error) => {
      const record = requests.get(event.requestId);
      if (record) {
        record.error = String(error);
        save(record);
        requests.delete(event.requestId);
      }
      await session
        .send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Failed' })
        .catch(() => {});
    });
  });
  async function handle(event: any) {
    const { requestId } = event;
    const config = settings();
    if (event.responseStatusCode === undefined && !event.responseErrorReason) {
      if (!config.capture) {
        await session.send('Fetch.continueRequest', { requestId });
        return;
      }
      const headers = Object.entries(event.request.headers).map(
        ([key, value]) => [key, String(value)] as [string, string],
      );
      const data =
        event.request.postDataEntries?.length &&
        event.request.postDataEntries.every((item: { bytes?: string }) => item.bytes !== undefined)
          ? Buffer.concat(
              event.request.postDataEntries.map((item: any) => Buffer.from(item.bytes ?? '', 'base64')),
            )
          : Buffer.from(event.request.postData ?? '');
      const bodyUnavailable =
        (event.request.hasPostData &&
          !event.request.postDataEntries?.length &&
          event.request.postData === undefined) ||
        (event.request.postData === undefined &&
          event.request.postDataEntries?.some((item: { bytes?: string }) => item.bytes === undefined));
      const original = {
        ...bodySnapshot(headers, data, bodyUnavailable ? 'Request body is unavailable.' : undefined),
        method: event.request.method,
        url: event.request.url,
      };
      const record = entry(original, clock());
      requests.set(requestId, record);
      const unsupported =
        !original.editable ||
        headers.some(
          ([name, value]) => name.toLowerCase() === 'content-type' && /multipart|octet-stream/.test(value),
        );
      const rule =
        config.mock && !unsupported
          ? selectHttp(config.rules, original, 'request', config.states)
          : undefined;
      const request = patchRequest(original, rule);
      record.request = request;
      record.automaticRequest = structuredClone(request);
      record.targetUrl = request.url;
      if (unsupported) record.error = 'Upload or binary/oversize request is passed through without editing.';
      if (rule) record.requestRuleId = rule.id;
      const fulfill = async (mock: NonNullable<Rule['mock']>) => {
        const originalResponse = {
          ...bodySnapshot(Object.entries(mock.headers), Buffer.from(mock.body)),
          status: mock.status,
        };
        const responseRule = selectHttp(config.rules, original, 'response', config.states);
        const response = originalResponse.editable
          ? patchResponse(originalResponse, responseRule)
          : originalResponse;
        record.originalResponse = originalResponse;
        record.response = response;
        record.automaticResponse = structuredClone(response);
        record.mocked = true;
        if (responseRule && originalResponse.editable) record.responseRuleId = responseRule.id;
        // Commit state before delivering the response so an immediate follow-up sees it.
        if (rule?.scenario?.next) config.states.set(rule.scenario.id, rule.scenario.next);
        await session.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: response.status,
          responseHeaders: response.headers
            .filter(
              ([n]) => !['content-length', 'content-encoding', 'transfer-encoding'].includes(n.toLowerCase()),
            )
            .map(([name, value]) => ({ name, value })),
          body: Buffer.from(response.body, response.bodyEncoding === 'base64' ? 'base64' : 'utf8').toString(
            'base64',
          ),
        });
        requests.delete(requestId);
        save(record);
      };
      if (rule?.dynamic) {
        await config.dynamic.run(rule.id, original, fulfill);
        return;
      }
      if (rule?.mock) {
        await fulfill(rule.mock);
        return;
      }
      await session.send('Fetch.continueRequest', {
        requestId,
        ...(rule
          ? {
              url: request.url,
              method: request.method,
              headers: request.headers.map(([name, value]) => ({ name, value })),
              ...(rule.request?.body !== undefined
                ? { postData: Buffer.from(request.body).toString('base64') }
                : {}),
            }
          : {}),
      });
      return;
    }
    const record = requests.get(requestId);
    requests.delete(requestId);
    if (!record) {
      await session.send('Fetch.continueResponse', { requestId });
      return;
    }
    if (event.responseErrorReason) {
      record.error = event.responseErrorReason;
      save(record);
      await session.send('Fetch.continueResponse', { requestId });
      return;
    }
    const headers = (event.responseHeaders ?? []).map((h: any) => [h.name, h.value] as [string, string]);
    const get = (key: string) =>
      headers.find(([name]: [string, string]) => name.toLowerCase() === key)?.[1] ?? '';
    const stream = /text\/event-stream/.test(get('content-type'));
    const tooLarge = Number(get('content-length')) > bodyLimit;
    const redirect = event.responseStatusCode >= 300 && event.responseStatusCode < 400;
    const limitation = stream ? 'streaming' : tooLarge ? 'body_too_large' : redirect ? 'redirect' : undefined;
    let body = Buffer.alloc(0);
    if (!limitation && record.method !== 'HEAD' && ![204, 304].includes(event.responseStatusCode)) {
      const result = await session.send('Fetch.getResponseBody', { requestId });
      body = Buffer.from(result.body, result.base64Encoded ? 'base64' : 'utf8');
    }
    const original = { ...bodySnapshot(headers, body, limitation), status: event.responseStatusCode };
    record.originalResponse = original;
    const rule =
      config.capture && config.mock
        ? selectHttp(config.rules, record.originalRequest, 'response', config.states)
        : undefined;
    const response = original.editable ? patchResponse(original, rule) : original;
    record.response = response;
    record.automaticResponse = structuredClone(response);
    if (rule && !original.editable) record.error = 'Unsupported response is passed through without editing.';
    if (rule && original.editable) {
      record.responseRuleId = rule.id;
      await session.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: response.status,
        responseHeaders: response.headers
          .filter(
            ([n]) => !['content-length', 'content-encoding', 'transfer-encoding'].includes(n.toLowerCase()),
          )
          .map(([name, value]) => ({ name, value })),
        body: Buffer.from(response.body, response.bodyEncoding === 'base64' ? 'base64' : 'utf8').toString(
          'base64',
        ),
      });
    } else await session.send('Fetch.continueResponse', { requestId });
    save(record);
  }
  // No Playwright route: it auto-answers preflights. Both stages are installed before explicit navigation.
  await session.send('Network.enable');
  await session.send('Network.setCacheDisabled', { cacheDisabled: true });
  await session.send('Fetch.enable', {
    patterns: [
      { urlPattern: '*', requestStage: 'Request' },
      { urlPattern: '*', requestStage: 'Response' },
    ],
  });
  page.on('close', () => requests.clear());
}
