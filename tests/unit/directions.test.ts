import { describe, expect, it } from 'vitest';
import { directionsUrl } from '../../src/lib/directions';

describe('directionsUrl', () => {
  it('uses the address as destination, URL-encoded', () => {
    const u = directionsUrl('臺北市松山區敦化北路199號', 121.549618, 25.055508)!;
    expect(u.startsWith('https://www.google.com/maps/dir/?api=1&destination=')).toBe(true);
    expect(new URL(u).searchParams.get('destination')).toBe('臺北市松山區敦化北路199號');
  });
  it('falls back to coordinates when there is no address', () => {
    expect(new URL(directionsUrl('', 121.549618, 25.055508)!).searchParams.get('destination')).toBe('25.055508,121.549618');
  });
  it('cannot inject extra parameters or control characters', () => {
    const u = new URL(directionsUrl('A&travelmode=walking#x\n', 0, 0)!);
    expect(u.searchParams.get('travelmode')).toBeNull();
    expect(u.searchParams.get('destination')).toBe('A&travelmode=walking#x');
    expect(u.hash).toBe('');
  });
  it('returns null without address or valid coordinates', () => {
    expect(directionsUrl(null, NaN, NaN)).toBeNull();
  });
});
