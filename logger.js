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
    // new winston.transports.Console(), // Logs to the Node.js console
  ],
});

if (process.env.NODE_ENV !== "production") {
  logger.add(
    new winston.transports.Console({
      format: winston.format.simple(),
    })
  );
}

function safeStringify(obj, replacer = null, space = 2) {
  const seen = new WeakSet(); // Track circular references
  return JSON.stringify(
    obj,
    (key, value) => {
      if (replacer) value = replacer(key, value);
      // Detect value type and process accordingly
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) {
          return "[Circular]";
        }
        seen.add(value);
        // Handle Sequelize models
        if (value instanceof Sequelize.Model) {
          return value.get({ plain: true }); // Convert Sequelize models to plain objects
        }
        // Handle Joi validation schemas
        if (value.isJoi) {
          return `Joi Schema for ${value.type}`; // Provide a simple description for Joi schemas
        }
        // Handling other specific types
        if (value instanceof Map) {
          return Array.from(value.entries()); // Convert Map to an array of key-value pairs
        }
        if (value instanceof Set) {
          return Array.from(value); // Convert Set to an array
        }
        if (value instanceof Date) {
          return value.toISOString(); // Convert Date to ISO string
        }
        if (value instanceof Error) {
          const errorDetails = {};
          Object.getOwnPropertyNames(value).forEach((prop) => {
            errorDetails[prop] = value[prop];
          });
          return errorDetails; // Convert Errors to an object
        }
      } else if (typeof value === "bigint") {
        return value.toString(); // Convert BigInt to string
      }
      return value; // Return the value if none of the above conditions apply
    },
    space
  );
}

module.exports = { logger, safeStringify };
