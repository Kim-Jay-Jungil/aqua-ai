import formidable from 'formidable';
import sharp from 'sharp';

export const config = { api: { bodyParser: false } };

// 폼 파싱 헬퍼
function parseForm(req) {
  return new Promise((resolve, reject) => {
    const form = formidable({
      multiples: true,
      keepExtensions: true
      // preview는 용량 제한 굳이 두지 않음(원하면 maxFileSize 추가)
    });
    form.parse(req, (err, fields, files) => (err ? reject(err) : resolve({ fields, files })));
  });
}

// 어떤 키로 오든 "첫 번째 파일"을 선택
function pickFirstFile(files) {
  if (!files) return null;
  for (const v of Object.values(files)) {
    if (!v) continue;
    if (Array.isArray(v)) {
      if (v[0]) return v[0];
    } else {
      return v;
    }
  }
  return null;
}

export default async function handler(req, res) {
  // CORS
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { fields, files } = await parseForm(req);
    const f = pickFirstFile(files);
    if (!f) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(400).json({ error: 'no file received' });
    }

    // models/max_width 안전 파싱
    let models = [];
    try { models = JSON.parse(fields.models || '[]'); } catch {}
    const maxWidth = Number.parseInt(fields.max_width || '1280', 10);

    let img = sharp(f.filepath).rotate(); // EXIF 회전
    const meta = await img.metadata();
    if (meta.width && meta.width > maxWidth) img = img.resize({ width: maxWidth });

    // 간단 파이프라인(추후 AI 교체)
    if (models.includes('color_restore')) img = img.modulate({ saturation: 1.1 }).linear(1.05, -5);
    if (models.includes('dehaze'))        img = img.sharpen(1.2);
    if (models.includes('stabilize'))     img = img.sharpen(0.5);

    const out = await img.jpeg({ quality: 90 }).toBuffer();
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.send(out);
  } catch (err) {
    console.error(err);
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (String(err?.message || '').toLowerCase().includes('max file size')) {
      return res.status(413).json({ error: 'file too large' });
    }
    return res.status(500).json({ error: 'preview failed' });
  }
}
