const BASIC = ['HOME', 'PATH', 'TMPDIR', 'LANG', 'SYSTEMROOT'];

export const basicEnvironment = environment => Object.fromEntries(Object.entries(environment).filter(([name]) => BASIC.includes(name)));
