const BASIC = ['HOME', 'PATH', 'TMPDIR', 'LANG', 'SYSTEMROOT'];

/** The process settings a child needs to run, without any credential the parent holds. */
export const basicEnvironment = environment => Object.fromEntries(Object.entries(environment).filter(([name]) => BASIC.includes(name)));
