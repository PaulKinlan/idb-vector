import assert from 'node:assert/strict';
import test from 'node:test';
import { browserLabel } from '../../demo/ua.js';

test('picks the specific brand and platform from User-Agent Client Hints, skipping GREASE', () => {
  const nav = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    userAgentData: {
      platform: 'Windows',
      brands: [
        { brand: 'Not A Brand', version: '8' },
        { brand: 'Chromium', version: '138' },
        { brand: 'Google Chrome', version: '138' },
      ],
    },
  };
  assert.equal(browserLabel(nav), 'Google Chrome 138 on Windows');
});

test('reports plain Chromium when no fuller brand is listed', () => {
  const nav = {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0.0.0 Safari/537.36',
    userAgentData: {
      platform: 'Linux',
      brands: [
        { brand: 'Not.A Brand', version: '8' },
        { brand: 'Chromium', version: '140' },
        { brand: 'HeadlessChrome', version: '140' },
      ],
    },
  };
  assert.equal(browserLabel(nav), 'HeadlessChrome 140 on Linux');
});

test('recognises GREASE spellings and non-Chrome distributions', () => {
  const nav = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0',
    userAgentData: {
      platform: 'Windows',
      brands: [
        { brand: 'Chromium', version: '138' },
        { brand: 'Microsoft Edge', version: '138' },
        { brand: 'Not A(Brand', version: '8' },
      ],
    },
  };
  assert.equal(browserLabel(nav), 'Microsoft Edge 138 on Windows');
});

test('falls back to the raw user agent without client hints (Firefox, Safari)', () => {
  const nav = { userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0' };
  assert.equal(browserLabel(nav), 'Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0');
});

test('falls back when the brand list is empty or entirely GREASE', () => {
  const empty = { userAgent: 'ua-string', userAgentData: { platform: 'Windows', brands: [] } };
  assert.equal(browserLabel(empty), 'ua-string');
  const allGrease = {
    userAgent: 'ua-string',
    userAgentData: { platform: 'Windows', brands: [{ brand: 'Not A Brand', version: '8' }] },
  };
  assert.equal(browserLabel(allGrease), 'ua-string');
});
