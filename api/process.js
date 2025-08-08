import formidable from 'formidable';
import sharp from 'sharp';
import crypto from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

export const config = { api: { bodyParser: false } };

/** ===== 환경변수 ===== */
const REGION = process.env.AWS_REGION || 'us-east-1';
const BUCKET = process.env.AWS_BUCKET;                       // ex) aqua.ai-output
const CDN_BASE_ENV = process.env.CDN_BASE || '';             // ex) https://s3.us-east-1.amazonaws.com/aqua.ai-output
const ALLOWED = process.env.ALLOWED_ORIGIN || '*';
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || '60');

/** ===== S3 클라이언트 (경로형 + 고정 endpoint) ===== */
const s3 = new S3Client({
  region: REGION,
  endpoint: `https://s3.${REGION}.amazonaws.com`,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

/** CDN 기본 주소(경로형) */
function buildCdnBase() {
  return (CDN_BASE_ENV || `https://s3.${REGION}.amazonaws.com/${BUCKET}`).replace(/\/+$/, '');
}

/** multipart 파싱 */
function parseForm(req) {
  return new Promise((resolve, reject) => {
    const form = formidable({
      multiples: true,
      keepExtensions: true,
      maxFileSize: MAX_FILE_MB * 1024 * 1024
    });
    form.parse(req, (err, fields, files) => (err ? reject(err) : resolve({ fields, files })));
  });
}

/** 첫 번째 파일 집기(키 이름 무관) */
function pickFirstFile(files) {
  if (!files) return null;
  for (const v of Object.values(files)) {
    if (!v) continue;
    if (Array.isArray(v)) { if (v[0]) return v[0]; }
    else return v;
  }
  return null;
}

/** Formidable이 주는 값 → 안전한 문자열로 */
function strField(val) {
  if (val == null) return '';
  if (Array.isArray(val)) return typeof val[0] === 'string' ? val[0] : '';
  return typeof val === 'string' ? val : '';
}

/** 파일명 안전화 (문자열이 아닐 경우도 안전 처리) */
function sanitizeBase(name) {
  const s = strField(name);  // 배열/객체 → ''
  return (s ? s : 'image')
    .split(/[/\\]/).pop()          // 경로 조각 제거 (C:\fakepath\..)
    .replace(/\.[^.]+$/, '')       // 확장자 제거
    .normalize('NFKD')
    .replace(/[^\w\-]+/g, '_')     // 특수문자 → _
    .slice(0, 64) || 'image';
}

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
    // 1) 폼 파싱 + 파일 확보
    const { fields, files } = await parseForm(req);
    const f = pickFirstFile(files);
    if (!f) {
      res.setHeader('Access-Control-Allow-Origin', ALLOWED);
      return res.status(400).json({ error: 'no file received' });
    }

    // 2) 옵션 파싱
    let models = [];
    try { models = JSON.parse(strField(fields.models) || '[]'); } catch {}

    // 3) 이미지 처리 파이프라인
    let img = sharp(f.filepath).rotate();
    if (models.includes('color_restore')) img = img.modulate({ saturation: 1.12 }).linear(1.06, -4);
    if (models.includes('dehaze'))        img = img.sharpen(1.5);
    if (models.includes('stabilize'))     img = img.sharpen(0.6);
    if (models.includes('superres')) {
      const meta = await img.metadata();
      if (meta.width) img = img.resize({ width: Math.round(meta.width * 1.5) });
    }
    const out = await img.jpeg({ quality: 92, mozjpeg: true }).toBuffer();

    // 4) 업로드 키 만들기
    const base = sanitizeBase(strField(fields.filename) || f.originalFilename);
    const folder = new Date().toISOString().slice(0,10).replace(/-/g,'/'); // yyyy/mm/dd
    const key = `submissions/${folder}/${Date.now()}-${crypto.randomBytes(3).toString('hex')}/${base}_out.jpg`;

    // 5) S3 업로드
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: out,
      ContentType: 'image/jpeg'
      // Object Ownership = Bucket owner enforced → ACL 불필요
    }));

    // 6) 응답
    const url = `${buildCdnBase()}/${key}`;
    res.setHeader('Access-Control-Allow-Origin', ALLOWED);
    return res.status(200).json({ url, key, bytes: out.length });
  } catch (err) {
    console.error('[process] error:', err);
    res.setHeader('Access-Control-Allow-Origin', ALLOWED);

    const msg = String(err?.message || '').toLowerCase();
    if (msg.includes('max file size')) {
      return res.status(413).json({ error: 'file too large', limit_mb: MAX_FILE_MB });
    }
    if (msg.includes('accessdenied') || msg.includes('signature') || msg.includes('invalidaccesskeyid')) {
      return res.status(403).json({ error: 's3 access denied (check IAM keys/policy/bucket region)' });
    }
    if (msg.includes('unsupported') || msg.includes('input buffer')) {
      return res.status(415).json({ error: 'unsupported image format' });
    }
    return res.status(500).json({ error: 'process failed', code: err?.name || 'Unknown' });
  }
}
