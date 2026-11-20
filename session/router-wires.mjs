export const STANDARD_WIRES = Object.freeze({
  'inco/deepseek-v4.1-flash:fast': 'deepseek-v4.1-flash',
  'inco/glm-5.3-flash:fast': 'glm-5.3-flash',
});

export function normalizeStandardWire(output, member, expectedUpstream) {
  const lines = output.split('\n');
  const expectedLines = [
    `${expectedUpstream} · what inco is asked for, for ${member}`,
    `  · magpie and the agents still know it as ${member} · --reset asks for that again`,
    '',
  ];
  if (lines.length !== expectedLines.length || lines.some((line, index) => line !== expectedLines[index])) {
    throw new Error('CODEX_TARGETED_V1: Magpie wire getter format is unknown or the standard wire drifted, refused.');
  }
  return expectedUpstream;
}
