import net from "node:net";

const host = "127.0.0.1";
const port = 5173;
const server = net.createServer();

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port, exclusive: true }, resolve);
  });
  await new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
} catch (error) {
  if (error instanceof Error && "code" in error && error.code === "EADDRINUSE") {
    process.stderr.write(
      `Renderer development port ${port} is already in use, likely by a stale desktop development process.\n`,
    );
    process.exitCode = 1;
  } else {
    throw error;
  }
}
