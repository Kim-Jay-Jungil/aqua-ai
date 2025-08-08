import formidable from 'formidable';
import sharp from 'sharp';
import crypto from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

export const config = { api: { bodyParser: false } };

/** ====== 환경설정 ====== **/
const REGION = process.env.AWS_REGION || 'us-east-1';
const BUCKET = process.env.AWS_BUCKET;                       // ex) aqua.ai-output
const CDN_BASE_ENV = process.env.CDN_BASE || '';             // ex) https://s3.us-east-1.amazonaws.com/aqua.ai-output
const ALLOWED = process.env.ALLOWED_ORIGIN || '*';
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || '60');

/** ====== S3 클라이언트 (경로형 + 고정 endpoint) ======
 *  점(.)이 있는 버킷명에서 TLS/엔드포인트 이슈를 피하려고
 *  forcePathStyle + endpoint를 명시합니다.
 */
const s3 = new S3Client({
  region: REGION,
  endpoint: `https://s3.${REGION}.amazonaws.com`,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

/** CDN 기본 주소 생성 (경로형이 안전) */
function buildCdnBase() {
  const base = (CDN_BASE_ENV || `https://s3.${REGION}.amazonaws.com/${BUCKET}`).replace(/\/+$/, '');
  return base;
}

/** multipart/form-data 파싱 */
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

/** 어떤 키로 오든 첫 번째 파일 선택 */
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

/** 파일명 안전화 */
function sanitizeBase(name) {
  return (name || 'image')
    .replace(/\.[^.]+$/, '')
    .normalize('NFKD')
    .replace(/[^\w\-]+/g, '_')
    .slice(0, 64);
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

  // 필수 env 체크
  if (!BUCKET) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED);
    return res.status(500).json({ error: 'missing env: AWS_BUCKET' });
  }

  try {
    // 1) 폼 파싱 + 첫 파일
    const { fields, files } = await parseForm(req);
    const f = pickFirstFile(files);
    if (!f) {
      res.setHeader('Access-Control-Allow-Origin', ALLOWED);
      return res.status(400).json({ error: 'no file received' });
    }

    // 2) 모델 옵션
    let models = [];
    try { models = JSON.parse(fields.models || '[]'); } catch {}

    // 3) 이미지 처리 (후에 AI로 교체 가능)
    let img = sharp(f.filepath).rotate();
    if (models.includes('color_restore')) img = img.modulate({ saturation: 1.12 }).linear(1.06, -4);
    if (models.includes('dehaze'))        img = img.sharpen(1.5);
    if (models.includes('stabilize'))     img = img.sharpen(0.6);
    if (models.includes('superres')) {
      const meta = await img.metadata();
      if (meta.width) img = img.resize({ width: Math.round(meta.width * 1.5) });
    }

    const out = await img.jpeg({ quality: 92, mozjpeg: true }).toBuffer();

    // 4) S3 업로드 (경로형 endpoint로 PutObject)
    const base = sanitizeBase(fields.filename || f.originalFilename);
    const folder = new Date().toISOString().slice(0, 10).replace(/-/g, '/'); // yyyy/mm/dd
    const key = `submissions/${folder}/${Date.now()}-${crypto.randomBytes(3).toString('hex')}/${base}_out.jpg`;

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: out,
      ContentType: 'image/jpeg'
      // Object Ownership = Bucket owner enforced => ACL 불필요
    }));

    // 5) 응답
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
