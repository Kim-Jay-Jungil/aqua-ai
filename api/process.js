import formidable from 'formidable';
import sharp from 'sharp';
import crypto from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

export const config = { api: { bodyParser: false } };

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});
const BUCKET = process.env.AWS_BUCKET;
const CDN_BASE = process.env.CDN_BASE; 
// 경로형 예: https://s3.us-east-1.amazonaws.com/aqua.ai-output

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
      const form = formidable({ multiples: false, keepExtensions: true, maxFileSize: 60 * 1024 * 1024 });
      form.parse(req, (err, fields, files) => err ? reject(err) : resolve({ fields, files }));
    });

    const f = Array.isArray(files.file) ? files.file[0] : files.file;
    if (!f) return res.status(400).json({ error: 'no file' });

    const models = JSON.parse(fields.models || '[]');
    let img = sharp(f.filepath).rotate(); // 원본 해상도

    if (models.includes('color_restore')) img = img.modulate({ saturation: 1.12 }).linear(1.06, -4);
    if (models.includes('dehaze'))        img = img.sharpen(1.5);
    if (models.includes('stabilize'))     img = img.sharpen(0.6);
    if (models.includes('superres')) {
      const meta = await img.metadata();
      if (meta.width) img = img.resize({ width: Math.round(meta.width * 1.5) });
    }

    const out = await img.jpeg({ quality: 92, mozjpeg: true }).toBuffer();

    const base = (fields.filename || f.originalFilename || 'image').replace(/\.[^.]+$/, '');
    const key = `submissions/${Date.now()}-${crypto.randomBytes(3).toString('hex')}/${base}_out.jpg`;

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: out,
      ContentType: 'image/jpeg'
    }));

    const url = `${CDN_BASE}/${key}`;
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.json({ url });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'process failed' });
  }
}
