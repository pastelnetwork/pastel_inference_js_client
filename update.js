const { exec } = require("child_process");
const path = require("path");
const currentDir = __dirname;

// Configuration
const useDebugMode = process.env.USE_DEBUG_MODE === "1";
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
  exec(
    `git fetch origin ${branch}`,
    { cwd: currentDir },
    (err, stdout, stderr) => {
      if (err) {
        console.error("Error fetching updates:", stderr);
        return;
      }

      exec("git rev-parse HEAD", { cwd: currentDir }, (err, currentCommit) => {
        if (err) {
          console.error("Error getting current commit:", stderr);
          return;
        }

        exec(
          `git rev-parse origin/${branch}`,
          { cwd: currentDir },
          (err, latestCommit) => {
            if (err) {
              console.error("Error getting latest commit:", stderr);
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
                    return;
                  }

                  console.log("Installing dependencies...");
                  exec(
                    "npm install",
                    { cwd: currentDir },
                    (err, stdout, stderr) => {
                      if (err) {
                        console.error("Error installing dependencies:", stderr);
                        return;
                      }

                      console.log(
                        "Update applied successfully. Restarting application..."
                      );
                      process.exit(0); // Exit to let the process manager (e.g., PM2) restart the app
                    }
                  );
                }
              );
            } else {
              console.log("Application is up-to-date.");
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
  exec("node index.js", { cwd: currentDir }, (err, stdout, stderr) => {
    if (err) {
      console.error("Error starting application:", stderr);
      return;
    }
    console.log(stdout);
  });
}

updateApplication();
