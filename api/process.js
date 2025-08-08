import formidable from 'formidable';
import sharp from 'sharp';
import crypto from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

export const config = { api: { bodyParser: false } };

/** ====== 환경설정 (환경변수) ====== **/
const REGION = process.env.AWS_REGION || 'us-east-1';
const BUCKET = process.env.AWS_BUCKET;                       // 예: aqua.ai-output
const CDN_BASE_ENV = process.env.CDN_BASE || '';             // 예: https://s3.us-east-1.amazonaws.com/aqua.ai-output
const ALLOWED = process.env.ALLOWED_ORIGIN || '*';           // CORS 허용 도메인(미설정 시 전체 허용)
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || '60'); // 업로드 허용 용량(MB)

/** ====== S3 클라이언트 ====== **/
const s3 = new S3Client({
  region: REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

/** CDN 기본 주소(경로형 Path-style로 안전하게 생성) */
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

/** 어떤 키로 오든 첫 번째 파일 집기 */
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
    .replace(/\.[^.]+$/, '')            // 확장자 제거
    .normalize('NFKD')
    .replace(/[^\w\-]+/g, '_')          // 공백/특수문자 → _
    .slice(0, 64);                      // 너무 길면 자르기
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

  // 필수 환경변수 체크
  if (!BUCKET) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED);
    return res.status(500).json({ error: 'missing env: AWS_BUCKET' });
  }

  try {
    // 1) 폼 파싱 + 첫 파일 선택
    const { fields, files } = await parseForm(req);
    const f = pickFirstFile(files);
    if (!f) {
      res.setHeader('Access-Control-Allow-Origin', ALLOWED);
      return res.status(400).json({ error: 'no file received' });
    }

    // 2) 모델 옵션 파싱
    let models = [];
    try { models = JSON.parse(fields.models || '[]'); } catch {}

    // 3) 이미지 처리 파이프라인 (후에 AI로 교체 가능)
    let img = sharp(f.filepath).rotate(); // EXIF 회전 보정

    if (models.includes('color_restore')) img = img.modulate({ saturation: 1.12 }).linear(1.06, -4);
    if (models.includes('dehaze'))        img = img.sharpen(1.5);
    if (models.includes('stabilize'))     img = img.sharpen(0.6);
    if (models.includes('superres')) {
      const meta = await img.metadata();
      if (meta.width) img = img.resize({ width: Math.round(meta.width * 1.5) });
    }

    const out = await img.jpeg({ quality: 92, mozjpeg: true }).toBuffer();

    // 4) S3 업로드
    const base = sanitizeBase(fields.filename || f.originalFilename);
    const folder = new Date().toISOString().slice(0, 10).replace(/-/g, '/'); // yyyy/mm/dd
    const key = `submissions/${folder}/${Date.now()}-${crypto.randomBytes(3).toString('hex')}/${base}_out.jpg`;

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: out,
      ContentType: 'image/jpeg'
      // Object Ownership = Bucket owner enforced 이면 ACL 불필요
    }));

    // 5) 응답(JSON)
    const url = `${buildCdnBase()}/${key}`;
    res.setHeader('Access-Control-Allow-Origin', ALLOWED);
    return res.status(200).json({ url, key, bytes: out.length });
  } catch (err) {
    console.error(err);
    res.setHeader('Access-Control-Allow-Origin', ALLOWED);

    const msg = String(err?.message || '').toLowerCase();
    if (msg.includes('max file size')) {
      return res.status(413).json({ error: 'file too large', limit_mb: MAX_FILE_MB });
    }
    if (msg.includes('unsupported') || msg.includes('input buffer')) {
      // sharp가 지원하지 않는 포맷일 때(예: 특정 HEIC)
      return res.status(415).json({ error: 'unsupported image format' });
    }
    return res.status(500).json({ error: 'process failed' });
  }
}
