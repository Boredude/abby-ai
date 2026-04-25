import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyKapsoSignature } from '../../src/services/kapso/signature.js';

const SECRET = 'whsec_test_abby';

function sign(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

describe('verifyKapsoSignature', () => {
  it('accepts a correct signature over the raw body', () => {
    const body = JSON.stringify({ event: 'whatsapp.message.received', data: { x: 1 } });
    expect(verifyKapsoSignature(body, sign(body), SECRET)).toBe(true);
  });

  it('rejects when the body changes by even one byte', () => {
    const body = '{"a":1}';
    const sig = sign(body);
    expect(verifyKapsoSignature('{"a":2}', sig, SECRET)).toBe(false);
  });

  it('rejects an empty signature', () => {
    expect(verifyKapsoSignature('{}', '', SECRET)).toBe(false);
  });

  it('rejects with the wrong secret', () => {
    const body = '{"a":1}';
    expect(verifyKapsoSignature(body, sign(body, 'other'), SECRET)).toBe(false);
  });

  it('rejects malformed signatures without throwing', () => {
    expect(verifyKapsoSignature('{}', 'not-hex', SECRET)).toBe(false);
  });
});
