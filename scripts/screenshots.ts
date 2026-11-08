import { chromium } from 'playwright';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../src/bootstrap';
import { CryptoService } from '../src/crypto/crypto.service';
import { Envelope, signingBytes } from '../src/envelopes/envelope';
import { EnvelopesService } from '../src/envelopes/envelopes.service';
import { demoSettings, jsonPost } from './support';

// Dùng Chrome để thao tác Swagger thật, chụp giao diện và bằng chứng kiểm thử cho Chương 3.
async function main() {
  const root = await mkdtemp(join(tmpdir(), 'ptit-screenshots-'));
  const output = resolve('docs/screenshots');
  await mkdir(output, { recursive: true });
  const mongoDbName = `ptit_screenshots_${Date.now()}`;
  const passwordA = randomBytes(24).toString('hex');
  const passwordB = randomBytes(24).toString('hex');
  const a = await createApp({ ...demoSettings(root, 'don-vi-a'), mongoDbName }, false);
  const b = await createApp(
    { ...demoSettings(root, 'don-vi-b'), mongoDbName, receivePassphrase: passwordB },
    false,
  );
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    await a.listen(0, '127.0.0.1');
    await b.listen(0, '127.0.0.1');
    const urlA = await a.getUrl();
    const urlB = await b.getUrl();
    const keyA = await jsonPost(urlA, '/api/keys/generate', {
      passphrase: passwordA,
      modulusLength: 2048,
    });
    const keyB = await jsonPost(urlB, '/api/keys/generate', {
      passphrase: passwordB,
      modulusLength: 2048,
    });
    await jsonPost(urlA, '/api/peers', {
      unitId: keyB.unitId,
      publicKeyPem: keyB.publicKeyPem,
      expectedFingerprint: keyB.fingerprint,
    });
    await jsonPost(urlB, '/api/peers', {
      unitId: keyA.unitId,
      publicKeyPem: keyA.publicKeyPem,
      expectedFingerprint: keyA.fingerprint,
    });
    // Mở biểu mẫu bên gửi, chọn PDF, điền người nhận và mật khẩu rồi bấm Execute như người dùng.
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1080 },
      deviceScaleFactor: 1,
    });
    await page.goto(`${urlA}/docs`);
    const sender = page
      .locator('.opblock')
      .filter({ has: page.locator('[data-path="/api/envelopes/seal"]') });
    await sender.locator('.opblock-summary-control').click();
    await sender.locator('.try-out__btn').click();
    await sender
      .locator('input[type="file"]')
      .setInputFiles(resolve('assets/samples/cong-van.pdf'));
    await sender.locator('tr').filter({ hasText: 'recipientId' }).locator('input').fill('don-vi-b');
    const passwordInputA = sender.locator('tr').filter({ hasText: 'passphrase' }).locator('input');
    await passwordInputA.fill(passwordA);
    const [sealed] = await Promise.all([
      page.waitForResponse((response) => response.url() === `${urlA}/api/envelopes/seal`),
      sender.locator('button.execute').click(),
    ]);
    if (sealed.status() !== 200)
      throw new Error(`Swagger seal: HTTP ${sealed.status()}: ${await sealed.text()}`);
    const envelope = await sealed.body();
    await writeFile(join(root, 'package.json'), envelope);
    await sender.scrollIntoViewIfNeeded();
    // Che cả ô mật khẩu và lệnh curl tự sinh vì lệnh curl cũng chứa mật khẩu.
    await page.screenshot({
      path: join(output, 'ben-gui.png'),
      fullPage: false,
      maskColor: '#d5d9df',
      mask: [passwordInputA, sender.locator('.curl-command')],
    });
    // Mở biểu mẫu bên nhận với đúng phong bì vừa tạo, không dùng ảnh giao diện dựng sẵn.
    await page.goto(`${urlB}/docs`);
    const receiver = page
      .locator('.opblock')
      .filter({ has: page.locator('[data-path="/api/envelopes/open"]') });
    await receiver.locator('.opblock-summary-control').click();
    await receiver.locator('.try-out__btn').click();
    await receiver.locator('input[type="file"]').setInputFiles(join(root, 'package.json'));
    const passwordInputB = receiver
      .locator('tr')
      .filter({ hasText: 'passphrase' })
      .locator('input');
    await passwordInputB.fill(passwordB);
    const [opened] = await Promise.all([
      page.waitForResponse((response) => response.url() === `${urlB}/api/envelopes/open`),
      receiver.locator('button.execute').click(),
    ]);
    if (opened.status() !== 200) throw new Error(`Swagger open: HTTP ${opened.status()}`);
    // Tải bằng liên kết của Swagger rồi đối chiếu byte, kiểm tra đúng thao tác tải tệp của người dùng.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      receiver.getByRole('link', { name: 'Download file', exact: true }).click(),
    ]);
    const downloadPath = await download.path();
    if (!downloadPath) throw new Error('Không tải được tệp từ Swagger.');
    const restored = await readFile(downloadPath);
    const expected = await readFile(resolve('assets/samples/cong-van.pdf'));
    if (!restored.equals(expected))
      throw new Error(
        `Browser restored file mismatch: got ${restored.length}, expected ${expected.length}, prefix ${restored.subarray(0, 80).toString('utf8')}`,
      );
    await receiver.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(output, 'ben-nhan.png'),
      fullPage: false,
      maskColor: '#d5d9df',
      mask: [passwordInputB, receiver.locator('.curl-command')],
    });
    // Tạo gói mới để trình diễn REST JSON sau khi gói trước đã được mở và ghi chống phát lại.
    const restEnvelope = await a
      .get(EnvelopesService)
      .seal(expected, 'cong-van.pdf', 'application/pdf', 'don-vi-b', passwordA);
    const results: { filename: string; status: number; response: unknown; executedAt: string }[] =
      [];
    // Gửi từng ca qua nút Execute, đợi HTTP thật và chụp đúng vùng phản hồi của Swagger.
    async function receiveScreenshot(value: Envelope, status: number, filename: string) {
      await page.goto(`${urlB}/docs`);
      const rest = page
        .locator('.opblock')
        .filter({ has: page.locator('[data-path="/api/envelopes/receive"]') });
      await rest.locator('.opblock-summary-control').click();
      await rest.locator('.try-out__btn').click();
      await rest.locator('textarea').fill(JSON.stringify(value, null, 2));
      const [response] = await Promise.all([
        page.waitForResponse((r) => r.url() === `${urlB}/api/envelopes/receive`),
        rest.locator('button.execute').click(),
      ]);
      const body: unknown = await response.json();
      if (response.status() !== status)
        throw new Error(`${filename}: HTTP ${response.status()}, cần ${status}`);
      await rest
        .locator('.live-responses-table .response-col_status')
        .filter({ hasText: String(status) })
        .waitFor();
      await rest.getByText('Server response', { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(output, filename), fullPage: false });
      results.push({ filename, status, response: body, executedAt: new Date().toISOString() });
    }
    await receiveScreenshot(restEnvelope, 200, 'rest-api.png');
    const tampered = structuredClone(restEnvelope);
    const bytes = Buffer.from(tampered.payload.encrypted_data, 'base64');
    bytes[0] ^= 1;
    tampered.payload.encrypted_data = bytes.toString('base64');
    await receiveScreenshot(tampered, 401, 'test-tampering.png');
    // Giữ sender_id của A nhưng ký bằng khóa khác để kiểm tra khóa đối tác đã ghim tại B.
    const crypto = new CryptoService();
    const fakePassword = randomBytes(24).toString('hex');
    const fakePair = await crypto.generateRsaPair(fakePassword, 2048);
    const spoofed = structuredClone(restEnvelope);
    spoofed.payload.signature = crypto
      .sign(signingBytes(spoofed), crypto.privateKey(fakePair.privateKeyPem, fakePassword))
      .toString('base64');
    await receiveScreenshot(spoofed, 401, 'test-spoofing.png');
    await receiveScreenshot(restEnvelope, 409, 'test-replay.png');
    // Đổi UUID và thời gian bên ngoài vẫn bị chặn do khác bản sao control nằm trong bản mã.
    const changedControl = structuredClone(restEnvelope);
    changedControl.header.request_id = randomUUID();
    changedControl.header.timestamp = new Date().toISOString();
    await receiveScreenshot(changedControl, 400, 'test-changed-control.png');
    await writeFile(
      resolve('artifacts/screenshot-results.json'),
      JSON.stringify({ mongoDbName, results }, null, 2),
    );
    await page.goto(`${urlB}/docs`);
    const storage = page
      .locator('.opblock')
      .filter({ has: page.locator('[data-path="/api/storage/status"]') });
    await storage.locator('.opblock-summary-control').click();
    await storage.locator('.try-out__btn').click();
    const [stored] = await Promise.all([
      page.waitForResponse((r) => r.url() === `${urlB}/api/storage/status`),
      storage.locator('button.execute').click(),
    ]);
    if (stored.status() !== 200)
      throw new Error('Không lấy được bằng chứng MongoDB trong Swagger.');
    await storage.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(output, 'mongodb.png'), fullPage: false });
    // Trình bày nguyên văn cuối nhật ký npm test đã lưu; đây là ảnh trích log, không giả lập terminal.
    const tests = JSON.parse(await readFile(resolve('artifacts/test-results.json'), 'utf8')) as {
      executedAt: string;
      tests: number;
      passed: number;
      failed: number;
      exitCode: number;
    };
    if (tests.exitCode !== 0 || tests.tests === 0 || tests.failed !== 0)
      throw new Error('Nhật ký kiểm thử chưa đạt để đưa vào ảnh báo cáo.');
    const tap = await readFile(resolve('artifacts/test-results.tap'), 'utf8');
    await page.setContent(`<!doctype html><html lang="vi"><meta charset="utf-8"><style>
      body{margin:64px;font:24px Arial;color:#142033;background:#f5f7fa}
      h1{font-size:38px}p{line-height:1.5}pre{background:white;padding:32px;border:1px solid #cbd5e1;
      font:23px/1.55 monospace;white-space:pre-wrap}strong{color:#146b3a}
      </style><h1>Trích nhật ký kiểm thử tự động</h1><p id="source"></p>
      <p><strong id="summary"></strong></p><pre id="log"></pre></html>`);
    await page.locator('#source').evaluate((el, text) => {
      el.textContent = text;
    }, `Lệnh: npm test • Thời điểm chạy (UTC): ${tests.executedAt}`);
    await page.locator('#summary').evaluate((el, text) => {
      el.textContent = text;
    }, `${tests.passed}/${tests.tests} ca đạt • ${tests.failed} ca thất bại • Exit code ${tests.exitCode}`);
    await page.locator('#log').evaluate((el, text) => {
      el.textContent = text;
    }, tap.trimEnd().split('\n').slice(-19).join('\n'));
    await page.screenshot({ path: join(output, 'test-summary.png'), fullPage: false });
    console.log(
      'Đã lưu ảnh giao diện, 5 phản hồi HTTP thực tế và trích nhật ký npm test trong docs/screenshots.',
    );
  } finally {
    // Giải phóng trình duyệt, máy chủ và kho khóa tạm sau khi chụp.
    await browser.close();
    await Promise.all([a.close(), b.close()]);
    await rm(root, { recursive: true, force: true });
  }
}

// Trả mã lỗi nếu thao tác Swagger hoặc việc tải/đối chiếu tệp không thành công.
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
