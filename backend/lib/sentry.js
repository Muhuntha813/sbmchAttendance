import * as Sentry from '@sentry/node';

let isInitialized = false;

function initSentry(logger) {
  if (isInitialized) {
    return Sentry;
  }

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    logger?.debug?.('Sentry not initialized - SENTRY_DSN is not set');
    return null;
  }

  const tracesSampleRateEnv = process.env.SENTRY_TRACES_SAMPLE_RATE;
  const tracesSampleRate = tracesSampleRateEnv ? Number.parseFloat(tracesSampleRateEnv) : 1.0;

  try {
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV || 'development',
      tracesSampleRate: Number.isFinite(tracesSampleRate) ? tracesSampleRate : 1.0,
    });
    isInitialized = true;
    logger?.info?.('Sentry initialized');
    return Sentry;
  } catch (error) {
    logger?.error?.('Failed to initialize Sentry', { error: error.message });
    return null;
  }
}

export { initSentry };

