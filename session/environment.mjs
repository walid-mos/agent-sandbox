const BASIC = ['HOME', 'PATH', 'TMPDIR', 'LANG', 'SYSTEMROOT'];
export const RUNTIME_SETTINGS = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
  'TZ', 'NPM_CONFIG_PREFIX', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS'];

export const basicEnvironment = (environment, extra = []) =>
  Object.fromEntries(Object.entries(environment).filter(([name]) => BASIC.includes(name) || extra.includes(name)));

export function assignments(text) {
  return Object.fromEntries(text.split('\n').filter(Boolean).map(line => {
    const equals = line.indexOf('=');
    return [line.slice(0, equals), line.slice(equals + 1)];
  }));
}
