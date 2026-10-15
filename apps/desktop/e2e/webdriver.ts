// A W3C WebDriver client of the three calls the smoke test needs: start a session, run a script in the page, end the
// session. msedgedriver speaks the standard protocol, so plain fetch is enough. WebdriverIO would do the same, but every
// one of its packages brings @promptbook/utils (CC-BY-4.0, through @wdio/utils and locate-app), which the license
// rule doesn't allow even as build-only (docs/SPEC.md, License).

export interface Session {
  /** Runs `fn` in the page with `args` and gives its result; a promise it returns is awaited (WebDriver's execute/sync). */
  execute: <A extends unknown[], R>(fn: (...args: A) => R | Promise<R>, ...args: A) => Promise<R>
  close: () => Promise<void>
}

async function call(url: string, method: 'POST' | 'DELETE', body?: unknown): Promise<unknown> {
  const response = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const reply = (await response.json()) as { value: unknown }
  if (!response.ok) {
    const error = reply.value as { error?: string; message?: string }
    throw new Error(`WebDriver ${method} ${url}: ${error?.error ?? response.status}: ${error?.message ?? ''}`)
  }
  return reply.value
}

/** A new session on the WebDriver server at `server` (http://127.0.0.1:port) with these capabilities. */
export async function newSession(server: string, capabilities: Record<string, unknown>): Promise<Session> {
  const { sessionId } = (await call(`${server}/session`, 'POST', { capabilities: { alwaysMatch: capabilities } })) as { sessionId: string }
  const base = `${server}/session/${sessionId}`
  return {
    execute: async (fn, ...args) => (await call(`${base}/execute/sync`, 'POST', { script: `return (${fn.toString()}).apply(null, arguments)`, args })) as never,
    close: async () => {
      await call(base, 'DELETE')
    }
  }
}
