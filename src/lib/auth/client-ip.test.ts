import { describe, expect, it } from 'vitest';
import { pickClientIp } from './client-ip';

const from = (h: Record<string, string>) => (name: string) => h[name] ?? null;

describe('pickClientIp', () => {
  it('prefers x-real-ip, which the platform sets', () => {
    expect(pickClientIp(from({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }))).toBe('203.0.113.7');
  });
  it('otherwise uses the right-most x-forwarded-for entry, never the left-most', () => {
    expect(pickClientIp(from({ 'x-forwarded-for': '9.9.9.9, 198.51.100.4' }))).toBe('198.51.100.4');
    expect(pickClientIp(from({ 'x-forwarded-for': '  6.6.6.6 ,7.7.7.7,  198.51.100.9  ' }))).toBe('198.51.100.9');
  });
  it('a caller-supplied left-most value cannot pick its own rate-limit bucket', () => {
    const a = pickClientIp(from({ 'x-forwarded-for': 'spoof-1, 198.51.100.4' }));
    const b = pickClientIp(from({ 'x-forwarded-for': 'spoof-2, 198.51.100.4' }));
    expect(a).toBe(b);
  });
  it('handles a single entry, empties and no headers', () => {
    expect(pickClientIp(from({ 'x-forwarded-for': '198.51.100.4' }))).toBe('198.51.100.4');
    expect(pickClientIp(from({ 'x-forwarded-for': '1.1.1.1, ' }))).toBe('1.1.1.1');
    expect(pickClientIp(from({ 'x-real-ip': '  ', 'x-forwarded-for': '' }))).toBe('unknown');
    expect(pickClientIp(from({}))).toBe('unknown');
  });
});
