import { describe, expect, it } from 'vitest';
import { recencyRef, todayTaipei } from '../../src/lib/dates';

describe('recencyRef', () => {
  it('uses today when the range ends at the newest data', () => {
    expect(recencyRef('2026-10-14', '2026-10-14', '2026-10-17')).toBe('2026-10-17');
  });
  it('uses the range end when browsing history', () => {
    expect(recencyRef('2026-08-01', '2026-10-14', '2026-10-17')).toBe('2026-08-01');
    expect(recencyRef('2015-12-31', '2026-10-14', '2026-10-17')).toBe('2015-12-31');
  });
  it('never moves the reference backwards (clock behind data)', () => {
    expect(recencyRef('2026-10-14', '2026-10-14', '2026-10-13')).toBe('2026-10-14');
  });
});

describe('todayTaipei', () => {
  it('converts to Taiwan time (UTC+8)', () => {
    expect(todayTaipei(new Date('2026-10-16T16:30:00Z'))).toBe('2026-10-17');
    expect(todayTaipei(new Date('2026-10-16T15:59:00Z'))).toBe('2026-10-16');
  });
});
