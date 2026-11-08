import { join } from 'node:path';
import { Settings } from '../src/config';

// Tạo cấu hình cô lập cho một đơn vị thử nghiệm; cổng 0 để hệ điều hành chọn cổng HTTP còn trống.
export function demoSettings(root: string, unitId: string): Settings {
  return {
    unitId,
    host: '127.0.0.1',
    port: 0,
    dataDir: join(root, unitId),
    maxFileBytes: 10 * 1024 * 1024,
    timestampWindowSeconds: 300,
    mongoUri: process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27018',
    mongoDbName: process.env.MONGODB_DATABASE ?? 'ptit_envelope_demo',
  };
}

// Gửi JSON đến API và kiểm tra mã HTTP mong đợi; sai mã thì dừng demo bằng lỗi có ngữ cảnh.
export async function jsonPost(base: string, path: string, body: unknown, expectedStatus = 201) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (response.status !== expectedStatus)
    throw new Error(`${path}: HTTP ${response.status}: ${await response.text()}`);
  return response.json() as Promise<Record<string, string>>;
}

// Ghép byte tệp và các trường văn bản thành FormData giống biểu mẫu upload của Swagger.
export function upload(
  file: Buffer,
  filename: string,
  fields: Record<string, string> = {},
  mimeType = 'application/octet-stream',
): FormData {
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(file)], { type: mimeType }), filename);
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}
