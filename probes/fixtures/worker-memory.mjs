export function healthyWorkerMemory(path) {
  if (path === '/proc/meminfo') return 'MemTotal: 1000000 kB\nMemAvailable: 900000 kB\n';
  if (path === '/proc/pressure/memory') return 'some avg10=0.00\nfull avg10=0.00\n';
  if (path === '/proc/self/cgroup') return '';
  throw new Error(`Unexpected memory file: ${path}`);
}
