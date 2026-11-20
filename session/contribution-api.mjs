const ORIGIN = 'https://api.github.com';
const TIMEOUT_MS = 30_000;
const GRANT_HINT = 'The credential lacks that permission or cannot see the repository. Ask the operator to grant it. No other credential or route was tried.';

export class GitHubRefusal extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
    this.exitCode = 3;
  }
}

function parsed(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// The host is fixed and redirects are never followed, so the credential reaches api.github.com only.
export function githubApi(token, fetchImpl = fetch) {
  return async (method, path, body) => {
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'agent-sandbox-contribute' };
    let response;
    try {
      response = await fetchImpl(`${ORIGIN}${path}`, {
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error(`contribute: GitHub did not answer ${method} ${path}.`);
    }
    return { status: response.status, data: parsed(await response.text()) };
  };
}

export function expectStatus({ status, data }, accepted, action) {
  if (accepted.includes(status)) return data;
  const reason = typeof data?.message === 'string' ? `: ${data.message.slice(0, 200)}` : '';
  throw new GitHubRefusal(`contribute: GitHub refused to ${action} (HTTP ${status}${reason}). ${[401, 403, 404].includes(status) ? GRANT_HINT : ''}`.trim(), status);
}
