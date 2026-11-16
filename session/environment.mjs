const BASIC = ['HOME', 'PATH', 'TMPDIR', 'LANG', 'SYSTEMROOT'];

export const basicEnvironment = (environment, extra = []) =>
  Object.fromEntries(Object.entries(environment).filter(([name]) => BASIC.includes(name) || extra.includes(name)));
