'use strict';

const { createLogger, format, transports } = require('winston');
const { combine, timestamp, colorize, printf } = format;

const lineFormat = printf(({ level, message, timestamp: ts, ...meta }) => {
  const extras = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${ts} [${level}] ${message}${extras}`;
});

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    colorize(),
    lineFormat
  ),
  transports: [
    new transports.Console(),
    new transports.File({ filename: 'guardian.log', format: combine(timestamp(), lineFormat) }),
  ],
});

module.exports = logger;
