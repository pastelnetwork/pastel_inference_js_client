const winston = require("winston");
const Sequelize = require("sequelize");

const customFormatter = winston.format((info) => {
  const formattedInfo = { ...info };

  Object.keys(formattedInfo).forEach((key) => {
    if (formattedInfo[key] instanceof Date) {
      formattedInfo[key] = formattedInfo[key].toISOString();
    }
  });

  return formattedInfo;
});

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    customFormatter(),
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: "error.log", level: "error" }),
    new winston.transports.File({ filename: "combined.log" }),
  ],
});

// Add a new function to set the WebSocket transport
logger.setWebSocketTransport = (ws) => {
  logger.add(
    new winston.transports.Stream({
      stream: {
        write: (message) => {
          ws.send(message);
        },
      },
    })
  );
};

// Add a new function to remove the WebSocket transport
logger.removeWebSocketTransport = () => {
  logger.remove(winston.transports.Stream);
};

if (process.env.NODE_ENV !== "production") {
  logger.add(
    new winston.transports.Console({
      format: winston.format.simple(),
    })
  );
}

function safeStringify(obj, space = 2) {
  const seen = new WeakSet(); // Track circular references

  // A custom replacer function that handles various data types and structures
  const replacer = (key, value) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) {
        return "[Circular]"; // Handle circular references
      }
      seen.add(value);

      if (value instanceof Sequelize.Model) {
        return value.get({ plain: true }); // Convert Sequelize models to plain objects
      }
      if (value.isJoi) {
        return `Joi Schema for ${value.type}`; // Describe Joi schemas
      }
      if (value instanceof Map) {
        return Array.from(value.entries()); // Convert Map to array of entries
      }
      if (value instanceof Set) {
        return Array.from(value); // Convert Set to array
      }
      if (value instanceof Date) {
        return value.toISOString(); // Convert Date to ISO string
      }
      if (value instanceof Error) {
        const errorDetails = {};
        Object.getOwnPropertyNames(value).forEach((prop) => {
          errorDetails[prop] = value[prop];
        });
        return errorDetails; // Convert Error objects to plain objects
      }
      // Return sorted object if it's a plain object
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
      return value.toString(); // Convert BigInt to string
    }
    return value;
  };
  // Return the stringified object with sorted keys
  return JSON.stringify(obj, replacer, space);
}

module.exports = { logger, safeStringify };
