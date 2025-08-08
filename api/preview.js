import formidable from 'formidable';
import sharp from 'sharp';

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { fields, files } = await new Promise((resolve, reject) => {
      const form = formidable({ multiples: false, keepExtensions: true });
      form.parse(req, (err, fields, files) => err ? reject(err) : resolve({ fields, files }));
    });

    const f = Array.isArray(files.file) ? files.file[0] : files.file;
    if (!f) return res.status(400).send('no file');

    const models = JSON.parse(fields.models || '[]');
    const maxWidth = parseInt(fields.max_width || '1280', 10);

    let img = sharp(f.filepath).rotate(); // EXIF 회전
    const meta = await img.metadata();
    if (meta.width && meta.width > maxWidth) img = img.resize({ width: maxWidth });

    // 간단 파이프라인(추후 AI로 교체)
    if (models.includes('color_restore')) img = img.modulate({ saturation: 1.1 }).linear(1.05, -5);
    if (models.includes('dehaze'))        img = img.sharpen(1.2);
    if (models.includes('stabilize'))     img = img.sharpen(0.5);

    const out = await img.jpeg({ quality: 90 }).toBuffer();
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.send(out);
  } catch (err) {
    console.error(err);
    return res.status(500).send('preview failed');
  }
}
