import { describe, expect, it } from 'vitest';
import { parseAuthCallback } from './client';

describe('parseAuthCallback', () => {
  it('reads the code from a website return URL', () => {
    expect(parseAuthCallback('http://localhost:5173/?code=abc123')).toEqual({ code: 'abc123' });
  });

  it('reads the code from the Android deep link', () => {
    expect(parseAuthCallback('com.astra.spaceflightbuilder://auth-callback?code=xyz')).toEqual({ code: 'xyz' });
  });

  it('prefers the error description, from the query or the hash', () => {
    expect(parseAuthCallback('http://localhost:5173/?error=access_denied&error_description=User+cancelled')).toEqual({
      error: 'User cancelled',
    });
    expect(parseAuthCallback('http://localhost:5173/#error=otp_expired&error_description=Link+expired')).toEqual({
      error: 'Link expired',
    });
  });

  it('returns nothing for an ordinary URL or a broken one', () => {
    expect(parseAuthCallback('http://localhost:5173/landing.html')).toEqual({});
    expect(parseAuthCallback('not a url')).toEqual({});
  });
});
