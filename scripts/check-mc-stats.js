const assert = require('node:assert/strict');
const { McServer } = require('../mc_server');

async function run() {
  const s1 = new McServer('test');
  assert.equal(s1.config.statsIntervalSeconds, 15);

  const s2 = new McServer('test', { statsIntervalSeconds: 3 });
  s2.process = { pid: 1234 };
  s2.getMcProcessStats = async () => ({ cpu: 12, memory: { used: 1, total: 2 } });

  let intervalMs;
  const originalSetInterval = global.setInterval;
  global.setInterval = (fn, ms) => {
    intervalMs = ms;
    return 1;
  };

  try {
    s2.startStatsPolling();
    assert.equal(intervalMs, 3000);
  } finally {
    global.setInterval = originalSetInterval;
  }

  const s3 = new McServer('test', { statsIntervalSeconds: 5 });
  let resolveFirst;
  const first = new Promise((resolve) => { resolveFirst = resolve; });
  s3.runChildProcess = async () => first;

  const p1 = s3.getWindowsProcessStats(1234);
  const p2 = s3.getWindowsProcessStats(1234);

  assert.equal(await p2, null);
  resolveFirst('java\n0\n1024');
  const result = await p1;
  assert.equal(result.cpu, 0);
  assert.equal(result.memory.used, 1024);

  const s4 = new McServer('test');
  const childResult = await s4.runChildProcess(process.execPath, ['-e', 'process.exit(0)']);
  assert.equal(childResult, '');

  console.log('MC stats checks passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
