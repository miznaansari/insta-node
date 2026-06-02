import { PlaywrightCrawler } from 'crawlee';
import { chromium } from 'playwright';

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
  console.log(`[Scraper] Navigating to single reel: ${url}`);

  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 20000,
  });

  // Short delay to allow dynamic client script elements to process
  await page.waitForTimeout(3000);

  // Check if we are redirected to a login page
  const currentUrl = page.url();
  if (currentUrl.includes('instagram.com/accounts/login')) {
    throw new Error('Scraping blocked. Instagram redirected to login page.');
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

  return {
    shortcode,
    mediaUrl: scraped.mediaUrl,
    thumbnailUrl: scraped.thumbnailUrl,
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
      '--disable-features=IsolateOrigins,site-per-process'
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, http://g.co/Antigravity) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
  });

  const page = await context.newPage();
  page.setDefaultNavigationTimeout(20000);

  try {
    for (const shortcode of shortcodes) {
      if (jobState && jobState.cancelled) {
        console.log(`[Scraper] Scraping process cancelled for Job ${jobState.id}.`);
        break;
      }

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
      }
    }
  } finally {
    await browser.close().catch(() => {});
    console.log(`[Scraper] Direct list crawling browser closed.`);
  }
}

