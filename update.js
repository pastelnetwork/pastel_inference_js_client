require("dotenv").config();
const { exec, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const currentDir = __dirname;
const envFilePath = path.join(currentDir, ".env");
const tempEnvFilePath = path.join(currentDir, ".env.temp");

// Configuration
const useDebugMode = process.env.USE_DEBUG_MODE === "1";
console.log(
  `USE_DEBUG_MODE: ${process.env.USE_DEBUG_MODE}, useDebugMode: ${useDebugMode}`
);
const repoUrl =
  "https://github.com/pastelnetwork/pastel_inference_js_client.git";
const branch = "master"; // Changed from "main" to "master"

function updateApplication() {
  if (useDebugMode) {
    console.log("Debug mode is enabled. Skipping auto-update.");
    startApplication();
    return;
  }

  console.log("Checking for updates...");

  // Move .env file to a temporary location
  if (fs.existsSync(envFilePath)) {
    fs.renameSync(envFilePath, tempEnvFilePath);
  }

  exec(
    `git fetch origin ${branch}`,
    { cwd: currentDir },
    (err, stdout, stderr) => {
      if (err) {
        console.error("Error fetching updates:", stderr);

        // Restore .env file if an error occurs
        if (fs.existsSync(tempEnvFilePath)) {
          fs.renameSync(tempEnvFilePath, envFilePath);
        }
        return;
      }

      exec("git rev-parse HEAD", { cwd: currentDir }, (err, currentCommit) => {
        if (err) {
          console.error("Error getting current commit:", stderr);

          // Restore .env file if an error occurs
          if (fs.existsSync(tempEnvFilePath)) {
            fs.renameSync(tempEnvFilePath, envFilePath);
          }
          return;
        }

        exec(
          `git rev-parse origin/${branch}`,
          { cwd: currentDir },
          (err, latestCommit) => {
            if (err) {
              console.error("Error getting latest commit:", stderr);

              // Restore .env file if an error occurs
              if (fs.existsSync(tempEnvFilePath)) {
                fs.renameSync(tempEnvFilePath, envFilePath);
              }
              return;
            }

            if (currentCommit.trim() !== latestCommit.trim()) {
              console.log("Update available. Pulling latest changes...");
              exec(
                `git pull origin ${branch}`,
                { cwd: currentDir },
                (err, stdout, stderr) => {
                  if (err) {
                    console.error("Error pulling updates:", stderr);

                    // Restore .env file if an error occurs
                    if (fs.existsSync(tempEnvFilePath)) {
                      fs.renameSync(tempEnvFilePath, envFilePath);
                    }
                    return;
                  }

                  console.log("Installing dependencies...");
                  exec(
                    "npm install",
                    { cwd: currentDir },
                    (err, stdout, stderr) => {
                      if (err) {
                        console.error("Error installing dependencies:", stderr);

                        // Restore .env file if an error occurs
                        if (fs.existsSync(tempEnvFilePath)) {
                          fs.renameSync(tempEnvFilePath, envFilePath);
                        }
                        return;
                      }

                      console.log(
                        "Update applied successfully. Restarting application..."
                      );

                      // Restore .env file after successful update
                      if (fs.existsSync(tempEnvFilePath)) {
                        fs.renameSync(tempEnvFilePath, envFilePath);
                      }

                      process.exit(0); // Exit to let the process manager (e.g., PM2) restart the app
                    }
                  );
                }
              );
            } else {
              console.log("Application is up-to-date.");

              // Restore .env file if no update is needed
              if (fs.existsSync(tempEnvFilePath)) {
                fs.renameSync(tempEnvFilePath, envFilePath);
              }

              startApplication();
            }
          }
        );
      });
    }
  );
}

function startApplication() {
  console.log("Starting application...");
  const server = spawn("node", ["server.js"], {
    cwd: currentDir,
    stdio: "inherit",
  });

  server.on("close", (code) => {
    console.log(`server.js process exited with code ${code}`);
  });

  server.on("error", (err) => {
    console.error("Error starting application:", err);
  });
}

updateApplication();
