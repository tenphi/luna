import { expect, it } from 'vitest';
import { getLaunchdLabel } from '../src/install-slug.js';
import { buildLaunchdPlist } from './service.js';

it('encodes paths safely and launches through the stable macOS app identity', () => {
  const root = '/tmp/luna-fixture/Ada & Bo';
  const plist = buildLaunchdPlist(root, '/tmp/luna-fixture/home', {
    executable: '/tmp/luna-fixture/Luna.app/Contents/MacOS/luna',
    hostScript: `${root}/dist/index.js`,
  });
  expect(plist).toContain(`<string>${getLaunchdLabel(root)}</string>`);
  expect(plist).toContain('Ada &amp; Bo/dist/index.js');
  expect(plist).toContain('<array><string>/tmp/luna-fixture/Luna.app/Contents/MacOS/luna</string>');
  expect(plist).toContain('<key>KeepAlive</key><true/>');
  expect(plist).toContain('luna.error.log');
  expect(plist).not.toContain('<string>node</string>');
});
