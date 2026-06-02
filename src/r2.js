import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import dotenv from 'dotenv';

dotenv.config();

// Initialize the S3 Client for Cloudflare R2
const endpoint = (process.env.R2_ENDPOINT || '').trim().replace(/\/$/, '');

const s3Client = new S3Client({
  endpoint: endpoint,
  region: 'auto',
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

/**
 * Checks if a given URL is an Instagram/Facebook CDN media URL.
 * Skip if it's already uploaded to our custom R2 domain.
 * @param {string} url 
 * @returns {boolean}
 */
export function isInstagramCdnUrl(url) {
  if (!url || typeof url !== 'string') return false;
  
  // Skip blob URLs on backend (they are resolved inside the Playwright browser context)
  if (url.startsWith('blob:')) {
    return false;
  }
  
  // Already converted to R2 custom domain
  if (url.startsWith(process.env.R2_CUSTOM_DOMAIN)) {
    return false;
  }
  
  return (
    url.includes('fbcdn.net') ||
    url.includes('instagram.com') ||
    url.includes('cdninstagram.com')
  );
}

/**
 * Downloads a binary file using native Node.js fetch.
 * Returns buffer and detected Content-Type.
 * @param {string} url 
 * @returns {Promise<{buffer: Buffer, contentType: string}>}
 */
export async function downloadFile(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });
    
    if (!res.ok) {
      throw new Error(`HTTP Error ${res.status}: ${res.statusText}`);
    }
    
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const contentType = res.headers.get('content-type') || 'application/octet-stream';
    
    return { buffer, contentType };
  } catch (err) {
    console.error(`[R2 Download Error] Failed to download URL: ${url}`, err.message);
    throw err;
  }
}

/**
 * Validates if a buffer is a valid MP4/QuickTime video container.
 * Checks for a minimum size (200KB) and standard container signatures:
 * ftyp (66747970), moof (6d6f6f66), mdat (6d646174), styp (73747970).
 * @param {Buffer} buffer 
 * @returns {boolean}
 */
export function isValidVideoBuffer(buffer) {
  if (!buffer || buffer.length < 200000) {
    return false;
  }
  
  const hex = buffer.toString('hex', 0, 120);
  return (
    hex.includes('66747970') || // ftyp
    hex.includes('6d6f6f66') || // moof
    hex.includes('6d646174') || // mdat
    hex.includes('73747970')    // styp
  );
}

/**
 * Uploads a buffer directly to the Cloudflare R2 bucket.
 * @param {Buffer} buffer 
 * @param {string} key 
 * @param {string} contentType 
 * @returns {Promise<string>} Custom Domain URL
 */
export async function uploadBufferToR2(buffer, key, contentType) {
  // Validate video files to prevent empty/blank uploads
  if (key.includes('reels/') || (contentType && contentType.includes('video'))) {
    if (!isValidVideoBuffer(buffer)) {
      throw new Error(`Invalid video buffer detected for key "${key}". Verification failed (file empty, too small, or lacks valid MP4 signatures).`);
    }
  }

  const bucket = process.env.R2_INSTAGRAM_BUCKET || 'instagram-temp-storage';
  const customDomain = (process.env.R2_CUSTOM_DOMAIN || '').trim().replace(/\/$/, '');

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  });

  await s3Client.send(command);
  
  return `${customDomain}/${key}`;
}

/**
 * Attempts to download an Instagram asset and upload it to R2.
 * Returns the updated custom domain URL and an error status.
 * @param {string} url Original URL
 * @param {'profile'|'video'|'thumbnail'} keyType Category
 * @param {string} identifier Unique identifier (username or shortcode)
 * @returns {Promise<{url: string, error: boolean}>}
 */
export async function tryUploadToR2(url, keyType, identifier) {
  if (!isInstagramCdnUrl(url)) {
    return { url, error: false };
  }
  
  try {
    console.log(`\n==========================================`);
    console.log(`[BULK IMPORT DB SYNC] Syncing ${keyType} for ID: "${identifier}"`);
    console.log(`[BULK IMPORT DB SYNC] Step 1: Got Reel CDN URL: "${url}"`);
    console.log(`[BULK IMPORT DB SYNC] Step 2: Downloading asset...`);
    console.log(`==========================================\n`);
    
    const { buffer, contentType } = await downloadFile(url);
    
    // Determine extension based on Content-Type
    let extension = 'jpg';
    if (contentType.includes('video')) {
      extension = 'mp4';
    } else if (contentType.includes('png')) {
      extension = 'png';
    } else if (contentType.includes('webp')) {
      extension = 'webp';
    }
    
    let key;
    if (keyType === 'profile') {
      key = `profiles/${identifier}.${extension}`;
    } else if (keyType === 'video') {
      key = `reels/${identifier}.${extension}`;
    } else if (keyType === 'thumbnail') {
      key = `thumbnails/${identifier}.${extension}`;
    } else {
      key = `temp/${identifier}_${Date.now()}.${extension}`;
    }
    
    console.log(`\n==========================================`);
    console.log(`[BULK IMPORT DB SYNC] Step 3: Uploading ${keyType} to Cloudflare R2 (${buffer.length} bytes)...`);
    console.log(`==========================================\n`);
    
    const customUrl = await uploadBufferToR2(buffer, key, contentType);
    
    console.log(`\n==========================================`);
    console.log(`[BULK IMPORT DB SYNC] Success: Uploaded to Cloudflare R2: "${customUrl}"`);
    console.log(`==========================================\n`);
    
    return { url: customUrl, error: false };
  } catch (err) {
    console.error(`❌ [R2 Uploader Failure] Error uploading R2 for identifier "${identifier}":`, err.message);
    return { url, error: true };
  }
}
