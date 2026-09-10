import { expect, it } from 'vitest';
import { isNewerVersion } from '../src/updates.js';

it('offers only a newer semantic version, including numeric segments and prereleases', () => {
  expect(isNewerVersion('2.0.10', '2.0.9')).toBe(true);
  expect(isNewerVersion('2.0.9', '2.0.11')).toBe(false);
  expect(isNewerVersion('2.0.11', '2.0.11')).toBe(false);
  expect(isNewerVersion('2.0.12-beta.1', '2.0.12')).toBe(false);
  expect(isNewerVersion('2.0.12', '2.0.12-beta.1')).toBe(true);
  expect(() => isNewerVersion('latest', '2.0.11')).toThrow('UPDATE_VERSION_INVALID');
});
