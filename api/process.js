// api/process.js
import formidable from 'formidable';
import sharp from 'sharp';
import crypto from 'crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { Client as NotionClient } from '@notionhq/client';

export const config = { api: { bodyParser: false } };

/** ========= 환경변수 ========= */
const REGION = process.env.AWS_REGION || 'us-east-1';
const BUCKET = process.env.AWS_BUCKET; // ex) aqua.ai-output
const CDN_BASE_ENV = process.env.CDN_BASE || ''; // ex) https://s3.us-east-1.amazonaws.com/aqua.ai-output
const ALLOWED = process.env.ALLOWED_ORIGIN || '*';
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || '60');

const NOTION_TOKEN = process.env.NOTION_TOKEN || '';
// 우선 env를 쓰고, 없으면 요청 주신 ID로 fallback
const NOTION_SUB_DB =
  process.env.NOTION_SUBMISSIONS_DB_ID || '249bf939a7af80d6a280fa0a6bf68211';

/** ========= 여러분의 Submissions DB 실제 속성명 매핑 ========= */
const MAP = {
  title: 'Name',                 // Title
  email: 'user_email',           // Email
  models: 'models',              // Multi-select
  status: 'status',              // Status 또는 Select
  watermark: 'watermark',        // Checkbox (있을 때)
  originalFiles: 'original_files', // Files & media (원본 URL 외부첨부)
  originalUrl: 'original_links', // URL (원본 S3/CloudFront)
  outputUrl: 'output_links',     // URL (결과 S3/CloudFront)
  createdAt: 'created_at',       // Date or Rich text
  completedAt: 'completed_at',   // Checkbox or Date or Rich text
  consentGallery: 'consent_gallery',   // Checkbox
  consentTraining: 'consent_training', // Checkbox
  notes: 'notes'                 // Rich text (선택)
};

const STATUS_DONE = 'Done';

/** ========= S3 (경로형; dot 포함 버킷 호환) ========= */
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

/** ========= Notion ========= */
const notion = (NOTION_TOKEN && NOTION_SUB_DB) ? new NotionClient({ auth: NOTION_TOKEN }) : null;

/** ========= 유틸 ========= */
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

/** ========= DB 속성 타입 조회 ========= */
async function getDbPropsMeta(dbId) {
  if (!notion || !dbId) return null;
  try {
    const db = await notion.databases.retrieve({ database_id: dbId });
    return Object.fromEntries(Object.entries(db.properties || {}).map(([k, v]) => [k, v.type]));
  } catch (e) {
    console.error('[notion] retrieve db failed:', e?.message || e);
    return null;
  }
}

/** ========= Select/Multi-select 옵션 보장 ========= */
async function ensureSelectOptionIfNeeded(dbId, propName, valueName) {
  if (!notion || !dbId || !propName || !valueName) return;
  const db = await notion.databases.retrieve({ database_id: dbId });
  const prop = db.properties?.[propName];
  if (!prop) return;
  if (prop.type === 'select') {
    const existing = new Set((prop.select?.options || []).map(o => o.name));
    if (!existing.has(valueName)) {
      const newOptions = [...(prop.select?.options || []), { name: valueName }];
      await notion.databases.update({
        database_id: dbId,
        properties: { [propName]: { select: { options: newOptions } } }
      });
    }
  }
}

/** ========= 메인 ========= */
export default async function handler(req, res) {
  // CORS 프리플라이트
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
    // 1) 폼 파싱
    const { fields, files } = await parseForm(req);
    const f = pickFirstFile(files);
    if (!f) {
      res.setHeader('Access-Control-Allow-Origin', ALLOWED);
      return res.status(400).json({ error: 'no file received' });
    }
    const email = strField(fields.email);
    const consentGallery = strField(fields.consent_gallery) === '1';
    const consentTraining = strField(fields.consent_training) === '1';
    const models = (() => { try { return JSON.parse(strField(fields.models) || '[]'); } catch { return []; } })();
    const wm = strField(fields.wm) === '1';

    // 2) 원본 업로드
    const baseName = sanitizeBase(strField(fields.filename) || f.originalFilename);
    const ext = (path.extname(strField(fields.filename) || f.originalFilename || '') || '').slice(0, 10).toLowerCase() || '.bin';
    const folder = new Date().toISOString().slice(0,10).replace(/-/g,'/');
    const origKey = `originals/${folder}/${Date.now()}-${crypto.randomBytes(3).toString('hex')}/${baseName}${ext}`;
    const origBuf = await fs.readFile(f.filepath);
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: origKey,
      Body: origBuf,
      ContentType: f.mimetype || 'application/octet-stream'
    }));
    const origUrl = `${cdnBase}/${origKey}`;

    // 3) 처리 → JPG
    let img = sharp(f.filepath).rotate().withMetadata();
    if (models.includes('color_restore')) img = img.modulate({ saturation: 1.12 }).linear(1.06, -4);
    if (models.includes('dehaze'))        img = img.sharpen(1.5);
    if (models.includes('stabilize'))     img = img.sharpen(0.6);
    if (models.includes('superres')) {
      const meta = await img.metadata();
      if (meta.width) img = img.resize({ width: Math.round(meta.width * 1.5) });
    }
    if (wm) img = await applyWatermarkBar(img);

    const out = await img.jpeg({ quality: 92, mozjpeg: true }).toBuffer();
    const outKey = `submissions/${folder}/${Date.now()}-${crypto.randomBytes(3).toString('hex')}/${baseName}_out.jpg`;
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: outKey,
      Body: out,
      ContentType: 'image/jpeg'
    }));
    const outUrl = `${cdnBase}/${outKey}`;

    // 4) Notion 기록
    if (notion && NOTION_SUB_DB) {
      try {
        const meta = await getDbPropsMeta(NOTION_SUB_DB);

        // status가 select면 'Done' 옵션 보장
        if (meta?.[MAP.status] === 'select') {
          await ensureSelectOptionIfNeeded(NOTION_SUB_DB, MAP.status, STATUS_DONE);
        }
        // models가 multi_select면 옵션 자동 추가
        if (meta?.[MAP.models] === 'multi_select' && models.length) {
          const db = await notion.databases.retrieve({ database_id: NOTION_SUB_DB });
          const exist = new Set((db.properties?.[MAP.models]?.multi_select?.options || []).map(o => o.name));
          const missing = models.filter(m => m && !exist.has(m));
          if (missing.length) {
            const newOptions = [...(db.properties?.[MAP.models]?.multi_select?.options || []), ...missing.map(n => ({ name: n }))];
            await notion.databases.update({
              database_id: NOTION_SUB_DB,
              properties: { [MAP.models]: { multi_select: { options: newOptions } } }
            });
          }
        }

        const props = {};

        if (MAP.title && meta?.[MAP.title] === 'title') {
          props[MAP.title] = { title: [{ text: { content: baseName } }] };
        }
        if (MAP.email && meta?.[MAP.email] === 'email') {
          props[MAP.email] = email ? { email } : { email: null };
        }
        if (MAP.models && meta?.[MAP.models] === 'multi_select') {
          props[MAP.models] = { multi_select: models.map(m => ({ name: m })) };
        }
        if (MAP.status && meta?.[MAP.status]) {
          if (meta[MAP.status] === 'select') props[MAP.status] = { select: { name: STATUS_DONE } };
          else if (meta[MAP.status] === 'status') props[MAP.status] = { status: { name: STATUS_DONE } };
        }
        if (MAP.watermark && meta?.[MAP.watermark] === 'checkbox') {
          props[MAP.watermark] = { checkbox: !!wm };
        }

        // 원본
        if (MAP.originalUrl && meta?.[MAP.originalUrl] === 'url') {
          props[MAP.originalUrl] = { url: origUrl };
        }
        if (MAP.originalFiles && meta?.[MAP.originalFiles] === 'files') {
          props[MAP.originalFiles] = { files: [{ name: `${baseName}${ext}`, external: { url: origUrl } }] };
        }

        // 결과
        if (MAP.outputUrl && meta?.[MAP.outputUrl] === 'url') {
          props[MAP.outputUrl] = { url: outUrl };
        }

        // 동의/시간/메모
        if (MAP.consentGallery && meta?.[MAP.consentGallery] === 'checkbox') {
          props[MAP.consentGallery] = { checkbox: !!consentGallery };
        }
        if (MAP.consentTraining && meta?.[MAP.consentTraining] === 'checkbox') {
          props[MAP.consentTraining] = { checkbox: !!consentTraining };
        }
        const nowIso = new Date().toISOString();
        if (MAP.createdAt && meta?.[MAP.createdAt]) {
          if (meta[MAP.createdAt] === 'date') props[MAP.createdAt] = { date: { start: nowIso } };
          else if (meta[MAP.createdAt] === 'rich_text') props[MAP.createdAt] = { rich_text: [{ text: { content: nowIso } }] };
        }
        if (MAP.completedAt && meta?.[MAP.completedAt]) {
          if (meta[MAP.completedAt] === 'date') props[MAP.completedAt] = { date: { start: nowIso } };
          else if (meta[MAP.completedAt] === 'checkbox') props[MAP.completedAt] = { checkbox: true };
          else if (meta[MAP.completedAt] === 'rich_text') props[MAP.completedAt] = { rich_text: [{ text: { content: nowIso } }] };
        }
        if (MAP.notes && meta?.[MAP.notes] === 'rich_text') {
          props[MAP.notes] = { rich_text: [{ text: { content: 'Processed via API v1' } }] };
        }

        await notion.pages.create({ parent: { database_id: NOTION_SUB_DB }, properties: props });
      } catch (e) {
        console.error('[notion] submissions create failed:', e?.message || e);
      }
    }

    // 5) 응답
    res.setHeader('Access-Control-Allow-Origin', ALLOWED);
    return res.status(200).json({
      url: outUrl,
      key: outKey,
      bytes: out.length,
      wm,
      original: { url: origUrl, key: origKey, bytes: origBuf.length, mimetype: f.mimetype || '' }
    });
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
