import * as Sentry from '@sentry/node';

function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    return null;
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 1.0,
  });

  return Sentry;
}

export { initSentry };

