const GITHUB = 'https://github.com/';

export const remoteUrl = repository => `${GITHUB}${repository}.git`;

export const pullUrl = ({ repository, number }) => `${GITHUB}${repository}/pull/${number}`;

export const repositoryOf = url => (url.startsWith(GITHUB) ? url.slice(GITHUB.length) : url).replace(/\.git$/u, '');
