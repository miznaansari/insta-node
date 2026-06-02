import fs from 'fs';
import path from 'path';

function findMediaInObject(obj, shortcode) {
  if (!obj || typeof obj !== 'object') return null;

  // If this object has a code or shortcode matching ours, extract URLs
  if ((obj.code === shortcode || obj.shortcode === shortcode) && 
      (obj.video_versions || obj.image_versions2 || obj.display_url || obj.display_uri)) {
    let mediaUrl = null;
    let thumbnailUrl = null;

    if (Array.isArray(obj.video_versions) && obj.video_versions.length > 0) {
      // Pick first video version URL
      mediaUrl = obj.video_versions[0].url;
    }

    if (obj.image_versions2 && Array.isArray(obj.image_versions2.candidates) && obj.image_versions2.candidates.length > 0) {
      thumbnailUrl = obj.image_versions2.candidates[0].url;
    } else if (obj.display_url) {
      thumbnailUrl = obj.display_url;
    } else if (obj.display_uri) {
      thumbnailUrl = obj.display_uri;
    }

    return { mediaUrl, thumbnailUrl };
  }

  // Recursively search children
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val && typeof val === 'object') {
      const result = findMediaInObject(val, shortcode);
      if (result) return result;
    }
  }
  return null;
}

function extractCdnUrlsFromHtml(html, shortcode) {
  const scriptRegex = /<script\s+type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match;

  while ((match = scriptRegex.exec(html)) !== null) {
    const scriptContent = match[1].trim();
    if (!scriptContent.includes('video_versions') && !scriptContent.includes('display_uri') && !scriptContent.includes('xdt_api__v1__media__shortcode__web_info')) {
      continue;
    }

    try {
      const parsed = JSON.parse(scriptContent);
      const result = findMediaInObject(parsed, shortcode);
      if (result && (result.mediaUrl || result.thumbnailUrl)) {
        return result;
      }
    } catch (err) {
      // ignore JSON parse errors of unrelated scripts
    }
  }
  return null;
}

// Run the test
const shortcodes = ['DY_qeXCJ6iC', 'DY3wKphpXZJ'];

shortcodes.forEach(shortcode => {
  console.log(`=== Testing parsing for: "${shortcode}" ===`);
  const filePath = path.join('rawWeb', `${shortcode}.html`);
  if (!fs.existsSync(filePath)) {
    console.error(`File ${filePath} does not exist.`);
    return;
  }
  const html = fs.readFileSync(filePath, 'utf8');
  const result = extractCdnUrlsFromHtml(html, shortcode);
  console.log("Result:", JSON.stringify(result, null, 2));
  console.log('==========================================\n');
});
