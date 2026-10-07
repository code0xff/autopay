// 네트워크 호출에 응답 대기 상한을 건 fetch 래퍼 — 응답 헤더가 오기까지만 잰다
// (SSE 본문 스트리밍은 길어도 정상이므로 헤더 수신 후엔 타이머를 해제).
// 멈춘 호출이 RPC를 무한정 붙잡지 못하게 하는 장치. 호출자의 signal(중지)도 존중한다.
export const DEFAULT_FETCH_TIMEOUT_MS = 20_000;

export function withTimeout(
  base: typeof fetch,
  ms: number = DEFAULT_FETCH_TIMEOUT_MS,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const ctrl = new AbortController();
    const outer = init?.signal;
    const onOuterAbort = () => ctrl.abort(outer?.reason);
    if (outer) {
      if (outer.aborted) ctrl.abort(outer.reason);
      else outer.addEventListener("abort", onOuterAbort, { once: true });
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, ms);
    try {
      return await base(input, { ...init, signal: ctrl.signal });
    } catch (e) {
      if (timedOut) throw new Error("network_timeout");
      throw e;
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuterAbort);
    }
  }) as typeof fetch;
}
