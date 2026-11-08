import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Tìm các bài kiểm thử đã biên dịch; không phụ thuộc shell có hỗ trợ ký tự glob hay không.
const files = readdirSync(resolve('dist/tests'))
  .filter((file) => file.endsWith('.spec.js'))
  .map((file) => resolve('dist/tests', file));
// Chạy node:test trong tiến trình con và thu định dạng TAP để lưu bằng chứng kiểm thử.
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], {
  encoding: 'utf8',
  maxBuffer: 10 * 1024 * 1024,
});
const output = result.stdout ?? '';
process.stdout.write(output);
process.stderr.write(result.stderr ?? '');
mkdirSync(resolve('artifacts'), { recursive: true });
writeFileSync(resolve('artifacts/test-results.tap'), output);
// Trích số tests/pass/fail từ tổng kết TAP thật, không điền số kiểm thử bằng giá trị cố định.
const count = (name: string) =>
  Number(output.match(new RegExp(`^# ${name} (\\d+)`, 'm'))?.[1] ?? 0);
writeFileSync(
  resolve('artifacts/test-results.json'),
  JSON.stringify(
    {
      executedAt: new Date().toISOString(),
      node: process.version,
      command: 'npm test',
      exitCode: result.status ?? 1,
      tests: count('tests'),
      passed: count('pass'),
      failed: count('fail'),
      skipped: count('skipped'),
      durationMs: Number(output.match(/^# duration_ms ([\d.]+)/m)?.[1] ?? 0),
    },
    null,
    2,
  ),
);
process.exitCode = result.status ?? 1;
