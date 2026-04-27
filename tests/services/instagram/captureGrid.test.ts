import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getIgSession: vi.fn(),
  markIgSessionInvalid: vi.fn(),
}));

vi.mock('../../../src/db/repositories/igSessions.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/db/repositories/igSessions.js')
  >('../../../src/db/repositories/igSessions.js');
  return {
    ...actual,
    getIgSession: mocks.getIgSession,
    markIgSessionInvalid: mocks.markIgSessionInvalid,
  };
});

import {
  captureInstagramGrid,
  IgGridCaptureError,
} from '../../../src/services/instagram/captureGrid.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('captureInstagramGrid (no-Chromium error paths)', () => {
  it('throws no_session when no ig_sessions row exists', async () => {
    mocks.getIgSession.mockResolvedValue(null);

    await expect(
      captureInstagramGrid({ brandId: 'b1', handle: 'somebrand' }),
    ).rejects.toBeInstanceOf(IgGridCaptureError);

    await expect(
      captureInstagramGrid({ brandId: 'b1', handle: 'somebrand' }),
    ).rejects.toMatchObject({ code: 'no_session' });
  });

  it('throws no_session when the session row is marked invalid', async () => {
    mocks.getIgSession.mockResolvedValue({
      id: 'duffy',
      storageStateJson: {},
      status: 'invalid',
      lastVerifiedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      captureInstagramGrid({ brandId: 'b1', handle: 'somebrand' }),
    ).rejects.toMatchObject({ code: 'no_session' });
  });

  it('rejects with code "busy" when a capture is already running for this process', async () => {
    // First call: hangs forever waiting on the (mocked) session lookup so
    // the in-process mutex stays held. Second call should bail with `busy`.
    let resolveFirst: (value: unknown) => void = () => {};
    const firstSessionPromise = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    mocks.getIgSession.mockImplementationOnce(() => firstSessionPromise);
    // The second call will see the mutex is taken and short-circuit before
    // touching the session lookup at all.

    const first = captureInstagramGrid({ brandId: 'b1', handle: 'a' }).catch(
      (err) => err,
    );

    await expect(
      captureInstagramGrid({ brandId: 'b2', handle: 'b' }),
    ).rejects.toMatchObject({ code: 'busy' });

    // Let the first promise complete with no_session so we don't leak the
    // mutex to the next test.
    resolveFirst(null);
    await first;
  });
});
