import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createApp } from '../src/bootstrap';
import { jsonPost, upload } from '../scripts/support';
import { passphrase, unit } from './helpers';

let root: string;
let app: Awaited<ReturnType<typeof createApp>>;
let base: string;

// Khởi động NestJS trên cổng ngẫu nhiên để kiểm tra HTTP thật, không mô phỏng controller bằng mock.
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'ptit-http-test-'));
  app = await createApp(unit(root, 'don-vi-a').settings, false);
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});
// Đóng cổng HTTP và dọn dữ liệu tạm sau kiểm thử, kể cả các bài test tạo khóa trên đĩa.
after(async () => {
  await app?.close();
  await rm(root, { recursive: true, force: true });
});

test('Health và Swagger được cung cấp cho đơn vị hiện tại', async () => {
  const health = await fetch(`${base}/api/health`);
  assert.deepEqual(await health.json(), { status: 'ok', unitId: 'don-vi-a' });
  assert.equal(health.headers.get('cache-control'), 'no-store');
  const docs = await fetch(`${base}/docs`);
  assert.equal(docs.status, 200);
  const schema = (await (await fetch(`${base}/docs-json`)).json()) as {
    paths: Record<string, unknown>;
  };
  assert.ok(schema.paths['/api/envelopes/seal']);
  assert.ok(schema.paths['/api/envelopes/open']);
});

test('DTO từ chối mật khẩu ngắn, RSA yếu và trường dư', async () => {
  for (const body of [
    { passphrase: 'short', modulusLength: 2048 },
    { passphrase, modulusLength: 1024 },
    { passphrase, modulusLength: 2048, privateKey: 'injected' },
  ]) {
    const response = await fetch(`${base}/api/keys/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
  }
});

test('API sinh khóa chỉ trả khóa công khai; không cho phép ghi đè', async () => {
  // Đóng gói yêu cầu để có thể gọi hai lần và đối chiếu lần tạo mới với lần ghi đè bị chặn.
  const request = () =>
    fetch(`${base}/api/keys/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase, modulusLength: 2048 }),
    });
  const response = await request();
  assert.equal(response.status, 201);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(typeof body.publicKeyPem, 'string');
  assert.ok(!('privateKeyPem' in body));
  assert.equal((await request()).status, 409);
  const pem = await fetch(`${base}/api/keys/public`);
  assert.match(await pem.text(), /BEGIN PUBLIC KEY/);
});

test('Upload thiếu tệp hoặc sai trường bị từ chối', async () => {
  const form = new FormData();
  form.set('passphrase', passphrase);
  assert.equal(
    (await fetch(`${base}/api/envelopes/open`, { method: 'POST', body: form })).status,
    400,
  );
  const wrong = new FormData();
  wrong.set('wrongField', new Blob(['x']), 'x.bin');
  assert.equal(
    (await fetch(`${base}/api/envelopes/open`, { method: 'POST', body: wrong })).status,
    400,
  );
});

test('Yêu cầu trình duyệt từ origin khác bị chặn', async () => {
  const response = await fetch(`${base}/api/health`, {
    headers: { Origin: 'https://example.org' },
  });
  assert.equal(response.status, 403);
});

test('Hai máy chủ HTTP độc lập trao đổi và khôi phục đúng tệp nhị phân', async () => {
  // Tạo thêm đơn vị B với kho riêng, sau đó kiểm tra từ upload đến download bằng fetch.
  const other = await createApp(unit(root, 'don-vi-b').settings, false);
  try {
    await other.listen(0, '127.0.0.1');
    const receiver = await other.getUrl();
    const keyB = await jsonPost(receiver, '/api/keys/generate', {
      passphrase,
      modulusLength: 2048,
    });
    const keyA = (await (await fetch(`${base}/api/keys/status`)).json()) as { fingerprint: string };
    const publicA = await (await fetch(`${base}/api/keys/public`)).text();
    await jsonPost(base, '/api/peers', {
      unitId: 'don-vi-b',
      publicKeyPem: keyB.publicKeyPem,
      expectedFingerprint: keyB.fingerprint,
    });
    await jsonPost(receiver, '/api/peers', {
      unitId: 'don-vi-a',
      publicKeyPem: publicA,
      expectedFingerprint: keyA.fingerprint,
    });
    const original = Buffer.from([0, 255, 1, 128, 10, 13, 0, 42]);
    const filename = 'Công văn số 01.bin';
    const sealed = await fetch(`${base}/api/envelopes/seal`, {
      method: 'POST',
      body: upload(original, filename, { recipientId: 'don-vi-b', passphrase }),
    });
    assert.equal(sealed.status, 200);
    assert.match(sealed.headers.get('content-disposition') ?? '', /attachment/);
    const wire = Buffer.from(await sealed.arrayBuffer());
    const opened = await fetch(`${receiver}/api/envelopes/open`, {
      method: 'POST',
      body: upload(wire, 'envelope.json', { passphrase }),
    });
    assert.equal(opened.status, 200);
    assert.equal(opened.headers.get('x-verified-sender'), 'don-vi-a');
    assert.ok(
      opened.headers
        .get('content-disposition')
        ?.includes(`filename*=UTF-8''${encodeURIComponent(filename)}`),
      'Tên tệp tiếng Việt phải được giữ nguyên sau upload và download.',
    );
    assert.deepEqual(Buffer.from(await opened.arrayBuffer()), original);
    const replay = await fetch(`${receiver}/api/envelopes/open`, {
      method: 'POST',
      body: upload(wire, 'envelope.json', { passphrase }),
    });
    assert.equal(replay.status, 409);
  } finally {
    await other.close();
  }
});
