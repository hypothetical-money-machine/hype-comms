import path from "node:path";

export function createPerformancePostgres(run, pgBin, pgDirectory) {
  let stopRequired = false;
  return {
    start(logFile, port) {
      // pg_ctl can time out while its postmaster continues starting in the background.
      stopRequired = true;
      run(path.join(pgBin, "pg_ctl"), [
        "-D",
        pgDirectory,
        "-l",
        logFile,
        "-o",
        `-h 127.0.0.1 -p ${port} -c unix_socket_directories=''`,
        "-w",
        "start",
      ]);
    },
    stop() {
      if (!stopRequired) return;
      run(path.join(pgBin, "pg_ctl"), ["-D", pgDirectory, "-m", "fast", "-w", "stop"]);
      stopRequired = false;
    },
  };
}
