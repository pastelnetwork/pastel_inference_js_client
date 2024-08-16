const winston = require("winston");
const Sequelize = require("sequelize");
const EventEmitter = require("events");

function safeStringify(obj, space = 2) {
  const seen = new WeakSet();

  const replacer = (key, value) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) {
        return "[Circular]";
      }
      seen.add(value);

      if (value instanceof Sequelize.Model) {
        return value.get({ plain: true });
      }
      if (value.isJoi) {
        return `Joi Schema for ${value.type}`;
      }
      if (value instanceof Map) {
        return Array.from(value.entries());
      }
      if (value instanceof Set) {
        return Array.from(value);
      }
      if (value instanceof Date) {
        return value.toISOString();
      }
      if (value instanceof Error) {
        const errorDetails = {};
        Object.getOwnPropertyNames(value).forEach((prop) => {
          errorDetails[prop] = value[prop];
        });
        return errorDetails;
      }
      if (value.constructor === Object) {
        const sortedObj = {};
        Object.keys(value)
          .sort()
          .forEach((key) => {
            sortedObj[key] = value[key];
          });
        return sortedObj;
      }
    } else if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  };

  return JSON.stringify(obj, replacer, space);
}

const customFormatter = winston.format((info) => {
  const formattedInfo = { ...info };

  Object.keys(formattedInfo).forEach((key) => {
    if (formattedInfo[key] instanceof Date) {
      formattedInfo[key] = formattedInfo[key].toISOString();
    }
  });

  return formattedInfo;
});
let transports = [
  new winston.transports.File({ filename: "error.log", level: "error" }),
  new winston.transports.File({ filename: "combined.log" }),
];
if (process.env.USE_WINSTON_TRANSPORTS_CONSOLE === '1') {
  transports.push(
    new winston.transports.Console({
      format: winston.format.simple(),
    })
  )
}
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    customFormatter(),
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports,
});

const logEmitter = new EventEmitter();
const logBuffer = [];
const MAX_LOG_ENTRIES = 100;

logger.on("data", (logEntry) => {
  const logEntryString = safeStringify(logEntry);
  logBuffer.push(logEntryString);
  if (logBuffer.length > MAX_LOG_ENTRIES) {
    logBuffer.shift();
  }
  logEmitter.emit("newLog", logEntryString);
});

// Intercept logs and emit events
const originalLog = logger.log.bind(logger);
logger.log = (level, msg, meta) => {
  originalLog(level, msg, meta);
  const logEntry = { level, msg, meta, timestamp: new Date().toISOString() };
  logEmitter.emit("newLog", safeStringify(logEntry));
};

module.exports = { logger, logEmitter, logBuffer, safeStringify };
