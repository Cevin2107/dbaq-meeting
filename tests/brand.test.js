// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { brandLockup } from '../src/ui/brand.js';

describe('the header lock-up', () => {
  it('pairs the app icon with the wordmark', () => {
    const lockup = brandLockup();
    expect(lockup.querySelector('img')).not.toBeNull();
    expect(lockup.querySelector('.home-wordmark').textContent).toBe('ĐBAQ Meeting');
  });
});
