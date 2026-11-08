import { createCanvas } from '@napi-rs/canvas';
import type { ChartItem, Plugin } from 'chart.js' with { 'resolution-mode': 'import' };
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

interface ChartRow {
  originalBytes: number;
  sealMeanMs: number;
  openMeanMs: number;
}

// Dựng biểu đồ từ đúng số liệu đang đưa vào bảng Word, tránh dùng lại ảnh của lượt đo cũ.
export async function renderBenchmarkChart(
  rows: ChartRow[],
  executedAt: string,
  rounds: number,
): Promise<void> {
  const { Chart, registerables } = await import('chart.js');
  Chart.register(...registerables);
  const canvas = createCanvas(1440, 1080);
  const background: Plugin<'bar'> = {
    id: 'reportBackground',
    // Tô nền trước khi Chart.js vẽ, để PNG nhúng Word có nền sáng thay vì trong suốt.
    beforeDraw(chart) {
      const { ctx, width, height } = chart;
      ctx.save();
      ctx.fillStyle = '#fdfdfc';
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    },
  };
  const values: Plugin<'bar'> = {
    id: 'measuredValues',
    // Ghi giá trị đo lên từng cột; không điền số bằng chuỗi cố định trong ảnh.
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      ctx.save();
      ctx.font = '20px Arial';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#263746';
      chart.data.datasets.forEach((dataset, index) => {
        chart.getDatasetMeta(index).data.forEach((bar, column) => {
          ctx.fillText(Number(dataset.data[column]).toFixed(1), bar.x, bar.y - 12);
        });
      });
      ctx.restore();
    },
  };
  // Canvas Skia cung cấp API 2D tương thích Chart.js; cast chỉ nằm ở ranh giới thư viện vẽ.
  const chart = new Chart(canvas as unknown as ChartItem, {
    type: 'bar',
    data: {
      labels: rows.map((row) =>
        row.originalBytes < 1024 ** 2
          ? `${row.originalBytes / 1024} KiB`
          : `${row.originalBytes / 1024 ** 2} MiB`,
      ),
      datasets: [
        {
          label: 'Đóng gói / Seal',
          data: rows.map((row) => row.sealMeanMs),
          backgroundColor: '#334f68',
        },
        {
          label: 'Mở và lưu MongoDB / Open + Store',
          data: rows.map((row) => row.openMeanMs),
          backgroundColor: '#91a3ae',
        },
      ],
    },
    plugins: [background, values],
    options: {
      animation: false,
      responsive: false,
      devicePixelRatio: 1,
      layout: { padding: 55 },
      font: { family: 'Arial', size: 22 },
      plugins: {
        title: {
          display: true,
          text: 'Hiệu năng phong bì số theo đặc tả Chương 2',
          font: { size: 30 },
          padding: 25,
        },
        subtitle: {
          display: true,
          text: `Trung bình ${rounds} lượt/cỡ, có GridFS, không tính HTTP. Đo: ${executedAt}`,
          font: { size: 17 },
          padding: 16,
        },
        legend: { labels: { font: { size: 21 }, padding: 25 } },
      },
      scales: {
        x: {
          title: { display: true, text: 'Kích thước tệp gốc', font: { size: 24 } },
          ticks: { font: { size: 23 } },
          grid: { display: false },
        },
        y: {
          beginAtZero: true,
          suggestedMax:
            Math.max(...rows.map((row) => Math.max(row.sealMeanMs, row.openMeanMs))) * 1.2,
          title: { display: true, text: 'Thời gian trung bình (ms)', font: { size: 24 } },
          ticks: { font: { size: 21 } },
        },
      },
    },
  });
  try {
    await mkdir(resolve('docs/screenshots'), { recursive: true });
    await writeFile(resolve('docs/screenshots/hieu-nang.png'), canvas.toBuffer('image/png'));
    const data = { executedAt, rows };
    await writeFile(
      resolve('artifacts/report-chart.json'),
      JSON.stringify(
        { ...data, sha256: createHash('sha256').update(JSON.stringify(data)).digest('hex') },
        null,
        2,
      ),
    );
  } finally {
    chart.destroy();
  }
}
