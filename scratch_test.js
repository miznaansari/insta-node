import { extractShortcode } from './src/scraper.js';

const urls = [
  "https://www.instagram.com/food__o__graphy/reel/DY_qeXCJ6iC/",
  "https://www.instagram.com/food__o__graphy/reel/DY3wKphpXZJ/",
  "https://www.instagram.com/reel/DY3wKphpXZJ/",
  "DY3wKphpXZJ"
];

urls.forEach(url => {
  console.log(`Input:  "${url}"`);
  console.log(`Parsed: "${extractShortcode(url)}"`);
  console.log('---');
});
