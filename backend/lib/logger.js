import winston from 'winston';

const isProduction = process.env.NODE_ENV === 'production';
const level = process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug');

const baseFormat = winston.format.combine(
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.timestamp()
);

const consoleFormat = isProduction
  ? winston.format.json()
  : winston.format.combine(
      winston.format.colorize({ all: true }),
      winston.format.printf(({ timestamp, level: lvl, message, ...meta }) => {
        const details = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
        return `${timestamp} ${lvl}: ${message}${details}`;
      })
    );

const logger = winston.createLogger({
  level,
  exitOnError: false,
  format: baseFormat,
  transports: [
    new winston.transports.Console({
      format: consoleFormat,
    }),
  ],
});

export default logger;

