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
const NOTION_SUB_DB = process.env.NOTION_SUBMISSIONS_DB_ID || '';
const NOTION_ORIG_DB = process.env.NOTION_ORIGINALS_DB_ID || '';

/** ========= Notion 속성 매핑(여기만 수정하면 됨) =========
 *  ⬇️ 여러분 DB의 실제 속성 이름으로 맞춰 주세요.
 *  제목(Title) 속성도 원하는 이름으로 바꿀 수 있습니다.
 */
const MAP = {
  SUB: {
    title: 'Name',               // Title
    email: 'Email',              // Email
    models: 'Models',            // Multi-select
    status: 'Status',            // Select (예: Done/Error 옵션)
    outputUrl: 'OutputURL',      // URL (결과 S3/CloudFront)
    originalUrl: 'OriginalURL',  // URL (원본 S3/CloudFront)
    consentGallery: 'ConsentGallery',   // Checkbox
    consentTraining: 'ConsentTraining', // Checkbox
    createdAt: 'CreatedAt',      // Date
    completedAt: 'CompletedAt',  // Date
    relationOriginal: 'Original' // Relation → 대상은 Originals DB
  },
  ORIG: {
    title: 'Name',               // Title
    email: 'Email',              // Email
    url: 'URL',                  // URL (원본 S3/CloudFront)
    s3key: 'S3Key',              // Rich text
    size: 'SizeBytes',           // Number
    mimetype: 'MimeType',        // Rich text
    retentionDays: 'RetentionDays',     // Number
    relationSubmission: 'Submission',   // Relation → 대상은 Submissions DB (선택)
    filePreview: 'OriginalFile',        // Files & media (선택)
    createdAt: 'CreatedAt'              // Date (있으면 사용)
  },
  STATUS_OPTIONS: ['Done', 'Error']     // Status 셀렉트 옵션 이름(여러분 DB에 미리 있거나, 아래 ensure에서 추가)
};

/** ========= S3 (경로형) ========= */
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
const notion = (NOTION_TOKEN ? new NotionClient({ auth: NOTION_TOKEN }) : null);

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

/** ========= Notion 보조: 옵션 보장 ========= */
async function ensureSelectOptions(dbId, propName, names, type /* 'select' | 'multi_select' */) {
  if (!notion || !dbId || !propName || !Array.isArray(names) || names.length === 0) return;
  const db = await notion.databases.retrieve({ database_id: dbId });
  const prop = db.properties?.[propName];
  if (!prop || (prop.type !== type)) return; // 타입이 다르면 건너뜀

  const existing = new Set((prop[type]?.options || []).map(o => o.name));
  const missing = names.filter(n => n && !existing.has(n));
  if (missing.length === 0) return;

  const newOptions = [...(prop[type]?.options || []), ...missing.map(n => ({ name: n }))];
  await notion.databases.update({
    database_id: dbId,
    properties: {
      [propName]: { [type]: { options: newOptions } }
    }
  });
}

/** ========= 메인 ========= */
export default async function handler(req, res) {
  // CORS
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

    // 입력 값
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

    // 3) 처리 파이프라인 → JPG
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
    let originalPageId = null;

    if (notion && NOTION_ORIG_DB) {
      try {
        // Originals 페이지 생성
        const props = {
          [MAP.ORIG.title]: { title: [{ text: { content: baseName } }] },
          ...(MAP.ORIG.email ? { [MAP.ORIG.email]: email ? { email } : { email: null } } : {}),
          ...(MAP.ORIG.url ? { [MAP.ORIG.url]: { url: origUrl } } : {}),
          ...(MAP.ORIG.s3key ? { [MAP.ORIG.s3key]: { rich_text: [{ text: { content: origKey } }] } } : {}),
          ...(MAP.ORIG.size ? { [MAP.ORIG.size]: { number: origBuf.length } } : {}),
          ...(MAP.ORIG.mimetype ? { [MAP.ORIG.mimetype]: { rich_text: [{ text: { content: f.mimetype || '' } }] } } : {}),
          ...(MAP.ORIG.createdAt ? { [MAP.ORIG.createdAt]: { date: { start: new Date().toISOString() } } } : {}),
          ...(MAP.ORIG.retentionDays ? { [MAP.ORIG.retentionDays]: { number: 30 } } : {})
        };
        // (선택) 파일 미리보기 필드
        if (MAP.ORIG.filePreview) {
          props[MAP.ORIG.filePreview] = { files: [{ name: `${baseName}${ext}`, external: { url: origUrl } }] };
        }
        const origPage = await notion.pages.create({ parent: { database_id: NOTION_ORIG_DB }, properties: props });
        originalPageId = origPage.id;
      } catch (e) {
        console.error('[notion] originals create failed:', e?.message || e);
      }
    }

    if (notion && NOTION_SUB_DB) {
      try {
        // 상태/모델 옵션 보장(없으면 자동 추가)
        await ensureSelectOptions(NOTION_SUB_DB, MAP.SUB.status, MAP.STATUS_OPTIONS, 'select');
        await ensureSelectOptions(NOTION_SUB_DB, MAP.SUB.models, models, 'multi_select');

        // Submissions 페이지 생성
        const props = {
          [MAP.SUB.title]: { title: [{ text: { content: baseName } }] },
          ...(MAP.SUB.email ? { [MAP.SUB.email]: email ? { email } : { email: null } } : {}),
          ...(MAP.SUB.models ? { [MAP.SUB.models]: { multi_select: models.map(m => ({ name: m })) } } : {}),
          ...(MAP.SUB.status ? { [MAP.SUB.status]: { select: { name: MAP.STATUS_OPTIONS[0] } } } : {}), // 'Done'
          ...(MAP.SUB.outputUrl ? { [MAP.SUB.outputUrl]: { url: outUrl } } : {}),
          ...(MAP.SUB.originalUrl ? { [MAP.SUB.originalUrl]: { url: origUrl } } : {}),
          ...(MAP.SUB.consentGallery ? { [MAP.SUB.consentGallery]: { checkbox: !!consentGallery } } : {}),
          ...(MAP.SUB.consentTraining ? { [MAP.SUB.consentTraining]: { checkbox: !!consentTraining } } : {}),
          ...(MAP.SUB.createdAt ? { [MAP.SUB.createdAt]: { date: { start: new Date().toISOString() } } } : {}),
          ...(MAP.SUB.completedAt ? { [MAP.SUB.completedAt]: { date: { start: new Date().toISOString() } } } : {}),
          ...(MAP.SUB.relationOriginal && originalPageId ? { [MAP.SUB.relationOriginal]: { relation: [{ id: originalPageId }] } } : {})
        };

        const subPage = await notion.pages.create({ parent: { database_id: NOTION_SUB_DB }, properties: props });

        // (선택) Originals 쪽 Relation도 채우고 싶으면
        if (originalPageId && MAP.ORIG.relationSubmission) {
          try {
            await notion.pages.update({
              page_id: originalPageId,
              properties: { [MAP.ORIG.relationSubmission]: { relation: [{ id: subPage.id }] } }
            });
          } catch (e) {
            console.error('[notion] originals update relation failed:', e?.message || e);
          }
        }
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
