import { describe, expect, it } from 'vitest';
import { BOM, csvCell, toCsv } from '../../src/lib/csv';

describe('csvCell', () => {
  it('quotes commas, quotes and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell('屏東縣')).toBe('屏東縣');
  });
  it('neutralises formula injection', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\t=1')).toBe("'\t=1");
  });
  it('keeps real numbers numeric and handles null/NaN', () => {
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(60)).toBe('60');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(NaN)).toBe('');
  });
  it('joins rows with CRLF and exposes a BOM', () => {
    expect(toCsv([['a', 1], ['b', '=x']])).toBe("a,1\r\nb,'=x\r\n");
    expect(BOM).toBe('﻿');
  });
});
