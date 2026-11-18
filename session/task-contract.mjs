export const TASK_CONTRACT_VERSION = 1;

export function taskRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || request.version !== TASK_CONTRACT_VERSION) {
    throw new Error(`task: unsupported contract version. Read snapshot.taskContract and send version ${TASK_CONTRACT_VERSION}.`);
  }
  const { version, ...input } = request;
  return input;
}
