// api/process.js
import formidable from 'formidable';
import sharp from 'sharp';
import crypto from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { Client as NotionClient } from '@notionhq/client';

export const config = { api: { bodyParser: false } };

/** ===== 환경변수 ===== */
const REGION = process.env.AWS_REGION || 'us-east-1';
const BUCKET = process.env.AWS_BUCKET;                       // ex) aqua.ai-output
const CDN_BASE_ENV = process.env.CDN_BASE || '';             // ex) https://s3.us-east-1.amazonaws.com/aqua.ai-output
const ALLOWED = process.env.ALLOWED_ORIGIN || '*';
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || '60');

const NOTION_TOKEN = process.env.NOTION_TOKEN || '';
const NOTION_DB = process.env.NOTION_SUBMISSIONS_DB_ID || '';

/** ===== S3 (경로형) ===== */
const s3 = new S3Client({
  region: REGION,
  endpoint: `https://s3.${REGION}.amazonaws.com`,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});
const cdnBase = (CDN_BASE_ENV || `https://s3.${REGION}.amazonaws.com/${BUCKET}`).replace(/\/+$/, '');

/** ===== Notion ===== */
const notion = (NOTION_TOKEN && NOTION_DB) ? new NotionClient({ auth: NOTION_TOKEN }) : null;

/** ===== 유틸 ===== */
function parseForm(req) {
  return new Promise((resolve, reject) => {
    const form = formidable({ multiples: true, keepExtensions: true, maxFileSize: MAX_FILE_MB * 1024 * 1024 });
    form.parse(req, (err, fields, files) => (err ? reject(err) : resolve({ fields, files })));
  });
}
function pickFirstFile(files) {
  if (!files) return null;
  for (const v of Object.values(files)) {
    if (!v) continue;
    if (Array.isArray(v)) { if (v[0]) return v[0]; }
    else return v;
  }
  return null;
}
function strField(val) {
  if (val == null) return '';
  if (Array.isArray(val)) return typeof val[0] === 'string' ? val[0] : '';
  return typeof val === 'string' ? val : '';
}
function sanitizeBase(name) {
  const s = strField(name);
  return (s ? s : 'image')
    .split(/[/\\]/).pop()
    .replace(/\.[^.]+$/, '')
    .normalize('NFKD')
    .replace(/[^\w\-]+/g, '_')
    .slice(0, 64) || 'image';
}
async function applyWatermarkBar(img, label = 'aqua.ai • preview') {
  const meta = await img.metadata();
  const w = meta.width || 1200, h = meta.height || 800;
  const barH = Math.max(Math.round(w * 0.06), 40);
  const font = Math.max(Math.round(barH * 0.5), 16);
  const svg = `
  <svg width="${w}" height="${barH}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${w}" height="${barH}" fill="rgba(0,0,0,0.35)"/>
    <text x="${w - 16}" y="${Math.round(barH * 0.68)}" text-anchor="end"
      style="font:${font}px Inter, Arial, sans-serif; fill:#fff; letter-spacing:.5px;">${label}</text>
  </svg>`;
  return img.composite([{ input: Buffer.from(svg), left: 0, top: h - barH }]);
}

/** ===== 메인 핸들러 ===== */
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  if (req.method !== 'POST') return res.status(405).end();

  if (!BUCKET) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED);
    return res.status(500).json({ error: 'missing env: AWS_BUCKET' });
  }

  try {
    const { fields, files } = await parseForm(req);
    const f = pickFirstFile(files);
    if (!f) {
      res.setHeader('Access-Control-Allow-Origin', ALLOWED);
      return res.status(400).json({ error: 'no file received' });
    }

    // 입력 필드
    const email = strField(fields.email);
    const consentGallery = strField(fields.consent_gallery) === '1';
    const consentTraining = strField(fields.consent_training) === '1';
    let models = [];
    try { models = JSON.parse(strField(fields.models) || '[]'); } catch {}
    const wm = strField(fields.wm) === '1'; // 현재는 항상 '1'로 보낼 예정

    // 이미지 처리
    let img = sharp(f.filepath).rotate().withMetadata(); // EXIF/ICC 유지
    if (models.includes('color_restore')) img = img.modulate({ saturation: 1.12 }).linear(1.06, -4);
    if (models.includes('dehaze'))        img = img.sharpen(1.5);
    if (models.includes('stabilize'))     img = img.sharpen(0.6);
    if (models.includes('superres')) {
      const meta = await img.metadata();
      if (meta.width) img = img.resize({ width: Math.round(meta.width * 1.5) });
    }
    if (wm) img = await applyWatermarkBar(img);

    const out = await img.jpeg({ quality: 92, mozjpeg: true }).toBuffer();

    // 업로드
    const base = sanitizeBase(strField(fields.filename) || f.originalFilename);
    const folder = new Date().toISOString().slice(0,10).replace(/-/g,'/');
    const key = `submissions/${folder}/${Date.now()}-${crypto.randomBytes(3).toString('hex')}/${base}_out.jpg`;

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: out,
      ContentType: 'image/jpeg'
    }));

    const url = `${cdnBase}/${key}`;

    // Notion 기록 (실패해도 처리 결과는 반환)
    if (notion) {
      try {
        await notion.pages.create({
          parent: { database_id: NOTION_DB },
          properties: {
            Name: { title: [{ text: { content: base } }] },
            Email: email ? { email } : { email: null },
            Models: { multi_select: models.map(m => ({ name: m })) },
            Status: { select: { name: 'Done' } }, // 사전에 'Done' 옵션 생성해 두세요
            OutputURL: { url },
            ConsentGallery: { checkbox: consentGallery },
            ConsentTraining: { checkbox: consentTraining },
            CreatedAt: { date: { start: new Date().toISOString() } },
            CompletedAt: { date: { start: new Date().toISOString() } }
          }
        });
      } catch (e) {
        console.error('[notion] create failed:', e?.message || e);
      }
    }

    res.setHeader('Access-Control-Allow-Origin', ALLOWED);
    return res.status(200).json({ url, key, bytes: out.length, wm });
  } catch (err) {
    console.error('[process] error:', err);
    res.setHeader('Access-Control-Allow-Origin', ALLOWED);
    const msg = String(err?.message || '').toLowerCase();
    if (msg.includes('max file size'))   return res.status(413).json({ error: 'file too large', limit_mb: MAX_FILE_MB });
    if (msg.includes('accessdenied') || msg.includes('signature') || msg.includes('invalidaccesskeyid'))
      return res.status(403).json({ error: 's3 access denied (check IAM keys/policy/bucket region)' });
    if (msg.includes('unsupported') || msg.includes('input buffer'))
      return res.status(415).json({ error: 'unsupported image format' });
    return res.status(500).json({ error: 'process failed', code: err?.name || 'Unknown' });
  }
}
