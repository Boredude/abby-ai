import { describe, expect, it } from 'vitest';
import { inferTimezoneFromPhone } from '../../src/utils/phoneTimezone.js';

describe('inferTimezoneFromPhone', () => {
  it.each([
    // Israel — the "I'm from tlv" use case in the screenshot.
    ['972501234567', 'Asia/Jerusalem', 'Israel'],
    ['+972501234567', 'Asia/Jerusalem', 'Israel'],
    // North America
    ['13105551234', 'America/New_York', 'the US'],
    ['+14165551234', 'America/Toronto', 'Canada'],
    ['525512345678', 'America/Mexico_City', 'Mexico'],
    // Europe
    ['447400123456', 'Europe/London', 'the UK'],
    ['34612345678', 'Europe/Madrid', 'Spain'],
    ['33612345678', 'Europe/Paris', 'France'],
    ['491701234567', 'Europe/Berlin', 'Germany'],
    // South America
    ['5511987654321', 'America/Sao_Paulo', 'Brazil'],
    // Asia / Pacific
    ['819012345678', 'Asia/Tokyo', 'Japan'],
    ['919876543210', 'Asia/Kolkata', 'India'],
    ['61412345678', 'Australia/Sydney', 'Australia'],
  ])('infers %s -> %s (%s)', (input, timezone, label) => {
    expect(inferTimezoneFromPhone(input)).toEqual({ timezone, label });
  });

  it.each([null, undefined, '', '   '])('returns null for empty input %p', (input) => {
    expect(inferTimezoneFromPhone(input)).toBeNull();
  });

  it('returns null for non-phone garbage', () => {
    expect(inferTimezoneFromPhone('not-a-phone')).toBeNull();
  });
});
