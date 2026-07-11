const { spawn } = require("node:child_process");
const http = require("node:http");

const url = "http://127.0.0.1:5173/";
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function isViteRunning() {
  return new Promise((resolve) => {
    http
      .get(url, (response) => {
        response.resume();
        resolve(true);
      })
      .on("error", () => resolve(false));
  });
}

function waitForVite(retries = 80) {
  return new Promise((resolve, reject) => {
    const check = (remaining) => {
      http
        .get(url, (response) => {
          response.resume();
          resolve();
        })
        .on("error", () => {
          if (remaining === 0) {
            reject(new Error("Vite did not start on http://127.0.0.1:5173/"));
            return;
          }

          setTimeout(() => check(remaining - 1), 250);
        });
    };

    check(retries);
  });
}

let vite;

function launchElectron() {
  const electronCommand = require("electron");

  const electron = spawn(electronCommand, ["electron/main.cjs"], {
    cwd: process.cwd(),
    shell: false,
    stdio: "inherit",
    env: {
      ...process.env,
      CADENCE_DEV_SERVER_URL: url,
    },
  });

  electron.on("exit", (code) => {
    if (vite) {
      vite.kill();
    }

    process.exit(code ?? 0);
  });
}

isViteRunning()
  .then((running) => {
    if (!running) {
      vite = spawn(npmCommand, ["run", "dev"], {
        cwd: process.cwd(),
        shell: process.platform === "win32",
        stdio: "inherit",
      });

      vite.on("exit", (code) => {
        if (code && code !== 0) {
          process.exit(code);
        }
      });
    }

    return waitForVite();
  })
  .then(launchElectron)
  .catch((error) => {
    if (vite) {
      vite.kill();
    }

    console.error(error.message);
    process.exit(1);
  });
