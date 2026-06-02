import { PlaywrightCrawler } from 'crawlee';
import { chromium } from 'playwright';
import { uploadBufferToR2, isValidVideoBuffer, isInstagramCdnUrl } from './r2.js';
import fs from 'fs';
import path from 'path';

/**
 * Extracts the username from an Instagram profile URL or a raw username string.
 * @param {string} urlOrUsername 
 * @returns {string}
 */
export function extractUsername(urlOrUsername) {
  if (!urlOrUsername) return '';
  let str = urlOrUsername.trim();

  // Remove query parameters
  if (str.includes('?')) {
    str = str.split('?')[0];
  }

  // Remove trailing slash
  if (str.endsWith('/')) {
    str = str.slice(0, -1);
  }

  try {
    if (str.startsWith('http://') || str.startsWith('https://')) {
      const url = new URL(str);
      const pathParts = url.pathname.split('/').filter(Boolean);
      return pathParts[0] || '';
    }
  } catch (e) {
    // Ignore and fall back
  }

  const match = str.match(/(?:instagram\.com\/)?([a-zA-Z0-9_\.]+)/i);
  return match ? match[1] : str;
}

/**
 * Helper to parse followers/following/posts count abbreviations (e.g. 10.5M, 250K, 1,234)
 * @param {string} str 
 * @returns {number|null}
 */
function parseAbbreviatedNumber(str) {
  if (!str) return null;
  let cleanStr = str.replace(/,/g, '').trim().toUpperCase();
  let multiplier = 1;

  if (cleanStr.endsWith('M')) {
    multiplier = 1000000;
    cleanStr = cleanStr.slice(0, -1);
  } else if (cleanStr.endsWith('K')) {
    multiplier = 1000;
    cleanStr = cleanStr.slice(0, -1);
  } else if (cleanStr.endsWith('B')) {
    multiplier = 1000000000;
    cleanStr = cleanStr.slice(0, -1);
  }

  const num = parseFloat(cleanStr);
  return isNaN(num) ? null : Math.round(num * multiplier);
}

/**
 * Scrapes public Instagram profile data and reels.
 * Uses a double-layered approach: GraphQL endpoint fetch + Meta/DOM parsing fallback.
 * 
 * @param {string} targetUsername 
 * @returns {Promise<{profile: object, reels: Array<object>}>}
 */
export async function scrapeInstagramData(targetUsername) {
  const username = extractUsername(targetUsername);
  if (!username) {
    throw new Error('Invalid username or URL provided.');
  }

  let scrapedResult = {
    profile: {
      username: username,
      fullName: null,
      bio: null,
      profilePicUrl: null,
      followersCount: null,
      followingCount: null,
      postsCount: null,
    },
    reels: []
  };

  console.log(`[Scraper] Initializing PlaywrightCrawler for: ${username}`);

  const crawler = new PlaywrightCrawler({
    headless: true,
    maxRequestsPerCrawl: 1,
    browserPoolOptions: {
      useFingerprints: true, // Generate human-like browser fingerprints
    },
    launchContext: {
      launchOptions: {
        args: [
          '--disable-gpu',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-web-security',
          '--disable-features=IsolateOrigins,site-per-process'
        ],
      },
    },
    async requestHandler({ page, log }) {
      log.info(`[Scraper] Accessing Instagram profile page for ${username}`);

      // Navigate with human-like user agent
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
      });

      const profileUrl = `https://www.instagram.com/${username}/`;

      try {
        await page.goto(profileUrl, {
          waitUntil: 'commit',
          timeout: 20000,
        });
      } catch (gotoErr) {
        log.warning(`[Scraper] Initial navigation issue: ${gotoErr.message}. Attempting to proceed.`);
      }

      // Wait a short duration to ensure client-side code loads
      await page.waitForTimeout(3000);

      // --- LAYER 1: In-context GraphQL Fetch ---
      log.info(`[Scraper] Attempting Layer 1 (API Fetch) for ${username}`);
      const apiResult = await page.evaluate(async (uname) => {
        try {
          const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${uname}`;
          const res = await fetch(url, {
            headers: {
              'x-ig-app-id': '936619743392459',
              'x-requested-with': 'XMLHttpRequest',
              'secure': 'true'
            }
          });
          if (res.status === 200) {
            return await res.json();
          }
          return { error: `Status ${res.status}` };
        } catch (e) {
          return { error: e.message };
        }
      }, username).catch((e) => ({ error: e.message }));

      if (apiResult && apiResult.data && apiResult.data.user) {
        log.info(`[Scraper] Layer 1 Succeeded! Parsing GraphQL JSON.`);
        const user = apiResult.data.user;

        scrapedResult.profile = {
          username: user.username || username,
          fullName: user.full_name || null,
          bio: user.biography || null,
          profilePicUrl: user.profile_pic_url_hd || user.profile_pic_url || null,
          followersCount: user.edge_followed_by?.count || null,
          followingCount: user.edge_follow?.count || null,
          postsCount: user.edge_owner_to_timeline_media?.count || null,
        };

        // Extract posts / reels
        const mediaEdges = user.edge_owner_to_timeline_media?.edges || [];
        scrapedResult.reels = mediaEdges.map(edge => {
          const node = edge.node;
          const captionText = node.edge_media_to_caption?.edges?.[0]?.node?.text || null;
          return {
            shortcode: node.shortcode,
            mediaUrl: node.video_url || null,
            thumbnailUrl: node.display_url || null,
            caption: captionText,
            viewCount: node.video_view_count || null,
            likeCount: node.edge_liked_by?.count || null,
            commentCount: node.edge_media_to_comment?.count || null,
          };
        });

        return; // Success! No need for fallback.
      }

      log.warning(`[Scraper] Layer 1 failed: ${apiResult?.error || 'No user data'}. Proceeding to Layer 2 (Meta/DOM Parsing).`);

      // --- LAYER 2: Fallback Meta Tag / DOM Selector Extraction ---

      // Parse description meta tag
      const description = await page.locator('meta[property="og:description"], meta[name="description"]')
        .first()
        .getAttribute('content')
        .catch(() => null);

      if (description) {
        log.info(`[Scraper] Parsing meta description: "${description}"`);
        const followersMatch = description.match(/([\d.,\w]+)\s*Followers/i);
        const followingMatch = description.match(/([\d.,\w]+)\s*Following/i);
        const postsMatch = description.match(/([\d.,\w]+)\s*Posts/i);

        if (followersMatch) scrapedResult.profile.followersCount = parseAbbreviatedNumber(followersMatch[1]);
        if (followingMatch) scrapedResult.profile.followingCount = parseAbbreviatedNumber(followingMatch[1]);
        if (postsMatch) scrapedResult.profile.postsCount = parseAbbreviatedNumber(postsMatch[1]);
      }

      // Parse title meta tag for fullName
      const ogTitle = await page.locator('meta[property="og:title"], title')
        .first()
        .getAttribute('content')
        .catch(() => null) || await page.title().catch(() => null);

      if (ogTitle) {
        const titleMatch = ogTitle.match(/(.*?)\s*\(@([^)]+)\)/);
        if (titleMatch) {
          scrapedResult.profile.fullName = titleMatch[1].trim();
        }
      }

      // Parse profile picture meta tag
      const ogImage = await page.locator('meta[property="og:image"]')
        .first()
        .getAttribute('content')
        .catch(() => null);
      if (ogImage) {
        scrapedResult.profile.profilePicUrl = ogImage;
      }

      // Scroll down slowly to load dynamic DOM elements
      log.info(`[Scraper] Scrolling page to load reels...`);
      await page.evaluate(() => window.scrollBy(0, 1000));
      await page.waitForTimeout(2000);
      await page.evaluate(() => window.scrollBy(0, 1500));
      await page.waitForTimeout(2000);

      // Scrape post elements from DOM
      const postLinks = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]'));
        return links.map(a => {
          const href = a.getAttribute('href') || '';
          const img = a.querySelector('img');
          const imgSrc = img ? img.getAttribute('src') : null;
          const imgAlt = img ? img.getAttribute('alt') : null;

          // Extract shortcode from href like "/p/C8qJ0N8u9Xy/"
          const parts = href.split('/').filter(Boolean);
          const shortcode = parts[parts.length - 1] || href;

          return {
            shortcode,
            thumbnailUrl: imgSrc,
            caption: imgAlt,
          };
        });
      }).catch(() => []);

      // Remove duplicates
      const uniquePostsMap = new Map();
      postLinks.forEach(p => {
        if (p.shortcode) uniquePostsMap.set(p.shortcode, p);
      });

      scrapedResult.reels = Array.from(uniquePostsMap.values()).map(p => ({
        shortcode: p.shortcode,
        mediaUrl: null, // Scraped from public timeline DOM does not easily contain mp4 source
        thumbnailUrl: p.thumbnailUrl,
        caption: p.caption,
        viewCount: null,
        likeCount: null,
        commentCount: null,
      }));

      log.info(`[Scraper] Scraped ${scrapedResult.reels.length} posts/reels from DOM.`);
    },

    failedRequestHandler({ request, log }) {
      log.error(`[Scraper] Request ${request.url} failed completely.`);
    },
  });

  await crawler.run([`https://www.instagram.com/${username}/`]);

  return scrapedResult;
}

/**
 * Extracts the shortcode from an Instagram reel/post URL or returns the shortcode itself.
 * @param {string} urlOrShortcode 
 * @returns {string}
 */
export function extractShortcode(urlOrShortcode) {
  if (!urlOrShortcode) return '';
  let str = urlOrShortcode.trim();

  // Remove query parameters
  if (str.includes('?')) {
    str = str.split('?')[0];
  }

  // Remove trailing slash
  if (str.endsWith('/')) {
    str = str.slice(0, -1);
  }

  try {
    if (str.startsWith('http://') || str.startsWith('https://')) {
      const url = new URL(str);
      const pathParts = url.pathname.split('/').filter(Boolean);
      
      const reelIndex = pathParts.indexOf('reel');
      if (reelIndex !== -1 && pathParts[reelIndex + 1]) {
        return pathParts[reelIndex + 1];
      }
      
      const pIndex = pathParts.indexOf('p');
      if (pIndex !== -1 && pathParts[pIndex + 1]) {
        return pathParts[pIndex + 1];
      }

      return pathParts[pathParts.length - 1] || '';
    }
  } catch (e) {
    // Ignore and fall back
  }

  const match = str.match(/(?:reel|p)\/([a-zA-Z0-9_\-]+)/i);
  return match ? match[1] : str;
}

/**
 * Helper to recursively search an object for media content matches based on shortcode.
 */
function findMediaInObject(obj, shortcode) {
  if (!obj || typeof obj !== 'object') return null;

  if ((obj.code === shortcode || obj.shortcode === shortcode) && 
      (obj.video_versions || obj.image_versions2 || obj.display_url || obj.display_uri)) {
    let mediaUrl = null;
    let thumbnailUrl = null;

    if (Array.isArray(obj.video_versions) && obj.video_versions.length > 0) {
      mediaUrl = obj.video_versions[0].url;
    }

    if (obj.image_versions2 && Array.isArray(obj.image_versions2.candidates) && obj.image_versions2.candidates.length > 0) {
      thumbnailUrl = obj.image_versions2.candidates[0].url;
    } else if (obj.display_url) {
      thumbnailUrl = obj.display_url;
    } else if (obj.display_uri) {
      thumbnailUrl = obj.display_uri;
    }

    const likeCount = typeof obj.like_count === 'number' ? obj.like_count : null;
    const commentCount = typeof obj.comment_count === 'number' ? obj.comment_count : null;
    const viewCount = typeof obj.view_count === 'number' ? obj.view_count : (typeof obj.play_count === 'number' ? obj.play_count : null);

    return { mediaUrl, thumbnailUrl, likeCount, commentCount, viewCount };
  }

  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val && typeof val === 'object') {
      const result = findMediaInObject(val, shortcode);
      if (result) return result;
    }
  }
  return null;
}

/**
 * Parses raw HTML script payloads to extract direct Instagram CDN URLs.
 */
export function extractCdnUrlsFromHtml(html, shortcode) {
  if (!html) return null;
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
      // Ignore JSON parse errors
    }
  }
  return null;
}

/**
 * Scrapes a single public Instagram reel by its shortcode.
 * Reuses the provided page object to navigate.
 * @param {object} page Playwright page instance
 * @param {string} shortcode Reel shortcode
 * @returns {Promise<object>} Scraped reel data
 */
export async function scrapeSingleReelDirect(page, shortcode) {
  if (!shortcode) {
    throw new Error('Shortcode is required to scrape a single reel.');
  }

  const url = `https://www.instagram.com/reel/${shortcode}/`;

  // Setup response interceptor for streaming video bytes (if not already set up by Crawlee hook)
  let videoChunks = page.videoChunks || [];
  let responseHandler;

  if (!page.videoChunks) {
    responseHandler = async (response) => {
      try {
        const resUrl = response.url();
        const headers = response.headers();
        const contentType = headers['content-type'] || '';
        
        // Catch MP4/dynamic video streams
        if (
          contentType.includes('video/') || 
          resUrl.includes('.mp4') || 
          resUrl.includes('/videoplayback') || 
          (contentType.includes('application/octet-stream') && (resUrl.includes('bytestart=') || resUrl.includes('bytelength=')))
        ) {
          const buffer = await response.body();
          if (isValidVideoBuffer(buffer)) {
            videoChunks.push({
              url: resUrl,
              buffer,
              size: buffer.length,
              contentType: contentType
            });
          }
        }
      } catch (err) {
        // Body can be drained or closed, skip
      }
    };
    page.on('response', responseHandler);
  }

  // Skip page.goto if the page is already loaded at the correct URL (e.g. by Crawlee)
  const initialUrl = page.url() || '';
  const isAlreadyOnPage = initialUrl.replace(/\/$/, '').includes(`/reel/${shortcode}`);

  if (!isAlreadyOnPage) {
    console.log(`[Scraper] Navigating to single reel: ${url}`);
    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 25000,
      });
    } catch (gotoErr) {
      console.warn(`⚠️ [Scraper Warning] page.goto navigation timed out or encountered error: ${gotoErr.message}`);
    }
  } else {
    console.log(`[Scraper] Already on reel page: ${initialUrl}`);
  }

  // Programmatically trigger muted playback to bypass autoplay policy block and force buffer streaming!
  try {
    await page.evaluate(() => {
      const video = document.querySelector('video');
      if (video) {
        video.muted = true; // Muting is REQUIRED to satisfy browser autoplay policy without user interaction
        video.play().catch((e) => console.log('[Scraper Browser Context] video.play() failed:', e.message));
      }
      
      // Click play overlay button if present
      const playBtn = document.querySelector('[role="button"][aria-label*="Play"], [class*="PlayButton"]');
      if (playBtn) {
        playBtn.click();
      }
    }).catch(() => {});
  } catch (playErr) {
    // Ignore context execution errors
  }

  // Delay to allow dynamic client script elements to process and video stream chunks to start buffering
  await page.waitForTimeout(4000);

  // Stop listening to network traffic
  if (responseHandler) {
    page.off('response', responseHandler);
  } else if (page.videoResponseHandler) {
    page.off('response', page.videoResponseHandler);
  }

  // Check if we are redirected to a login page
  const currentUrl = page.url();
  if (currentUrl.includes('instagram.com/accounts/login')) {
    throw new Error('Scraping blocked. Instagram redirected to login page.');
  }

  // Step 1: Wait up to 2 seconds for a valid CDN URL in og:video or secure_url meta tags to appear
  try {
    await page.waitForFunction(() => {
      const getMetaVal = (prop) => {
        const el = document.querySelector(`meta[property="${prop}"], meta[name="${prop}"]`);
        return el ? el.getAttribute('content') : null;
      };
      const url = getMetaVal('og:video') || getMetaVal('og:video:secure_url') || getMetaVal('og:video:url');
      // If it exists and is a valid HTTP/HTTPS URL, wait is resolved
      return url && (url.startsWith('http://') || url.startsWith('https://'));
    }, { timeout: 2000 });
    console.log(`[Scraper] Successfully waited for dynamic og:video meta tags to populate.`);
  } catch (err) {
    console.log(`[Scraper] Did not find dynamic og:video CDN meta tags within timeout. Proceeding with instant page extraction.`);
  }

  // Extract from Open Graph/meta tags and DOM selectors
  const scraped = await page.evaluate((scode) => {
    const getMeta = (prop) => {
      const el = document.querySelector(`meta[property="${prop}"], meta[name="${prop}"]`);
      return el ? el.getAttribute('content') : null;
    };

    // Extract video url from og:video or video tag
    let mediaUrl = getMeta('og:video') || getMeta('og:video:secure_url') || getMeta('og:video:url');
    if (!mediaUrl) {
      const videoEl = document.querySelector('video');
      if (videoEl) {
        mediaUrl = videoEl.getAttribute('src');
      }
    }

    // Extract thumbnail from og:image or video poster
    let thumbnailUrl = getMeta('og:image');
    if (!thumbnailUrl) {
      const poster = document.querySelector('video')?.getAttribute('poster');
      if (poster) {
        thumbnailUrl = poster;
      }
    }

    // Extract title / description
    let caption = getMeta('og:title') || getMeta('og:description') || getMeta('description');

    return {
      mediaUrl,
      thumbnailUrl,
      caption,
    };
  }, shortcode);

  // Parse counts (likes, comments, views) from description meta tag if available
  let likeCount = null;
  let commentCount = null;
  let viewCount = null;

  const descriptionMeta = await page.locator('meta[name="description"], meta[property="og:description"]')
    .first()
    .getAttribute('content')
    .catch(() => null);

  if (descriptionMeta) {
    const likesMatch = descriptionMeta.match(/([\d.,\w]+)\s*Likes/i);
    const commentsMatch = descriptionMeta.match(/([\d.,\w]+)\s*Comments/i);
    const viewsMatch = descriptionMeta.match(/([\d.,\w]+)\s*Views/i);

    const parseAbbrev = (str) => {
      if (!str) return null;
      let cleanStr = str.replace(/,/g, '').trim().toUpperCase();
      let multiplier = 1;
      if (cleanStr.endsWith('M')) {
        multiplier = 1000000;
        cleanStr = cleanStr.slice(0, -1);
      } else if (cleanStr.endsWith('K')) {
        multiplier = 1000;
        cleanStr = cleanStr.slice(0, -1);
      }
      const num = parseFloat(cleanStr);
      return isNaN(num) ? null : Math.round(num * multiplier);
    };

    if (likesMatch) likeCount = parseAbbrev(likesMatch[1]);
    if (commentsMatch) commentCount = parseAbbrev(commentsMatch[1]);
    if (viewsMatch) viewCount = parseAbbrev(viewsMatch[1]);
  }

  // Clean the caption
  let cleanCaption = scraped.caption || '';
  if (cleanCaption) {
    const match = cleanCaption.match(/.*on Instagram:\s*["']([\s\S]*)["']/i);
    if (match && match[1]) {
      cleanCaption = match[1];
    } else {
      const match2 = cleanCaption.match(/.*by\s+[^:]+:\s*["']([\s\S]*)["']/i);
      if (match2 && match2[1]) {
        cleanCaption = match2[1];
      }
    }
  }

  // Try to parse direct CDN URLs from raw preloaded JSON script payloads in the HTML
  let parsedUrls = null;
  try {
    const rawHtml = await page.content().catch(() => '');
    parsedUrls = extractCdnUrlsFromHtml(rawHtml, shortcode);
    if (parsedUrls) {
      console.log(`[Scraper] Successfully extracted direct CDN URLs from preloaded JSON payload!`);
      if (parsedUrls.mediaUrl) console.log(`  - Video CDN URL: ${parsedUrls.mediaUrl.substring(0, 100)}...`);
      if (parsedUrls.thumbnailUrl) console.log(`  - Thumbnail CDN URL: ${parsedUrls.thumbnailUrl.substring(0, 100)}...`);

      // Override/update counts if more precise integer counts are available in the JSON
      if (parsedUrls.likeCount !== null) {
        likeCount = parsedUrls.likeCount;
        console.log(`  - Like Count (JSON): ${likeCount}`);
      }
      if (parsedUrls.commentCount !== null) {
        commentCount = parsedUrls.commentCount;
        console.log(`  - Comment Count (JSON): ${commentCount}`);
      }
      if (parsedUrls.viewCount !== null) {
        viewCount = parsedUrls.viewCount;
        console.log(`  - View Count (JSON): ${viewCount}`);
      }
    } else {
      console.log(`[Scraper] Preloaded JSON search did not yield direct CDN URLs for "${shortcode}".`);
    }
  } catch (err) {
    console.warn(`⚠️ [Scraper Warning] JSON script payload parsing failed:`, err.message);
  }

  let mediaUrl = (parsedUrls && parsedUrls.mediaUrl) || scraped.mediaUrl;
  let thumbnailUrl = (parsedUrls && parsedUrls.thumbnailUrl) || scraped.thumbnailUrl;

  console.log(`\n==========================================`);
  console.log(`[BULK IMPORT] Shortcode: ${shortcode}`);
  console.log(`[BULK IMPORT] Step 1: Got Reel Video URL from Page Context: "${mediaUrl}"`);
  console.log(`==========================================\n`);

  // Layer 1: If the mediaUrl is a standard CDN URL or a local browser blob URL, download it inside the browser context!
  if (mediaUrl && (isInstagramCdnUrl(mediaUrl) || mediaUrl.startsWith('blob:'))) {
    try {
      console.log(`\n==========================================`);
      console.log(`[BULK IMPORT] Step 2: Downloading CDN/Blob video inside browser context: "${mediaUrl}"`);
      console.log(`==========================================\n`);
      
      const downloadResult = await page.evaluate(async (targetUrl) => {
        try {
          const res = await fetch(targetUrl);
          if (!res.ok) {
            throw new Error(`HTTP ${res.status} - ${res.statusText}`);
          }
          const blob = await res.blob();
          
          return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
              resolve({
                dataUrl: reader.result,
                contentType: blob.type || 'video/mp4'
              });
            };
            reader.onerror = () => reject(new Error("FileReader failed"));
            reader.readAsDataURL(blob);
          });
        } catch (e) {
          return { error: e.message };
        }
      }, mediaUrl);

      if (downloadResult && !downloadResult.error && downloadResult.dataUrl) {
        const base64Parts = downloadResult.dataUrl.split(';base64,');
        if (base64Parts.length === 2) {
          const base64Str = base64Parts[1];
          const buffer = Buffer.from(base64Str, 'base64');
          const contentType = downloadResult.contentType;
          
          if (isValidVideoBuffer(buffer)) {
            let extension = 'mp4';
            if (contentType.includes('quicktime')) {
              extension = 'mov';
            }
            
            const key = `reels/${shortcode}.${extension}`;
            console.log(`\n==========================================`);
            console.log(`[BULK IMPORT] Step 3: Uploading browser-downloaded video Buffer (${buffer.length} bytes) to Cloudflare R2...`);
            console.log(`==========================================\n`);
            const customUrl = await uploadBufferToR2(buffer, key, contentType);
            console.log(`\n==========================================`);
            console.log(`[BULK IMPORT] Success: Video uploaded to Cloudflare R2: "${customUrl}"`);
            console.log(`==========================================\n`);
            mediaUrl = customUrl;
          } else {
            console.warn(`⚠️ [Scraper Warning] Browser-downloaded video buffer failed binary validation (too small or invalid signatures).`);
          }
        }
      } else {
        console.warn(`⚠️ [Scraper Warning] Browser-side CDN fetch failed:`, downloadResult?.error || 'No dataUrl returned');
      }
    } catch (err) {
      console.error(`❌ [Scraper Error] Exception in browser-side CDN download:`, err.message);
    }
  }

  // Layer 2: Process Video: If mediaUrl is a blob, missing, or browser CDN download failed, use the intercepted network buffer!
  if (!mediaUrl || mediaUrl.startsWith('blob:') || isInstagramCdnUrl(mediaUrl)) {
    if (videoChunks.length > 0) {
      // Sort chunks by size descending and pick the largest one (the actual full video file / largest stream segment)
      videoChunks.sort((a, b) => b.size - a.size);
      const largestChunk = videoChunks[0];
      const buffer = largestChunk.buffer;
      const contentType = largestChunk.contentType || 'video/mp4';
      
      let extension = 'mp4';
      if (contentType.includes('quicktime')) {
        extension = 'mov';
      }
      
      const key = `reels/${shortcode}.${extension}`;
      console.log(`\n==========================================`);
      console.log(`[BULK IMPORT] Step 2 (Fallback): Found ${videoChunks.length} intercepted network chunks. Using largest chunk (${buffer.length} bytes) as download.`);
      console.log(`[BULK IMPORT] Step 3: Uploading intercepted video to Cloudflare R2...`);
      console.log(`==========================================\n`);
      try {
        const customUrl = await uploadBufferToR2(buffer, key, contentType);
        console.log(`\n==========================================`);
        console.log(`[BULK IMPORT] Success: Intercepted video uploaded to Cloudflare R2: "${customUrl}"`);
        console.log(`==========================================\n`);
        mediaUrl = customUrl;
      } catch (uploadErr) {
        console.error(`[Scraper] Failed to upload intercepted video to R2 for "${shortcode}":`, uploadErr.message);
      }
    } else {
      console.warn(`⚠️ [Scraper Warning] mediaUrl is blob/missing for "${shortcode}", but no video stream response was intercepted.`);
    }
  }

  // Handle blob thumbnails inside the Playwright page context (standard static image blobs support fetch)
  if (thumbnailUrl && thumbnailUrl.startsWith('blob:')) {
    try {
      console.log(`[Scraper] Detected blob: thumbnailUrl "${thumbnailUrl}" for shortcode "${shortcode}". Resolving inside browser...`);
      
      const blobResult = await page.evaluate(async (blobUrl) => {
        try {
          const res = await fetch(blobUrl);
          const blob = await res.blob();
          
          return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
              resolve({
                dataUrl: reader.result,
                contentType: blob.type || 'image/jpeg'
              });
            };
            reader.onerror = () => reject(new Error("Failed to convert blob to dataUrl"));
            reader.readAsDataURL(blob);
          });
        } catch (e) {
          return { error: e.message };
        }
      }, thumbnailUrl);

      if (blobResult && !blobResult.error && blobResult.dataUrl) {
        const base64Parts = blobResult.dataUrl.split(';base64,');
        if (base64Parts.length === 2) {
          const base64Str = base64Parts[1];
          const buffer = Buffer.from(base64Str, 'base64');
          const contentType = blobResult.contentType;
          
          let extension = 'jpg';
          if (contentType.includes('png')) {
            extension = 'png';
          } else if (contentType.includes('webp')) {
            extension = 'webp';
          }
          
          const key = `thumbnails/${shortcode}.${extension}`;
          console.log(`[Scraper] Uploading resolved blob thumbnail Buffer (${buffer.length} bytes) to R2 with key "${key}"...`);
          const customUrl = await uploadBufferToR2(buffer, key, contentType);
          console.log(`[Scraper] Blob thumbnail successfully uploaded to R2: "${customUrl}"`);
          thumbnailUrl = customUrl;
        }
      }
    } catch (blobErr) {
      console.error(`[Scraper] Exception resolving blob URL for thumbnail "${shortcode}":`, blobErr.message);
    }
  }



  return {
    shortcode,
    mediaUrl,
    thumbnailUrl,
    caption: cleanCaption,
    viewCount,
    likeCount,
    commentCount,
    scrapedAt: new Date()
  };
}

/**
 * Direct scraper for a list of reels shortcodes sequentially reusing browser context.
 * Supports cancellation via jobState.cancelled.
 * @param {Array<string>} shortcodes
 * @param {object} jobState Shared state object with job details and cancel flag
 * @param {function} onProgress Callback for each completion
 */
export async function scrapeMultipleReelsDirect(shortcodes, jobState, onProgress) {
  console.log(`[Scraper] Starting direct list scraping for ${shortcodes.length} reels.`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-gpu',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--autoplay-policy=no-user-gesture-required' // Bypass browser interaction requirements for media playback
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
  });

  try {
    for (const shortcode of shortcodes) {
      if (jobState && jobState.cancelled) {
        console.log(`[Scraper] Scraping process cancelled for Job ${jobState.id}.`);
        break;
      }

      // Open a completely fresh page/tab for each reel to ensure clean slate
      const page = await context.newPage();
      page.setDefaultNavigationTimeout(25000);

      try {
        const data = await scrapeSingleReelDirect(page, shortcode);
        
        if (jobState && jobState.cancelled) break;

        if (onProgress) {
          await onProgress(shortcode, true, data);
        }
      } catch (err) {
        console.error(`[Scraper] Error crawling shortcode ${shortcode}:`, err.message);
        
        if (jobState && jobState.cancelled) break;

        if (onProgress) {
          await onProgress(shortcode, false, null, err.message);
        }
      } finally {
        // Always close the page tab to avoid memory/network leak
        await page.close().catch(() => {});
      }
    }
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    console.log(`[Scraper] Direct list crawling browser and context closed.`);
  }
}

