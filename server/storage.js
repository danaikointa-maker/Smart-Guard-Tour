const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- Storage: local (ค่าเริ่มต้น) หรือ S3-compatible (MinIO/AWS) ----------
// ตั้ง env: S3_ENDPOINT, S3_BUCKET, S3_REGION, S3_ACCESS_KEY, S3_SECRET_KEY, S3_PUBLIC_URL
// ถ้าไม่ตั้ง → เก็บไฟล์ใน uploads/ เหมือนเดิม
const S3 = {
  endpoint: process.env.S3_ENDPOINT || '',
  bucket: process.env.S3_BUCKET || '',
  region: process.env.S3_REGION || 'us-east-1',
  key: process.env.S3_ACCESS_KEY || '',
  secret: process.env.S3_SECRET_KEY || '',
  publicUrl: process.env.S3_PUBLIC_URL || '',
};
const useS3 = !!(S3.endpoint && S3.bucket && S3.key && S3.secret);

// AWS Signature V4 (อย่างย่อ) สำหรับ PUT object
async function s3Put(objectKey, buf, contentType) {
  const host = new URL(S3.endpoint).host;
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = crypto.createHash('sha256').update(buf).digest('hex');
  const canonicalUri = '/' + S3.bucket + '/' + objectKey;
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = ['PUT', canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${S3.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const kDate = crypto.createHmac('sha256', 'AWS4' + S3.secret, dateStamp).digest();
  const kRegion = crypto.createHmac('sha256', kDate, S3.region).digest();
  const kService = crypto.createHmac('sha256', kRegion, 's3').digest();
  const kSigning = crypto.createHmac('sha256', kService, 'aws4_request').digest();
  const sig = crypto.createHmac('sha256', kSigning, stringToSign).digest('hex');
  const url = `https://${host}${canonicalUri}`;
  const r = await fetch(url, {
    method: 'PUT', body: buf,
    headers: {
      'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash,
      'Content-Type': contentType, Authorization: `AWS4-HMAC-SHA256 Credential=${S3.key}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`,
    },
  });
  if (!r.ok) throw new Error('S3 PUT failed: http ' + r.status);
}

/**
 * บันทึกไฟล์รูป — คืนค่า path ที่เข้าถึงได้ (เช่น "/uploads/x.jpg" หรือ URL เต็มของ S3)
 */
async function savePhoto(localDir, filename, buf) {
  if (useS3) {
    const key = 'photos/' + filename;
    await s3Put(key, buf, 'image/jpeg');
    return (S3.publicUrl || S3.endpoint + '/' + S3.bucket) + '/' + key;
  }
  fs.writeFileSync(path.join(localDir, filename), buf);
  return '/uploads/' + filename;
}

module.exports = { savePhoto, useS3 };
