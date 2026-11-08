import { resolve } from 'node:path';

export const SETTINGS = Symbol('SETTINGS');
export const UNIT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export interface Settings {
  unitId: string;
  host: string;
  port: number;
  dataDir: string;
  maxFileBytes: number;
  timestampWindowSeconds: number;
  mongoUri?: string;
  mongoDbName?: string;
  receivePassphrase?: string;
}

// Đọc một biến môi trường dạng số nguyên; dùng giá trị mặc định khi chưa khai báo.
// Dừng khởi động nếu cấu hình vượt giới hạn để tránh chạy với tham số sai.
function integer(name: string, fallback: number, min: number, max: number): number {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} phải là số nguyên từ ${min} đến ${max}.`);
  }
  return value;
}

// Gom cấu hình của một đơn vị: danh tính, cổng HTTP, thư mục khóa và chính sách dung lượng/thời gian.
export function loadSettings(): Settings {
  const unitId = process.env.UNIT_ID ?? 'don-vi-a';
  if (!UNIT_ID_PATTERN.test(unitId)) throw new Error('UNIT_ID không hợp lệ.');
  // DATA_DIR được đổi thành đường dẫn tuyệt đối; mỗi đơn vị phải dùng thư mục riêng.
  return {
    unitId,
    host: process.env.HOST ?? '127.0.0.1',
    port: integer('PORT', 3000, 0, 65535),
    dataDir: resolve(process.env.DATA_DIR ?? `data/${unitId}`),
    maxFileBytes: integer('MAX_FILE_SIZE_MB', 10, 1, 100) * 1024 * 1024,
    timestampWindowSeconds: integer('TIMESTAMP_WINDOW_SECONDS', 300, 1, 3600),
    mongoUri: process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27018',
    mongoDbName: process.env.MONGODB_DATABASE ?? 'ptit_envelope',
    receivePassphrase: process.env.RECEIVE_KEY_PASSPHRASE,
  };
}
