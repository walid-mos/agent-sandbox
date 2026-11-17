const GITHUB = 'https://github.com/';

export const remoteUrl = repository => `${GITHUB}${repository}.git`;

export const pullUrl = ({ repository, number }) => `${GITHUB}${repository}/pull/${number}`;
