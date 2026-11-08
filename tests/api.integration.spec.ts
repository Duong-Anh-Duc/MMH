import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { MongoClient } from 'mongodb';
import { createApp } from '../src/bootstrap';
import { CryptoService, RsaPair } from '../src/crypto/crypto.service';
import { Envelope } from '../src/envelopes/envelope';
import { demoSettings, upload } from '../scripts/support';

interface KeyInfo {
  unitId: string;
  publicKeyPem: string;
  fingerprint: string;
}

interface Receipt {
  status: string;
  request_id: string;
  document_id: string;
  download_url: string;
  sha256: string;
}

interface ApiSchema {
  paths: Record<string, Record<string, unknown>>;
}

interface KeyState {
  initialized: boolean;
  fingerprint?: string;
}

interface StorageState {
  enabled: boolean;
  database: string;
  unitId: string;
  peers: number;
  receipts: number;
}

const database = `ptit_api_${randomUUID().replaceAll('-', '')}`;
const mongoUri = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27018';
const passwordA = `Api-A-${randomUUID()}`;
const passwordB = `Api-B-${randomUUID()}`;
const crypto = new CryptoService();
const traces: {
  unit: string;
  method: string;
  endpoint: string;
  expected: number;
  actual: number;
}[] = [];
let root: string;
let a: Awaited<ReturnType<typeof createApp>>;
let b: Awaited<ReturnType<typeof createApp>>;
let baseA: string;
let baseB: string;
let imported: RsaPair;
let keyA: KeyInfo;
let keyB: KeyInfo;
let wire: Buffer;
let envelope: Envelope;
let openedId: string;
let receipt: Receipt;
const original = Buffer.from('Công văn thử nghiệm API\n\x00\xff', 'utf8');

// Gửi HTTP thật và ghi mã trạng thái, không lưu body có mật khẩu hoặc khóa vào bằng chứng.
async function request(
  base: string,
  method: 'GET' | 'POST',
  path: string,
  expected: number,
  init: RequestInit = {},
): Promise<Response> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    method,
    signal: AbortSignal.timeout(15000),
  });
  traces.push({
    unit: base === baseA ? 'don-vi-a' : 'don-vi-b',
    method,
    endpoint: path.replace(/\/documents\/[^/]+$/, '/documents/{id}'),
    expected,
    actual: response.status,
  });
  assert.equal(response.status, expected, `${method} ${path}: HTTP ${response.status}`);
  return response;
}

// Chuẩn hóa yêu cầu JSON theo đúng Content-Type các API nhận cấu hình và phong bì.
function json(body: unknown): RequestInit {
  return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

// Tạo một phong bì mới qua API để các kịch bản nhận không dùng lại UUID đã tiêu thụ.
async function seal(data = original, filename = 'Công văn 01.bin'): Promise<Buffer> {
  const response = await request(baseA, 'POST', '/api/envelopes/seal', 200, {
    body: upload(data, filename, { recipientId: 'don-vi-b', passphrase: passwordA }),
  });
  assert.match(response.headers.get('content-disposition') ?? '', /attachment/);
  return Buffer.from(await response.arrayBuffer());
}

// Tạo hai máy chủ và kho khóa/DB có UUID riêng; B nhận tự động, A dùng để kiểm tra lỗi thiếu cấu hình.
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'ptit-api-contract-'));
  imported = await crypto.generateRsaPair(passwordB, 2048);
  a = await createApp(
    { ...demoSettings(root, 'don-vi-a'), mongoUri, mongoDbName: database },
    false,
  );
  b = await createApp(
    {
      ...demoSettings(root, 'don-vi-b'),
      mongoUri,
      mongoDbName: database,
      receivePassphrase: passwordB,
    },
    false,
  );
  await a.listen(0, '127.0.0.1');
  await b.listen(0, '127.0.0.1');
  baseA = await a.getUrl();
  baseB = await b.getUrl();
});

// Lưu bằng chứng không chứa bí mật, đóng HTTP và chỉ xóa DB/thư mục do lượt kiểm thử này tạo.
after(async () => {
  await Promise.all([a?.close(), b?.close()]);
  const client = new MongoClient(mongoUri);
  try {
    await client.connect();
    assert.match(database, /^ptit_api_[a-f0-9]{32}$/);
    await client.db(database).dropDatabase();
  } finally {
    await client.close();
    if (root) await rm(root, { recursive: true, force: true });
  }
  const endpoints = [...new Set(traces.map((r) => `${r.method} ${r.endpoint}`))].filter((entry) =>
    entry.includes(' /api/'),
  );
  await mkdir(resolve('artifacts'), { recursive: true });
  await writeFile(
    resolve('artifacts/api-test-results.json'),
    JSON.stringify(
      {
        executedAt: new Date().toISOString(),
        transport: 'HTTP thực tế với NestJS và MongoDB riêng cho kiểm thử',
        apiEndpointsExercised: endpoints.length,
        requests: traces.length,
        statusMismatches: traces.filter((r) => r.expected !== r.actual).length,
        endpoints,
        traces,
      },
      null,
      2,
    ),
  );
});

// Kiểm tra ứng dụng định danh đúng đơn vị và chuyển trang gốc sang Swagger.
test('API: health A/B và chuyển hướng trang gốc', async () => {
  for (const [base, unitId] of [
    [baseA, 'don-vi-a'],
    [baseB, 'don-vi-b'],
  ]) {
    const response = await request(base, 'GET', '/api/health', 200);
    assert.deepEqual(await response.json(), { status: 'ok', unitId });
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  const rootResponse = await request(baseA, 'GET', '/', 302, { redirect: 'manual' });
  assert.equal(rootResponse.headers.get('location'), '/docs');
});

// Kiểm tra HTML, JavaScript Swagger và mô tả multipart phục vụ chọn tệp.
test('API: Swagger UI, tài nguyên JavaScript và OpenAPI được cung cấp', async () => {
  assert.match(await (await request(baseA, 'GET', '/docs', 200)).text(), /swagger-ui/);
  await request(baseB, 'GET', '/docs/swagger-ui-init.js', 200);
  const schema = (await (await request(baseB, 'GET', '/docs-json', 200)).json()) as ApiSchema;
  assert.ok(schema.paths['/api/envelopes/seal'].post);
  assert.ok(schema.paths['/api/keys/import'].post);
});

// Kho mới phải báo chưa khởi tạo và không trả tệp PEM giả khi chưa có khóa.
test('API: trạng thái khóa mới và tải public key khi chưa khởi tạo', async () => {
  for (const base of [baseA, baseB]) {
    const response = await request(base, 'GET', '/api/keys/status', 200);
    assert.equal(((await response.json()) as KeyState).initialized, false);
  }
  await request(baseA, 'GET', '/api/keys/public', 404);
});

// Kiểm tra mật khẩu, độ dài RSA, trường bắt buộc và việc từ chối trường dư qua HTTP.
test('API: generate từ chối đầu vào sai với HTTP 400', async () => {
  for (const body of [
    { passphrase: 'short', modulusLength: 2048 },
    { passphrase: passwordA, modulusLength: 1024 },
    { passphrase: passwordA },
    { passphrase: passwordA, modulusLength: 2048, unexpected: true },
  ]) {
    await request(baseA, 'POST', '/api/keys/generate', 400, json(body));
  }
});

// Xác minh API sinh khóa chỉ trả dữ liệu công khai và cập nhật trạng thái của A.
test('API: generate tạo khóa A và không tiết lộ khóa bí mật', async () => {
  const response = await request(
    baseA,
    'POST',
    '/api/keys/generate',
    201,
    json({ passphrase: passwordA, modulusLength: 2048 }),
  );
  keyA = (await response.json()) as KeyInfo;
  assert.match(keyA.publicKeyPem, /BEGIN PUBLIC KEY/);
  assert.match(keyA.fingerprint, /^[a-f0-9]{64}$/);
  assert.ok(!('privateKeyPem' in keyA));
  const state = (await (await request(baseA, 'GET', '/api/keys/status', 200)).json()) as KeyState;
  assert.equal(state.initialized, true);
  assert.equal(state.fingerprint, keyA.fingerprint);
});

// Nhập sai mật khẩu không được làm kho B mắc kẹt, lần nhập đúng vẫn phải thành công.
test('API: import khóa B xử lý sai mật khẩu rồi nhập đúng khóa PEM', async () => {
  await request(
    baseB,
    'POST',
    '/api/keys/import',
    400,
    json({ privateKeyPem: imported.privateKeyPem, passphrase: 'wrong-password-1234' }),
  );
  const response = await request(
    baseB,
    'POST',
    '/api/keys/import',
    201,
    json({ privateKeyPem: imported.privateKeyPem, passphrase: passwordB }),
  );
  keyB = (await response.json()) as KeyInfo;
  assert.equal(keyB.fingerprint, imported.fingerprint);
  assert.ok(!('privateKeyPem' in keyB));
});

// Kiểm tra nội dung tải PEM và việc từ chối mọi ý định ghi đè cặp khóa đang có.
test('API: tải public key và chặn ghi đè khóa đã sinh/nhập', async () => {
  for (const [base, key] of [
    [baseA, keyA],
    [baseB, keyB],
  ] as const) {
    const response = await request(base, 'GET', '/api/keys/public', 200);
    assert.match(response.headers.get('content-disposition') ?? '', /public.pem/);
    assert.equal(await response.text(), key.publicKeyPem);
  }
  await request(
    baseA,
    'POST',
    '/api/keys/generate',
    409,
    json({ passphrase: passwordA, modulusLength: 2048 }),
  );
  await request(
    baseB,
    'POST',
    '/api/keys/import',
    409,
    json({ privateKeyPem: imported.privateKeyPem, passphrase: passwordB }),
  );
});

// Danh mục đối tác phải phát hiện sai vân tay hoặc tự ghim chính mình.
test('API: peers từ chối sai vân tay và mã đơn vị của chính mình', async () => {
  const wrong = `${keyB.fingerprint[0] === '0' ? '1' : '0'}${keyB.fingerprint.slice(1)}`;
  await request(
    baseA,
    'POST',
    '/api/peers',
    400,
    json({ unitId: 'don-vi-b', publicKeyPem: keyB.publicKeyPem, expectedFingerprint: wrong }),
  );
  await request(
    baseA,
    'POST',
    '/api/peers',
    400,
    json({
      unitId: 'don-vi-a',
      publicKeyPem: keyA.publicKeyPem,
      expectedFingerprint: keyA.fingerprint,
    }),
  );
});

// Ghim khóa hai chiều, cho phép gửi lại cùng khóa nhưng chặn thay khóa đã tin cậy.
test('API: peers ghim khóa hai chiều và chặn thay khóa đối tác', async () => {
  for (const [base, peer] of [
    [baseA, keyB],
    [baseB, keyA],
  ] as const) {
    await request(
      base,
      'POST',
      '/api/peers',
      201,
      json({
        unitId: peer.unitId,
        publicKeyPem: peer.publicKeyPem,
        expectedFingerprint: peer.fingerprint,
      }),
    );
  }
  await request(
    baseA,
    'POST',
    '/api/peers',
    201,
    json({
      unitId: keyB.unitId,
      publicKeyPem: keyB.publicKeyPem,
      expectedFingerprint: keyB.fingerprint,
    }),
  );
  await request(
    baseA,
    'POST',
    '/api/peers',
    409,
    json({
      unitId: keyB.unitId,
      publicKeyPem: keyA.publicKeyPem,
      expectedFingerprint: keyA.fingerprint,
    }),
  );
});

// Kiểm tra lớp upload, tra cứu đối tác và mở khóa người gửi với các đầu vào không hợp lệ.
test('API: seal từ chối thiếu tệp, đối tác chưa ghim, sai mật khẩu và trích yếu dài', async () => {
  const empty = new FormData();
  empty.set('recipientId', 'don-vi-b');
  empty.set('passphrase', passwordA);
  await request(baseA, 'POST', '/api/envelopes/seal', 400, { body: empty });
  for (const [fields, code] of [
    [{ recipientId: 'unknown-unit', passphrase: passwordA }, 404],
    [{ recipientId: 'don-vi-b', passphrase: 'wrong-password-1234' }, 400],
    [{ recipientId: 'don-vi-b', passphrase: passwordA, subject: 'x'.repeat(501) }, 400],
  ] as const) {
    await request(baseA, 'POST', '/api/envelopes/seal', code, {
      body: upload(original, 'sample.bin', fields),
    });
  }
});

// Đóng gói qua multipart phải tạo đúng schema và chỉ lộ dữ liệu điều khiển ngoài bản mã.
test('API: seal trả phong bì JSON đúng cấu trúc Chương 2', async () => {
  wire = await seal();
  envelope = JSON.parse(wire.toString()) as Envelope;
  assert.deepEqual(Object.keys(envelope).sort(), ['header', 'payload']);
  assert.equal(Object.keys(envelope.header).length, 5);
  assert.equal(Object.keys(envelope.payload).length, 3);
  assert.equal(envelope.header.receiver_id, 'don-vi-b');
  assert.ok(!wire.includes(Buffer.from('Công văn 01.bin')));
});

// Verify được gọi nhiều lần mà vẫn cho phép nhận lần đầu bằng open.
test('API: verify xác nhận chữ ký và không tiêu thụ UUID', async () => {
  for (let i = 0; i < 2; i++) {
    const response = await request(baseB, 'POST', '/api/envelopes/verify', 200, {
      body: upload(wire, 'envelope.json'),
    });
    const result = (await response.json()) as { signatureValid: boolean; controlCheck: string };
    assert.equal(result.signatureValid, true);
    assert.equal(result.controlCheck, 'performed-after-decryption');
  }
});

// Bản mã bị sửa phải bị chặn ngay ở bước chữ ký, trước khi thử mở khóa bí mật.
test('API: bản mã bị sửa nhận 401 ở verify và open', async () => {
  const changed = structuredClone(envelope);
  const bytes = Buffer.from(changed.payload.encrypted_data, 'base64');
  bytes[0] ^= 1;
  changed.payload.encrypted_data = bytes.toString('base64');
  const value = Buffer.from(JSON.stringify(changed));
  await request(baseB, 'POST', '/api/envelopes/verify', 401, {
    body: upload(value, 'changed.json'),
  });
  await request(baseB, 'POST', '/api/envelopes/open', 401, {
    body: upload(value, 'changed.json', { passphrase: 'wrong-password-1234' }),
  });
});

// Sai mật khẩu không được đánh dấu đã nhận; lần thử đúng trả byte, tên tệp và header chính xác.
test('API: open sai mật khẩu rồi nhận thành công tệp có tên tiếng Việt', async () => {
  await request(baseB, 'POST', '/api/envelopes/open', 400, {
    body: upload(wire, 'envelope.json', { passphrase: 'wrong-password-1234' }),
  });
  const response = await request(baseB, 'POST', '/api/envelopes/open', 200, {
    body: upload(wire, 'envelope.json', { passphrase: passwordB }),
  });
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), original);
  assert.equal(response.headers.get('x-verified-sender'), 'don-vi-a');
  assert.equal(response.headers.get('x-message-id'), envelope.header.request_id);
  assert.equal(
    response.headers.get('x-content-sha256'),
    createHash('sha256').update(original).digest('hex'),
  );
  assert.ok(
    response.headers.get('content-disposition')?.includes(encodeURIComponent('Công văn 01.bin')),
  );
  openedId = response.headers.get('x-document-id')!;
  assert.match(openedId, /^[a-f0-9]{24}$/);
});

// Hai cách nhận phải dùng chung lịch sử chống phát lại, còn verify chỉ kiểm tra chữ ký.
test('API: chống phát lại giữa open và receive, verify vẫn không tiêu thụ UUID', async () => {
  await request(baseB, 'POST', '/api/envelopes/open', 409, {
    body: upload(wire, 'envelope.json', { passphrase: passwordB }),
  });
  await request(baseB, 'POST', '/api/envelopes/receive', 409, json(envelope));
  await request(baseB, 'POST', '/api/envelopes/verify', 200, {
    body: upload(wire, 'envelope.json'),
  });
});

// JSON body thật phải trả biên nhận có thể dùng để tải lại tài liệu từ GridFS.
test('API: receive nhận JSON mới và trả biên nhận hợp lệ', async () => {
  const fresh = JSON.parse((await seal()).toString()) as Envelope;
  const response = await request(baseB, 'POST', '/api/envelopes/receive', 200, json(fresh));
  receipt = (await response.json()) as Receipt;
  assert.equal(receipt.status, 'accepted');
  assert.equal(receipt.request_id, fresh.header.request_id);
  assert.match(receipt.document_id, /^[a-f0-9]{24}$/);
  assert.equal(receipt.download_url, `/api/documents/${receipt.document_id}`);
});

// Kiểm tra byte của cả tệp nhận qua open và receive, đồng thời chặn đọc tài liệu của đơn vị khác.
test('API: tải GridFS đúng byte và chặn ID sai hoặc tài liệu ngoài đơn vị', async () => {
  for (const id of [openedId, receipt.document_id]) {
    const response = await request(baseB, 'GET', `/api/documents/${id}`, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), original);
    assert.equal(response.headers.get('x-content-sha256'), receipt.sha256);
  }
  await request(baseA, 'GET', `/api/documents/${receipt.document_id}`, 404);
  await request(baseB, 'GET', '/api/documents/not-an-id', 400);
  await request(baseB, 'GET', `/api/documents/${'0'.repeat(24)}`, 404);
});

// Lỗi body được phản hồi bằng 400; thiếu cấu hình khóa nhận được phản hồi bằng 503.
test('API: receive xử lý body lỗi và thiếu cấu hình mật khẩu', async () => {
  await request(baseB, 'POST', '/api/envelopes/receive', 400);
  for (const body of [null, [], {}, { ...envelope, extra: true }]) {
    await request(baseB, 'POST', '/api/envelopes/receive', 400, json(body));
  }
  await request(baseA, 'POST', '/api/envelopes/receive', 503, json(envelope));
});

// Kiểm tra dữ liệu điều khiển và thời gian của phong bì nhận qua HTTP.
test('API: receive từ chối UUID, thời gian và Base64 sai', async () => {
  for (const mutate of [
    (e: Envelope) => {
      e.header.request_id = 'invalid';
    },
    (e: Envelope) => {
      e.header.timestamp = new Date(Date.now() - 301000).toISOString();
    },
    (e: Envelope) => {
      e.header.timestamp = new Date(Date.now() + 301000).toISOString();
    },
    (e: Envelope) => {
      e.payload.iv = '***';
    },
  ]) {
    const changed = structuredClone(envelope);
    mutate(changed);
    await request(baseB, 'POST', '/api/envelopes/receive', 400, json(changed));
  }
});

// Bộ đếm phải phân tách theo ownerId và không tăng khi các yêu cầu lỗi bị từ chối.
test('API: storage/status tách số bản ghi của A và B', async () => {
  for (const [base, unitId, receipts] of [
    [baseA, 'don-vi-a', 0],
    [baseB, 'don-vi-b', 2],
  ] as const) {
    const state = (await (
      await request(base, 'GET', '/api/storage/status', 200)
    ).json()) as StorageState;
    assert.equal(state.enabled, true);
    assert.equal(state.database, database);
    assert.equal(state.unitId, unitId);
    assert.equal(state.peers, 1);
    assert.equal(state.receipts, receipts);
  }
});

// Kiểm tra định dạng tệp thực tế qua cả luồng upload, receive và download.
test('API: truyền nhận PDF, DOCX và PNG đúng từng byte', async () => {
  for (const filename of ['cong-van.pdf', 'cong-van.docx', 'anh-mau.png']) {
    const file = await readFile(resolve('assets/samples', filename));
    const value = JSON.parse((await seal(file, filename)).toString());
    const accepted = (await (
      await request(baseB, 'POST', '/api/envelopes/receive', 200, json(value))
    ).json()) as Receipt;
    const response = await request(baseB, 'GET', accepted.download_url, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), file);
  }
});

// Chính sách origin phải cho phép Swagger cùng máy chủ và chặn origin khác.
test('API: middleware chặn origin khác và cho phép origin cùng máy chủ', async () => {
  await request(baseA, 'GET', '/api/health', 403, { headers: { Origin: 'https://example.org' } });
  await request(baseA, 'GET', '/api/health', 200, { headers: { Origin: baseA } });
});

// Bảo đảm cả 12 API công bố trong Swagger đã có ít nhất một lần thực thi thành công qua HTTP.
test('API: mọi endpoint OpenAPI đều được kiểm thử với luồng thành công', async () => {
  const schema = (await (await request(baseA, 'GET', '/docs-json', 200)).json()) as ApiSchema;
  const covered = new Set(
    traces.filter((r) => r.actual >= 200 && r.actual < 300).map((r) => `${r.method} ${r.endpoint}`),
  );
  const operations = Object.entries(schema.paths).flatMap(([path, methods]) =>
    Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
  );
  assert.equal(operations.length, 12);
  for (const operation of operations) assert.ok(covered.has(operation), operation);
});
