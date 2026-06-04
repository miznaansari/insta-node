import { PlaywrightCrawler, Configuration, purgeDefaultStorages } from 'crawlee';
import { extractUsername } from '../src/scraper.js';

async function scrapeWithPersistStorageFalse(username) {
  let scrapedResult = {
    profile: { username, followersCount: null }
  };

  // Option 1: new Configuration({ persistStorage: false })
  const crawler = new PlaywrightCrawler({
    headless: true,
    maxRequestsPerCrawl: 1,
    async requestHandler({ page, log }) {
      log.info(`[Test Scraper] Accessing Instagram profile page for ${username}`);
      scrapedResult.profile.followersCount = 12345;
    }
  }, new Configuration({ persistStorage: false }));

  await crawler.run([`https://www.instagram.com/${username}/`]);
  return scrapedResult;
}

async function scrapeWithPurge(username) {
  let scrapedResult = {
    profile: { username, followersCount: null }
  };

  // Option 2: purgeDefaultStorages before run
  await purgeDefaultStorages();

  const crawler = new PlaywrightCrawler({
    headless: true,
    maxRequestsPerCrawl: 1,
    async requestHandler({ page, log }) {
      log.info(`[Test Scraper] Accessing Instagram profile page for ${username}`);
      scrapedResult.profile.followersCount = 54321;
    }
  });

  await crawler.run([`https://www.instagram.com/${username}/`]);
  return scrapedResult;
}

async function run() {
  console.log('--- TESTING OPTION 1: persistStorage: false ---');
  try {
    const res1 = await scrapeWithPersistStorageFalse('cristiano');
    console.log('First scrape finished. Followers:', res1.profile.followersCount);
    
    const res2 = await scrapeWithPersistStorageFalse('leomessi');
    console.log('Second scrape finished. Followers:', res2.profile.followersCount);
  } catch (err) {
    console.error('Option 1 failed:', err);
  }

  console.log('\n--- TESTING OPTION 2: purgeDefaultStorages ---');
  try {
    const res1 = await scrapeWithPurge('cristiano');
    console.log('First scrape finished. Followers:', res1.profile.followersCount);
    
    const res2 = await scrapeWithPurge('leomessi');
    console.log('Second scrape finished. Followers:', res2.profile.followersCount);
  } catch (err) {
    console.error('Option 2 failed:', err);
  }
}

run();
