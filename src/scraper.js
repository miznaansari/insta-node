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
