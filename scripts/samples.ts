import { Document, Packer, Paragraph, TextRun } from 'docx';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

// Tạo PNG 1×1 pixel hợp lệ làm dữ liệu thử; không dùng đuôi .png để giả lập một tệp nhị phân bất kỳ.
function png(): Buffer {
  // Đóng một chunk PNG: độ dài, tên chunk, dữ liệu và CRC32 để trình đọc kiểm tra toàn vẹn cấu trúc.
  const chunk = (type: string, data: Buffer): Buffer => {
    const label = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([label, data])));
    return Buffer.concat([length, label, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 46, 80, 120]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Tạo PDF một trang tối giản, có bảng xref đúng vị trí byte để trình đọc PDF mở được.
function pdf(): Buffer {
  const stream =
    'BT /F1 18 Tf 60 760 Td (PTIT - SECURE ENVELOPE DEMO) Tj 0 -36 Td /F1 12 Tf (Cong van noi bo - du lieu thu nghiem) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let output = '%PDF-1.4\n';
  const offsets: number[] = [0];
  // Ghi từng object và nhớ vị trí bắt đầu để điền bảng tham chiếu xref phía cuối tệp.
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const start = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, '0')} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(output, 'ascii');
}

// Tạo ba tệp thật PDF/DOCX/PNG, lưu vào assets/samples và trả byte để demo gửi qua HTTP.
export async function createSamples() {
  const docx = await Packer.toBuffer(
    new Document({
      sections: [
        {
          children: [
            new Paragraph({ children: [new TextRun({ text: 'CÔNG VĂN THỬ NGHIỆM', bold: true })] }),
            new Paragraph('Đơn vị A gửi tài liệu cho đơn vị B bằng phong bì số.'),
            new Paragraph('Đây là dữ liệu thử nghiệm, không chứa thông tin mật thực tế.'),
          ],
        },
      ],
    }),
  );
  const samples = [
    { name: 'cong-van.pdf', mime: 'application/pdf', data: pdf() },
    {
      name: 'cong-van.docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      data: docx,
    },
    {
      name: 'anh-mau.png',
      mime: 'image/png',
      data: png(),
    },
  ];
  const dir = resolve('assets/samples');
  await mkdir(dir, { recursive: true });
  for (const sample of samples) await writeFile(resolve(dir, sample.name), sample.data);
  return samples;
}
